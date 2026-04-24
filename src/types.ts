/**
 * Shared types across the illuminator CLI.
 *
 * Designed so a spec document (Markdown) can be parsed into AssetSpec[] and
 * handed through formatter → generator → post-processor as a stream. Each
 * stage enriches the record; nothing is mutated after it's set, so failures
 * stop at the stage they occur and partial progress is always inspectable.
 */

/**
 * A named aesthetic direction. One per project. Splices into every Claude
 * formatting call as the artistic/composition/wear rubric, so every generated
 * image reads as "part of the same book."
 */
export interface StyleAnchor {
  id: string;
  name: string;

  /** Medium, technique, and rendering style — the painterly backbone. */
  artistic: string;

  /** Framing, background, placement. How the subject sits on the page. */
  composition: string;

  /** Free-text notes about the medium — "no neon, no digital gloss, …" */
  medium_notes?: string;

  /**
   * Counter-bias for image models' cartoon default on animal characters.
   * Flux 2 defaults to cute/chibi proportions unless told otherwise.
   */
  species_bias_counter?: string;

  /** How "used" the world looks. Pristine vs weathered. */
  wear_and_weathering?: string;
}

/**
 * A color palette. Primary colors go to focal subjects, secondary colors to
 * atmosphere. Using the same palette across every image is the single biggest
 * contributor to visual cohesion in a batch.
 */
export interface Palette {
  id: string;
  name: string;

  /** Hex codes for focal subjects. Vivid, intense, push brightness. */
  primary: string[];

  /** Hex codes for atmosphere and less important elements. */
  secondary: string[];

  /** Free-text guidance on how to apply the palette. */
  notes?: string;
}

/**
 * A processing type — determines which post-processor runs on the raw PNG.
 * Each type implies a specific set of transforms in post/process.py.
 */
export type AssetType =
  | "sprite"      // cutout via rembg, crop to content, resize
  | "hex-tile"    // pointy-top hex mask with feathered edges
  | "icon"        // cutout, resize to multiple sizes (16/32/64/128)
  | "card-face"   // crop to 3:4, no background removal
  | "chrome"      // cutout, no resize
  | "background"  // resize only, no cutout
  | "passthrough"; // copy as-is

/**
 * A single asset in the spec document. Parsed from a `###` heading block.
 */
export interface AssetSpec {
  /** Slug form of the heading, used as the stable id. */
  id: string;
  /** Output path relative to the raw output directory. */
  file: string;
  /** Which section (##) this belongs to — used for filtering. */
  section: string;
  /** Determines post-processing behavior. */
  type: AssetType;
  /** BFL aspect ratio or `WxH` in pixels. */
  aspect: string;
  /** BFL render size. Defaults to 1024x1024. */
  size: string;
  /** Free-text visual description — the raw input to the formatter. */
  description: string;
}

/**
 * Top-level spec document settings. Parsed from a `settings` block at the
 * start of the markdown.
 */
export interface DocSettings {
  /** Which style anchor to use (e.g. "glacial-archive"). */
  preset: string;
  /** BFL model id. Defaults to flux-2-pro. */
  model: string;
  /** Fallback size for specs that don't set their own. */
  default_size: string;
  /** Fallback aspect for specs that don't set their own. */
  default_aspect: string;
}

export interface AssetDoc {
  settings: DocSettings;
  specs: AssetSpec[];
}

/**
 * The JSON prompt shape BFL Flux 2 expects. Claude synthesizes this from the
 * spec's raw description + style anchor + palette.
 *
 * The whole object is JSON-stringified and sent as the Flux `prompt` field —
 * scene and subjects are all the model receives.
 */
export interface FluxJsonPrompt {
  scene: string;
  subjects: FluxSubject[];
}

export interface FluxSubject {
  type: string;
  description: string;
  position: string;
  color_match?: "exact" | "similar";
  detail_preservation?: "high" | "medium" | "low";
}

/**
 * Per-image metadata saved alongside the PNG. Enables reproducibility:
 * the raw description, the Claude-formatted JSON, the BFL task id, and the
 * final sent prompt are all recorded.
 */
export interface GenerationRecord {
  spec_id: string;
  file: string;
  /** Asset type (determines which post-processor transform applies). */
  spec_type: AssetType;
  /** Section the spec came from (for filtering and reporting). */
  section: string;
  model: string;
  size: string;
  aspect: string;
  raw_description: string;
  formatted_prompt: FluxJsonPrompt;
  bfl_task_id: string;
  cost_usd: number;
  claude_cost_usd: number;
  duration_ms: number;
  generated_at: string; // ISO timestamp
}
