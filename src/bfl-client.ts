import type { FluxJsonPrompt } from "./types.js";
import {
  validateAspectRatio,
  validateModelId,
  validateRenderSize,
} from "./validation.js";

/**
 * BFL (Black Forest Labs) Flux 2 image generation client.
 *
 * Adapted from apps/illuminator/webui/src/lib/imageClient.bfl.ts in the
 * canonry repo. We call api.bfl.ai directly (Node — no CORS), so the relay
 * server is unnecessary.
 *
 * Async workflow: POST task → poll polling_url → fetch output image URL.
 *
 * API docs: https://docs.bfl.ai/quick_start/generating_images
 *
 * Key production lessons preserved from illuminator:
 *   - disable_pup: true — BFL runs an LLM rewrite on prompts by default which
 *     fights carefully structured prompts and washes out color.
 *   - safety_tolerance: 5 — default (2) triggers false positives on fantasy
 *     or slightly-grim content.
 *   - Width/height must be multiples of 16.
 *   - On transient poll failures, retry (task is running server-side).
 */

const BFL_API_BASE = "https://api.bfl.ai/v1";
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 300_000;           // 5 minutes
const SUBMIT_FETCH_TIMEOUT_MS = 30_000;
const POLL_FETCH_TIMEOUT_MS = 15_000;
const IMAGE_FETCH_TIMEOUT_MS = 60_000;
const MAX_CONSECUTIVE_POLL_ERRORS = 10;

/** Models that use aspect_ratio instead of explicit width/height. */
const BFL_ASPECT_RATIO_MODELS = new Set<string>([
  "flux-pro-1.1-ultra",
  "flux-pro-1.1-ultra-raw",
]);

/** Virtual variants that route to a specific endpoint with a flag. */
const BFL_RAW_MODELS: Record<string, boolean> = {
  "flux-pro-1.1-ultra-raw": true,
};

interface BflSubmitResponse {
  id: string;
  polling_url: string;
  cost?: number;
}

interface BflPollResponse {
  id: string;
  status: string;
  result?: { sample: string };
  error?: string;
}

export interface BflOptions {
  apiKey: string;
  model?: string;
}

export interface BflRequest {
  prompt: FluxJsonPrompt;
  size?: string;     // e.g. "1024x1024"
  aspect?: string;   // e.g. "1:1" — only used on ultra models
}

export interface BflResult {
  image: Buffer;
  task_id: string;
  cost_usd: number;
  duration_ms: number;
  model: string;
  size: string;
}

export class BflClient {
  private apiKey: string;
  private model: string;

  constructor(opts: BflOptions) {
    this.apiKey = opts.apiKey;
    this.model = validateModelId(opts.model ?? "flux-2-pro", "BFL model");
  }

  async generate(request: BflRequest): Promise<BflResult> {
    const started = Date.now();
    const endpoint = resolveEndpoint(this.model);
    const body = buildRequestBody(this.model, request);

    // --- Step 1: submit task ---
    const submitUrl = `${BFL_API_BASE}/${endpoint}`;
    const submitResp = await fetchWithTimeout(
      submitUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-key": this.apiKey,
        },
        body: JSON.stringify(body),
      },
      SUBMIT_FETCH_TIMEOUT_MS,
    );

    const submitText = await submitResp.text();
    if (!submitResp.ok) {
      throw new Error(
        `BFL submit ${submitResp.status}: ${extractErrorDetail(submitText)}`,
      );
    }

    const submitData = JSON.parse(submitText) as BflSubmitResponse;

    // --- Step 2: poll for completion ---
    const pollUrl = submitData.polling_url;
    let consecutiveErrors = 0;
    let finalResult: BflPollResponse | null = null;

    while (Date.now() - started < POLL_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);

      let pollResp: Response;
      try {
        pollResp = await fetchWithTimeout(
          pollUrl,
          { headers: { accept: "application/json", "x-key": this.apiKey } },
          POLL_FETCH_TIMEOUT_MS,
        );
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          throw new Error(
            `BFL polling failed after ${consecutiveErrors} consecutive errors: ${errorMessage(err)}`,
          );
        }
        continue;
      }

      if (!pollResp.ok) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          throw new Error(
            `BFL poll HTTP ${pollResp.status} after ${consecutiveErrors} retries`,
          );
        }
        continue;
      }

      consecutiveErrors = 0;
      const poll = (await pollResp.json()) as BflPollResponse;

      if (poll.status === "Ready") {
        finalResult = poll;
        break;
      }

      if (isTerminalFailure(poll.status)) {
        const detail = poll.error || `status: ${poll.status}`;
        throw new Error(`BFL task rejected (${poll.status}): ${detail}`);
      }
      // Pending | Processing → keep polling.
    }

    if (!finalResult) {
      throw new Error("BFL task timed out");
    }

    const imageUrl = finalResult.result?.sample;
    if (!imageUrl) {
      throw new Error("BFL returned no output image URL");
    }

    // --- Step 3: fetch the image ---
    const imageResp = await fetchWithTimeout(
      imageUrl,
      {},
      IMAGE_FETCH_TIMEOUT_MS,
    );
    if (!imageResp.ok) {
      throw new Error(`BFL image fetch ${imageResp.status}`);
    }
    const image = Buffer.from(await imageResp.arrayBuffer());

    return {
      image,
      task_id: submitData.id,
      cost_usd: submitData.cost ?? 0,
      duration_ms: Date.now() - started,
      model: this.model,
      size: request.size ?? "1024x1024",
    };
  }
}

function resolveEndpoint(model: string): string {
  // Raw variant shares the same endpoint as the non-raw ultra.
  if (model === "flux-pro-1.1-ultra-raw") return "flux-pro-1.1-ultra";
  return model;
}

function buildRequestBody(
  model: string,
  request: BflRequest,
): Record<string, unknown> {
  const size = validateRenderSize(request.size ?? "1024x1024", "render size");
  const prompt = JSON.stringify(request.prompt);

  const body: Record<string, unknown> = {
    prompt,
    disable_pup: true,        // do not re-rewrite a carefully structured prompt
    output_format: "png",
    safety_tolerance: 5,      // default 2 is overzealous on grim/fantasy content
  };

  if (BFL_ASPECT_RATIO_MODELS.has(model)) {
    body.aspect_ratio = validateAspectRatio(
      request.aspect ?? sizeToAspectRatio(size),
      "render aspect",
    );
  } else {
    const { width, height } = parseDimensions(size);
    body.width = width;
    body.height = height;
  }

  if (model in BFL_RAW_MODELS) {
    body.raw = BFL_RAW_MODELS[model];
  }

  return body;
}

function parseDimensions(size: string): { width: number; height: number } {
  const [wStr, hStr] = validateRenderSize(size, "render size")
    .toLowerCase()
    .split("x");
  const w = Number.parseInt(wStr, 10);
  const h = Number.parseInt(hStr, 10);
  return {
    width: w,
    height: h,
  };
}

function sizeToAspectRatio(size: string): string {
  const { width, height } = parseDimensions(size);
  if (width === height) return "1:1";
  if (width > height) return "16:9";
  return "9:16";
}

function isTerminalFailure(status: string): boolean {
  const s = status.toLowerCase();
  return (
    s === "error" ||
    s === "failed" ||
    s.includes("moderat") ||
    s.includes("rejected") ||
    s.includes("not found") ||
    s.includes("cancelled")
  );
}

function extractErrorDetail(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return parsed.detail || parsed.error || parsed.message || raw;
  } catch {
    return raw;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
