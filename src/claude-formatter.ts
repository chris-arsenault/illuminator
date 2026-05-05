import Anthropic from "@anthropic-ai/sdk";
import type {
  FormattedImagePrompt,
  FluxJsonPrompt,
  Identity,
  Palette,
  StyleAnchor,
} from "./types.js";
import { buildPaletteContext } from "./palette.js";
import {
  getFluxGeneration,
  getImageProvider,
  getOpenAiModelFamily,
} from "./validation.js";

/**
 * Claude prompt formatter — converts a raw visual description into the prompt
 * shape expected by the selected image model family.
 *
 * Flux 2 uses BFL's JSON prompt format. Flux 1.1 Ultra does not support that
 * format, so it gets a concise natural-language prompt. OpenAI GPT Image and
 * DALL-E models use the prompt templates from the Canonry Illuminator
 * reference.
 *
 * Lessons baked in (carried over from illuminator):
 *  - Flux 2 degrades with long prompts → ~20 words per subject
 *  - Image models desaturate → push brightness in language
 *  - Strong cartoon bias for animals → explicit adult descriptors required
 *  - Positive descriptions only — never "avoid", "no", "without"
 *  - Use vivid color names in the scene, NOT hex codes
 */

const MODEL = "claude-sonnet-4-6";

export interface FormatterOptions {
  apiKey: string;
  style: StyleAnchor;
  palette: Palette;
  imageModel: string;
  /** Model override (default: claude-sonnet-4-6). */
  model?: string;
}

export interface FormatResult {
  prompt: FormattedImagePrompt;
  input_tokens: number;
  output_tokens: number;
  /**
   * Cached input tokens (reused from previous calls — billed at 10% of
   * normal input rate). Non-zero after the first call.
   */
  cached_input_tokens: number;
  /**
   * USD cost of this single Claude call. Combined cache-read + cache-write
   * + output token pricing. Rough — good enough for batch cost tracking.
   */
  cost_usd: number;
}

/**
 * Sonnet 4.6 pricing (per million tokens), roughly:
 *   input:       $3.00
 *   cache read:  $0.30   (90% discount)
 *   cache write: $3.75   (25% premium, but only on first call)
 *   output:      $15.00
 */
const COST_INPUT_PER_TOKEN = 3.0 / 1_000_000;
const COST_CACHE_READ_PER_TOKEN = 0.3 / 1_000_000;
const COST_CACHE_WRITE_PER_TOKEN = 3.75 / 1_000_000;
const COST_OUTPUT_PER_TOKEN = 15.0 / 1_000_000;

export class ClaudeFormatter {
  private client: Anthropic;
  private systemPrompt: string;
  private model: string;
  private promptFormat:
    | "flux-1-text"
    | "flux-2-json"
    | "gpt-image-text"
    | "dalle-text";

  constructor(opts: FormatterOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    const imageProvider = getImageProvider(opts.imageModel);
    if (imageProvider === "bfl") {
      const fluxGeneration = getFluxGeneration(opts.imageModel);
      this.promptFormat =
        fluxGeneration === "flux-2" ? "flux-2-json" : "flux-1-text";
      this.systemPrompt =
        this.promptFormat === "flux-2-json"
          ? buildFlux2SystemPrompt(opts.style, opts.palette)
          : buildFlux1SystemPrompt(opts.style, opts.palette, opts.imageModel);
    } else {
      const family = getOpenAiModelFamily(opts.imageModel);
      this.promptFormat =
        family === "gpt-image" ? "gpt-image-text" : "dalle-text";
      this.systemPrompt =
        family === "gpt-image"
          ? buildGptImageSystemPrompt(opts.style, opts.palette, opts.imageModel)
          : buildDalleSystemPrompt(opts.style, opts.palette, opts.imageModel);
    }
    this.model = opts.model ?? MODEL;
  }

  async format(
    description: string,
    opts: {
      assetTypeHint?: string;
      aspectHint?: string;
      fileHint?: string;
      promptFragment?: string;
      /**
       * Canonical identity for this asset (cultural/factional grounding).
       * Varies per asset, so spliced into the user message — NOT the cached
       * system prompt. Adds ~100-200 tokens of user input per call.
       */
      identity?: Identity;
    } = {},
  ): Promise<FormatResult> {
    const userMessage = buildUserMessage(description, opts);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: this.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userMessage }],
    });

    const firstBlock = response.content[0];
    if (!firstBlock || firstBlock.type !== "text") {
      throw new Error("Claude returned no text content");
    }

    const prompt =
      this.promptFormat === "flux-2-json"
        ? parseFluxJson(firstBlock.text)
        : parsePlainTextPrompt(firstBlock.text, this.promptFormat);

    const usage = response.usage;
    const rawInput = usage.input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;

    const cost =
      rawInput * COST_INPUT_PER_TOKEN +
      cacheRead * COST_CACHE_READ_PER_TOKEN +
      cacheWrite * COST_CACHE_WRITE_PER_TOKEN +
      output * COST_OUTPUT_PER_TOKEN;

    return {
      prompt,
      input_tokens: rawInput,
      output_tokens: output,
      cached_input_tokens: cacheRead,
      cost_usd: cost,
    };
  }
}

function buildUserMessage(
  description: string,
  opts: {
    assetTypeHint?: string;
    aspectHint?: string;
    fileHint?: string;
    promptFragment?: string;
    identity?: Identity;
  },
): string {
  const parts: string[] = [];
  if (opts.fileHint) parts.push(`Output filename: ${opts.fileHint}`);
  if (opts.assetTypeHint) parts.push(`Asset type: ${opts.assetTypeHint}`);
  if (opts.aspectHint) parts.push(`Aspect ratio: ${opts.aspectHint}`);
  // Identity lands BEFORE the asset prompt so Claude reads the cultural
  // grounding first, then interprets the asset description through that lens.
  if (opts.identity) {
    parts.push("");
    parts.push(`Subject identity — ${opts.identity.name}:`);
    parts.push(opts.identity.description.trim());
    parts.push(
      "Every render of a subject with this identity must use this canonical vocabulary. Do not substitute generic equivalents.",
    );
  }
  if (opts.promptFragment) {
    parts.push("");
    parts.push("Asset-specific guidance:");
    parts.push(opts.promptFragment.trim());
  }
  parts.push("");
  parts.push("Visual description:");
  parts.push(description.trim());
  return parts.join("\n");
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

function parsePlainTextPrompt(text: string, promptFormat: string): string {
  const stripped = stripMarkdownFence(text);
  if (!stripped) {
    throw new Error(`Claude returned an empty ${promptFormat} prompt`);
  }
  return stripped;
}

function parseFluxJson(text: string): FluxJsonPrompt {
  const trimmed = text.trim();
  // Claude occasionally wraps JSON in fences despite the template instruction.
  const stripped = stripMarkdownFence(trimmed);

  try {
    const parsed = JSON.parse(stripped);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.scene !== "string" ||
      !Array.isArray(parsed.subjects)
    ) {
      throw new Error("Expected { scene: string, subjects: [] }");
    }
    return parsed as FluxJsonPrompt;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to parse Claude output as Flux 2 JSON: ${msg}\n\nRaw output:\n${trimmed}`,
    );
  }
}

/**
 * Build the full system prompt. Cached on Claude's side — the first call pays
 * the cache-write cost, every subsequent call in the same batch reads from
 * cache at 10% of normal input token cost.
 */
function buildFlux2SystemPrompt(style: StyleAnchor, palette: Palette): string {
  const paletteContext = buildPaletteContext(palette);

  return `
You convert visual descriptions into BFL Flux 2 JSON prompts. Your output IS the complete prompt — scene and subjects are all the image model receives. Style, color, and medium must be embedded in your output.

Output raw JSON only. No fences. No explanation. No preamble. Exactly this shape:

{"scene":"...","subjects":[{"type":"...","description":"...","position":"...","color_match":"exact","detail_preservation":"high"}]}

========================================
STYLE ANCHOR — apply to EVERY image
========================================

Style name: ${style.name}

Artistic direction:
${style.artistic}

Composition:
${style.composition}

${style.medium_notes ? `Medium notes:\n${style.medium_notes}\n` : ""}
${style.species_bias_counter ? `Species rendering (CRITICAL — image models default to cartoon proportions):\n${style.species_bias_counter}\n` : ""}
${style.wear_and_weathering ? `Wear and weathering:\n${style.wear_and_weathering}\n` : ""}

Every JSON prompt you produce must read as being from the same book — one continuous aesthetic across the entire batch.

========================================
PALETTE
========================================

${paletteContext}

========================================
HOW TO THINK ABOUT THE SCENE
========================================

The scene is ONE sentence a cinematographer would use to frame the shot. It must contain, in order:
  1. The rendering medium and technique (from the style anchor)
  2. Who/what is in the shot, described by species and attire where applicable
  3. Where they are (the environment or the surface they sit on)
  4. How color punctuates the image (vivid color names — never hex codes in scene text)

The scene sets artistic tone. Compress it. ~30-40 words max.

========================================
HOW TO THINK ABOUT SUBJECTS
========================================

2-3 subjects per image. Merge minor elements into the scene rather than adding subjects for them.

Each subject is a camera direction for one element in the frame. If you could tell an artist only 20 words about this subject, what are the 2-3 details that make it visually unique?

For LIVING beings, the visual signal order is:
  1. Species + role (e.g. "emperor penguin standing upright")
  2. Attire / equipment / covering (a character without clothing is a generic silhouette)
  3. One distinctive visual detail (plumage, posture, wear)
  4. End with a color anchor: "strictly in color #HEX <vivid color name>"

For NON-LIVING elements (objects, effects, environments), lead with the most distinctive visual quality — shape, texture, behavior.

Subject types should be concrete: species + role for living beings, noun phrase for objects. Keep them short.

~20 words per subject description before the color tag. Every word must earn its place.

========================================
HOW TO THINK ABOUT COLOR
========================================

Each subject must pull a DIFFERENT color from the palette so they're visually distinct from each other. Use PRIMARY palette colors for focal subjects, SECONDARY palette colors for atmosphere.

In the scene text, use vivid names ("warm vellum cream", "slate ink shadow", "ember glow"). Never hex codes. In subject color anchors, use hex + a vivid descriptor together: "strictly in color #D97742 ember orange".

Image models desaturate — push brightness in language.

========================================
HARD RULES
========================================

- NEVER use negations: never "avoid", "no", "not", "without", "don't". Describe only what IS present.
- NEVER use hex codes in the scene text — only in subject color anchors.
- NEVER include real artist names or "in the style of <name>". Describe the technique directly.
- NEVER include backstory, lore, character names, world-building. Only concrete visual information.
- NEVER include "isolated on a transparent background" or "white background" — use the style anchor's composition direction instead.
- Keep total JSON under ~150 words. Shorter is better.
`.trim();
}

function buildFlux1SystemPrompt(
  style: StyleAnchor,
  palette: Palette,
  imageModel: string,
): string {
  const paletteContext = buildPaletteContext(palette);

  return `
You convert visual descriptions into concise natural-language prompts for ${imageModel}.

This is the Flux 1.1 Ultra prompt path. Flux 1.1 Ultra accepts a plain text prompt string, not BFL Flux 2 JSON. Output one polished image prompt paragraph only. No JSON. No headings. No markdown. No preamble.

Use the Flux 1 image prompt template as the base:

Style → Subject → Action/Context → Technical details

Flux 1.1 Ultra is sensitive to long, dense prompts. Deduplicate aggressively and keep the final prompt around 80-140 words. Front-load the most important visual signal because Flux weights earlier text strongly.

========================================
STYLE ANCHOR — apply to EVERY image
========================================

Style name: ${style.name}

Artistic direction:
${style.artistic}

Composition:
${style.composition}

${style.medium_notes ? `Medium notes:\n${style.medium_notes}\n` : ""}
${style.species_bias_counter ? `Species rendering (CRITICAL — image models default to cartoon proportions):\n${style.species_bias_counter}\n` : ""}
${style.wear_and_weathering ? `Wear and weathering:\n${style.wear_and_weathering}\n` : ""}

Every prompt you produce must read as being from the same book — one continuous aesthetic across the entire batch.

========================================
PALETTE
========================================

${paletteContext}

Use vivid color names in prose. You may mention key hex codes only when they are directly attached to a specific object or subject. Do not make a list of swatches.

========================================
RULES
========================================

- Start with medium/style and composition.
- Then name the subject with species, role, attire/equipment, and one distinctive visual detail.
- Then add action/context and setting.
- End with lighting, camera, atmosphere, or material detail.
- Strip lore, proper names, backstory, abstract concepts, and repeated adjectives.
- Use positive descriptions only. Never write "avoid", "no", "not", "without", or "don't".
- For animal characters, specify adult anatomical proportions explicitly.
- Nothing is clean or new unless the input explicitly says so; use concrete wear and weathering.
- Keep output as a single flowing paragraph.
`.trim();
}

function buildGptImageSystemPrompt(
  style: StyleAnchor,
  palette: Palette,
  imageModel: string,
): string {
  const paletteContext = buildPaletteContext(palette);

  return `
You convert visual descriptions into image generation prompts for ${imageModel}. Use Canonry's GPT Image labeled-prompt pattern, adapted to this pack format. Output the finished image prompt only. No markdown fences. No explanation. No preamble.

Output format:
STYLE: [medium, rendering approach, and composition]
SUBJECT: [the concrete asset subject and its supplied visual traits]
CONTEXT: [setting, action, surface, or use case when supplied]
COLOR: [palette colors attached to concrete parts of the image]
DETAILS: [materials, lighting, camera, wear, or production details only when supplied]
CONSTRAINTS: [type/style constraints only when supplied]

========================================
STYLE ANCHOR - apply to EVERY image
========================================

Style name: ${style.name}

Artistic direction:
${style.artistic}

Composition:
${style.composition}

${style.medium_notes ? `Medium notes:\n${style.medium_notes}\n` : ""}
${style.species_bias_counter ? `Species rendering (CRITICAL - image models default to cartoon proportions):\n${style.species_bias_counter}\n` : ""}
${style.wear_and_weathering ? `Wear and weathering:\n${style.wear_and_weathering}\n` : ""}

Every prompt you produce must read as being from the same book - one continuous aesthetic across the entire batch.

========================================
PALETTE
========================================

${paletteContext}

How to think about STYLE:
Use the style anchor as the source of truth. Name the medium and technique. Do not import outside genres, tone, or world assumptions.

How to think about SUBJECT:
Describe the subject that the asset prompt actually gives you. Preserve concrete supplied traits. Do not add species, attire, anatomy, tools, faction markers, symbols, or materials unless they appear in the asset prompt, identity, type guidance, or style anchor.

How to think about CONTEXT:
Use only supplied setting, action, surface, role, or UI/game use case. If the prompt is an isolated object, icon, sprite, tile, card, chrome element, or background, respect that production target.

How to think about COLOR:
Attach palette colors to concrete surfaces or visual accents. Hex codes are useful for GPT Image, but only use them when tied to an object, area, or effect. Do not dump a swatch list.

How to think about DETAILS:
Add material, lighting, camera, wear, weathering, anatomy, or rendering constraints only when they are present in the style anchor, asset prompt, identity, or type guidance. Do not pad the prompt with invented production detail.

Rules:
- Strip backstory and abstract concepts. Keep concrete visual information that affects pixels.
- Positive descriptions only. Never write "avoid", "no", "not", "without", or "don't".
- Never write "8K", "ultra-detailed", "hyperdetailed", or "masterpiece"; use concrete visual detail instead.
- Do not invent world tone. If the pack says quiet, clean, playful, grim, technical, painterly, worn, pristine, or anything else, follow that. If it does not, stay neutral.
- Keep it dense but proportional: about 120-220 words, shorter when the asset prompt is simple.
`.trim();
}

function buildDalleSystemPrompt(
  style: StyleAnchor,
  palette: Palette,
  imageModel: string,
): string {
  const paletteContext = buildPaletteContext(palette);

  return `
You convert visual descriptions into concise image generation prompts for ${imageModel}. Use Canonry's DALL-E short, front-loaded prompt pattern, adapted to this pack format. Output a single flowing paragraph only. No labels. No bullet points. No markdown. No preamble.

Structure:
Most important visual element first -> supporting details -> technical.

========================================
STYLE ANCHOR - apply to EVERY image
========================================

Style name: ${style.name}

Artistic direction:
${style.artistic}

Composition:
${style.composition}

${style.medium_notes ? `Medium notes:\n${style.medium_notes}\n` : ""}
${style.species_bias_counter ? `Species rendering (CRITICAL - image models default to cartoon proportions):\n${style.species_bias_counter}\n` : ""}
${style.wear_and_weathering ? `Wear and weathering:\n${style.wear_and_weathering}\n` : ""}

========================================
PALETTE
========================================

${paletteContext}

Rules for DALL-E style prompts:
- Never include artist names or "in the style of"; describe the medium and technique instead.
- Never use negations: "no", "not", "avoid", "without", "don't". Describe only what is present.
- Use vivid color names. Use hex codes only when attached to a concrete object, surface, or effect.
- Front-load the medium/style, then the actual asset subject, then the supplied context or production target.
- Keep total output under 120 words. Shorter prompts produce better results on this model family.
- Strip backstory and abstract concepts. Keep concrete visual information that affects pixels.
- Do not invent species, attire, anatomy, materials, camera/lens data, weathering, setting, or world tone. Include those only when supplied by the style anchor, palette, identity, type guidance, or asset prompt.
`.trim();
}
