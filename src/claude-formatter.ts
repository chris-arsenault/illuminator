import Anthropic from "@anthropic-ai/sdk";
import type {
  FluxJsonPrompt,
  Palette,
  StyleAnchor,
} from "./types.js";
import { buildPaletteContext } from "./palette.js";

/**
 * Claude prompt formatter — converts a raw visual description into the
 * BFL Flux 2 JSON prompt format.
 *
 * The template is adapted from illuminator's FLUX_2_SUBJECT_SYNTHESIS_TEMPLATE,
 * with the resolved style anchor and palette spliced in for each formatter
 * instance. The full template is the cached system prompt — we only pay for
 * output tokens per image after the first call for a given style/palette pair.
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
  /** Model override (default: claude-sonnet-4-6). */
  model?: string;
}

export interface FormatResult {
  prompt: FluxJsonPrompt;
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

  constructor(opts: FormatterOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.systemPrompt = buildSystemPrompt(opts.style, opts.palette);
    this.model = opts.model ?? MODEL;
  }

  async format(
    description: string,
    opts: {
      assetTypeHint?: string;
      aspectHint?: string;
      fileHint?: string;
      promptFragment?: string;
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

    const prompt = parseFluxJson(firstBlock.text);

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
  },
): string {
  const parts: string[] = [];
  if (opts.fileHint) parts.push(`Output filename: ${opts.fileHint}`);
  if (opts.assetTypeHint) parts.push(`Asset type: ${opts.assetTypeHint}`);
  if (opts.aspectHint) parts.push(`Aspect ratio: ${opts.aspectHint}`);
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

function parseFluxJson(text: string): FluxJsonPrompt {
  const trimmed = text.trim();
  // Claude occasionally wraps JSON in fences despite the template instruction.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

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
function buildSystemPrompt(style: StyleAnchor, palette: Palette): string {
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
