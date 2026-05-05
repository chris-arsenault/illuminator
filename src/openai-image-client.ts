import type { FormattedImagePrompt } from "./types.js";
import {
  getImageProvider,
  validateModelId,
  validateRenderSize,
} from "./validation.js";

/**
 * OpenAI image generation client.
 *
 * Ported from the Canonry Illuminator browser client
 * (`apps/illuminator/webui/src/lib/imageClient.browser.ts`) and adapted for
 * Node buffers. This intentionally uses fetch directly, matching the reference
 * implementation instead of introducing a second SDK abstraction.
 */

const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";
const OPENAI_FETCH_TIMEOUT_MS = 300_000;

const OPENAI_SIZES_BY_MODEL: Record<string, readonly string[]> = {
  "gpt-image-1.5": ["auto", "1024x1024", "1536x1024", "1024x1536"],
  "gpt-image-1": ["auto", "1024x1024", "1536x1024", "1024x1536"],
  "dall-e-3": ["1024x1024", "1792x1024", "1024x1792"],
  "dall-e-2": ["1024x1024", "512x512", "256x256"],
};

export interface OpenAiImageOptions {
  apiKey: string;
  model?: string;
  quality?: string;
}

export interface OpenAiImageRequest {
  prompt: FormattedImagePrompt;
  size?: string;
}

export interface OpenAiImageResult {
  image: Buffer;
  task_id: string;
  cost_usd: number;
  duration_ms: number;
  model: string;
  size: string;
}

interface OpenAiImageResponse {
  data?: Array<{
    b64_json?: string;
    revised_prompt?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export class OpenAiImageClient {
  private apiKey: string;
  private model: string;
  private quality: string;

  constructor(opts: OpenAiImageOptions) {
    this.apiKey = opts.apiKey;
    this.model = validateModelId(
      opts.model ?? "gpt-image-1.5",
      "OpenAI image model",
    );
    if (getImageProvider(this.model) !== "openai") {
      throw new Error(`OpenAI image model must be an OpenAI model: ${this.model}`);
    }
    this.quality = opts.quality ?? "standard";
  }

  async generate(request: OpenAiImageRequest): Promise<OpenAiImageResult> {
    const started = Date.now();
    const body = buildOpenAiImageRequestBody(this.model, {
      ...request,
      quality: this.quality,
    });
    const response = await fetchWithTimeout(
      OPENAI_IMAGES_URL,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      OPENAI_FETCH_TIMEOUT_MS,
    );

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        `OpenAI image generation ${response.status}: ${extractErrorDetail(responseText)}`,
      );
    }

    const data = JSON.parse(responseText) as OpenAiImageResponse;
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error("OpenAI returned no base64 image data");
    }

    return {
      image: Buffer.from(b64, "base64"),
      task_id: extractRequestId(response.headers) ?? "(openai-sync)",
      cost_usd: calculateOpenAiImageCost(this.model, body, data.usage),
      duration_ms: Date.now() - started,
      model: this.model,
      size: String(body.size ?? "auto"),
    };
  }
}

export function buildOpenAiImageRequestBody(
  model: string,
  request: OpenAiImageRequest & { quality?: string },
): Record<string, unknown> {
  if (typeof request.prompt !== "string") {
    throw new Error("OpenAI image models require a plain text prompt.");
  }

  const isGptImage = model.startsWith("gpt-image");
  const body: Record<string, unknown> = {
    model,
    prompt: request.prompt,
    n: 1,
  };

  const size = resolveSize(model, request.size, isGptImage);
  if (size) body.size = size;

  const quality = resolveQuality(request.quality ?? "standard", model);
  if (quality) body.quality = quality;

  if (!isGptImage) body.response_format = "b64_json";

  return body;
}

function resolveSize(
  model: string,
  requestSize: string | undefined,
  isGptImage: boolean,
): string | undefined {
  const size = requestSize ?? "1024x1024";
  if (isGptImage && size === "auto") return "auto";
  const normalized = validateRenderSize(size, "OpenAI image size");
  const allowed = OPENAI_SIZES_BY_MODEL[model] ?? [];
  if (!allowed.includes(normalized)) {
    throw new Error(
      `OpenAI image size for ${model} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return normalized;
}

function resolveQuality(quality: string, model: string): string | undefined {
  if (model.startsWith("gpt-image")) {
    if (quality === "standard") return "medium";
    return quality;
  }
  if (model === "dall-e-3") {
    if (quality === "high") return "hd";
    if (quality === "low" || quality === "medium" || quality === "auto") {
      return "standard";
    }
    return quality;
  }
  if (model === "dall-e-2") return "standard";
  return undefined;
}

function calculateOpenAiImageCost(
  model: string,
  body: Record<string, unknown>,
  usage: OpenAiImageResponse["usage"],
): number {
  if (model.startsWith("gpt-image")) {
    const inputTokens = usage?.input_tokens ?? 300;
    const outputTokens =
      usage?.output_tokens ?? estimateGptImageOutputTokens(String(body.quality ?? "medium"));
    return inputTokens * (5 / 1_000_000) + outputTokens * (40 / 1_000_000);
  }

  const size = String(body.size ?? "1024x1024");
  const quality = String(body.quality ?? "standard");
  if (model === "dall-e-3") {
    if (quality === "hd") {
      return size === "1024x1024" ? 0.08 : 0.12;
    }
    return size === "1024x1024" ? 0.04 : 0.08;
  }
  if (model === "dall-e-2") {
    if (size === "256x256") return 0.016;
    if (size === "512x512") return 0.018;
    return 0.02;
  }
  return 0;
}

function estimateGptImageOutputTokens(quality: string): number {
  if (quality === "high") return 8000;
  if (quality === "low") return 4000;
  return 6500;
}

function extractRequestId(headers: Headers): string | undefined {
  return (
    headers.get("openai-request-id") ??
    headers.get("x-request-id") ??
    headers.get("request-id") ??
    undefined
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`OpenAI image request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function extractErrorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? text;
  } catch {
    return text;
  }
}
