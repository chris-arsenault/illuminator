/**
 * Shared types across the illuminator CLI.
 *
 * Designed so a pack definition can be parsed into AssetSpec[] and
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
 * A visual identity — a canonical description of a subject's cultural /
 * factional / species grounding. Selected per asset, spliced into the Claude
 * user message on generation.
 *
 * Identities exist so the vocabulary of a world (e.g. "Aurora Stack penguins
 * wear pale ice-plate; Nightshelf penguins wear charcoal wraps with
 * ember-thread") can live in ONE place and be referenced by many assets
 * instead of copy-pasted into every prompt (where it drifts).
 *
 * Word-budget discipline: keep `description` under ~150 words. Identity is
 * spliced alongside the asset's own prompt, the type fragment, and hints —
 * verbosity pushes Claude toward truncating useful detail elsewhere.
 */
export interface Identity {
  id: string;
  name: string;
  /** Canonical description spliced into Claude's user message per asset. */
  description: string;
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
  | "mask"        // grayscale, center square, range-normalized; no colour pipeline
  | "passthrough"; // copy as-is

/**
 * A single asset in the pack definition.
 */
export interface AssetSpec {
  /** Stable asset id from the TOML manifest. */
  id: string;
  /** Output path relative to the raw output directory. */
  file: string;
  /** Stable section id from the TOML manifest. */
  section_id: string;
  /** Human-facing section title used for filtering and reporting. */
  section: string;
  /** Resolved style id for this asset. */
  style_id: string;
  /** Resolved palette id for this asset. */
  palette_id: string;
  /**
   * Resolved identity id for this asset, or null if none applies.
   * Resolution order: asset.identity > section.identity > pack.default_identity > null.
   */
  identity_id: string | null;
  /** Determines post-processing behavior. */
  type: AssetType;
  /** Optional extra guidance injected for this asset type. */
  prompt_fragment?: string;
  /** Aspect ratio hint or `WxH` in pixels. */
  aspect: string;
  /** Render size. Defaults to 1024x1024. */
  size: string;
  /** Free-text visual description — the raw input to the formatter. */
  description: string;
}

/**
 * Top-level pack settings.
 */
export interface DocSettings {
  /** Optional human-facing pack title. */
  title?: string;
  /** Which style anchor to use (e.g. "glacial-archive"). */
  preset: string;
  /** Image model id. Defaults to flux-2-pro. */
  model: string;
  /** Default named style id for assets in this pack. */
  default_style: string;
  /** Default named palette id for assets in this pack. */
  default_palette: string;
  /**
   * Default named identity id for assets in this pack. Assets without their
   * own identity (and sections without one) inherit this. Use null for packs
   * whose subjects don't have a cultural grounding (e.g. UI chrome packs).
   */
  default_identity: string | null;
  /** Fallback size for specs that don't set their own. */
  default_size: string;
  /** Fallback aspect for specs that don't set their own. */
  default_aspect: string;
}

export interface AssetDoc {
  /** Absolute path to the directory containing pack.toml. Used to derive the
   * default output location (`<packDir>/output`) when --out is not given. */
  packDir: string;
  settings: DocSettings;
  styles: Record<string, StyleAnchor>;
  palettes: Record<string, Palette>;
  identities: Record<string, Identity>;
  specs: AssetSpec[];
}

/**
 * The JSON prompt shape BFL Flux 2 expects. Claude synthesizes this from the
 * asset's raw description + style anchor + palette.
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

export type FormattedImagePrompt = string | FluxJsonPrompt;

/**
 * Per-image metadata saved alongside the PNG. Enables reproducibility:
 * the raw description, the Claude-formatted prompt, the BFL task id, and the
 * final sent prompt are all recorded.
 */
export interface GenerationRecord {
  /** Optional human-facing pack title. */
  pack_title?: string;
  /** Base preset id used for this generation. */
  preset: string;
  spec_id: string;
  file: string;
  /** Asset type (determines which post-processor transform applies). */
  spec_type: AssetType;
  /** Stable section id from the pack definition. */
  section_id: string;
  /** Section the asset came from (for filtering and reporting). */
  section: string;
  /** Resolved style id for this generation. */
  style_id: string;
  /** Resolved palette id for this generation. */
  palette_id: string;
  /** Resolved identity id, or null if none applies. */
  identity_id: string | null;
  model: string;
  size: string;
  aspect: string;
  prompt_fragment?: string;
  raw_description: string;
  formatted_prompt: FormattedImagePrompt;
  bfl_task_id: string;
  cost_usd: number;
  claude_cost_usd: number;
  duration_ms: number;
  generated_at: string; // ISO timestamp
}
