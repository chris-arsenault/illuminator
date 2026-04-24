import type { AssetDoc, AssetSpec, AssetType, DocSettings } from "./types.js";
import {
  validateAspectRatio,
  validateAssetOutputPath,
  validateModelId,
  validateRenderSize,
} from "./validation.js";

/**
 * Parse an illuminator spec document.
 *
 * Format (see examples/canonry-game.md for a complete example):
 *
 *   # Title (ignored)
 *
 *   <!-- settings -->
 *   preset: glacial-archive
 *   model: flux-2-pro
 *   default_size: 1024x1024
 *   default_aspect: 1:1
 *   <!-- /settings -->
 *
 *   ## 1 · Entity sprites
 *
 *   ### penguin
 *   file: sprites/penguin.png
 *   type: sprite
 *   aspect: 1:1
 *
 *   A single adult emperor penguin standing upright, slight 3/4
 *   overhead angle, dove-grey back, cream belly with faint amber.
 *
 *   ### settlement
 *   file: sprites/settlement.png
 *   type: sprite
 *
 *   A small snow-bound settlement...
 *
 * Rules:
 *   - `##` opens a section; section name becomes the `section` field.
 *   - `###` opens an asset. The heading text becomes the asset id (slugified).
 *   - Immediately after a `###`, plain `key: value` lines describe the asset
 *     until the first blank line. Supported keys: file, type, aspect, size.
 *   - Everything until the next heading is the description (whitespace stripped).
 *   - Settings block is delimited by HTML comments `<!-- settings -->` and
 *     `<!-- /settings -->`. Inside, `key: value` per line.
 */

const SETTINGS_OPEN = /<!--\s*settings\s*-->/i;
const SETTINGS_CLOSE = /<!--\s*\/settings\s*-->/i;
const KEY_VALUE_LINE = /^([a-z_][a-z0-9_]*)\s*:\s*(.+?)\s*$/i;

const VALID_TYPES: ReadonlySet<AssetType> = new Set([
  "sprite",
  "hex-tile",
  "icon",
  "card-face",
  "chrome",
  "background",
  "passthrough",
]);

export function parseSpec(source: string): AssetDoc {
  const lines = source.split(/\r?\n/);
  const settings = parseSettings(lines);
  const specs = parseAssets(lines, settings);
  return { settings, specs };
}

function parseSettings(lines: string[]): DocSettings {
  const startIdx = lines.findIndex((l) => SETTINGS_OPEN.test(l));
  if (startIdx < 0) {
    throw new Error(
      "Spec document missing `<!-- settings -->` block at the top.",
    );
  }
  const endIdx = lines.findIndex(
    (l, i) => i > startIdx && SETTINGS_CLOSE.test(l),
  );
  if (endIdx < 0) {
    throw new Error(
      "Spec settings block missing closing `<!-- /settings -->`.",
    );
  }

  const kv: Record<string, string> = {};
  for (let i = startIdx + 1; i < endIdx; i++) {
    const m = KEY_VALUE_LINE.exec(lines[i].trim());
    if (m) kv[m[1].toLowerCase()] = m[2];
  }

  const preset = required(kv, "preset");
  const model = validateModelId(kv["model"] ?? "flux-2-pro", "settings.model");
  const defaultSize = validateRenderSize(
    kv["default_size"] ?? "1024x1024",
    "settings.default_size",
  );
  const defaultAspect = validateAspectRatio(
    kv["default_aspect"] ?? "1:1",
    "settings.default_aspect",
  );

  return {
    preset,
    model,
    default_size: defaultSize,
    default_aspect: defaultAspect,
  };
}

function parseAssets(lines: string[], settings: DocSettings): AssetSpec[] {
  const specs: AssetSpec[] = [];
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  let currentSection = "";
  let i = 0;

  // Skip settings block entirely when walking headings.
  const settingsStart = lines.findIndex((l) => SETTINGS_OPEN.test(l));
  const settingsEnd = lines.findIndex(
    (l, idx) => idx > settingsStart && SETTINGS_CLOSE.test(l),
  );

  while (i < lines.length) {
    if (i >= settingsStart && i <= settingsEnd) {
      i++;
      continue;
    }

    const line = lines[i];

    const sectionMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      i++;
      continue;
    }

    const assetMatch = /^###\s+(.+?)\s*$/.exec(line);
    if (assetMatch) {
      const heading = assetMatch[1].trim();
      if (!currentSection) {
        throw new Error(
          `Asset "${heading}" must appear under a ## section heading.`,
        );
      }
      const { spec, nextIndex } = parseSingleAsset({
        lines,
        startIndex: i + 1,
        heading,
        section: currentSection,
        settings,
      });
      if (seenIds.has(spec.id)) {
        throw new Error(`Duplicate asset id "${spec.id}" from heading "${heading}".`);
      }
      if (seenFiles.has(spec.file)) {
        throw new Error(`Duplicate asset output path "${spec.file}".`);
      }
      seenIds.add(spec.id);
      seenFiles.add(spec.file);
      specs.push(spec);
      i = nextIndex;
      continue;
    }

    i++;
  }

  return specs;
}

interface ParseAssetArgs {
  lines: string[];
  startIndex: number;
  heading: string;
  section: string;
  settings: DocSettings;
}

function parseSingleAsset(args: ParseAssetArgs): {
  spec: AssetSpec;
  nextIndex: number;
} {
  const { lines, startIndex, heading, section, settings } = args;

  // Read key:value lines until the first blank line.
  const kv: Record<string, string> = {};
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      break;
    }
    if (/^#{2,}\s/.test(line)) break; // safeguard against missing blank line
    const m = KEY_VALUE_LINE.exec(line.trim());
    if (m) {
      kv[m[1].toLowerCase()] = m[2];
      i++;
    } else {
      // Non-key line inside metadata block — bail to description.
      break;
    }
  }

  // Read description until the next heading or EOF.
  const descLines: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (/^#{1,3}\s/.test(line)) break;
    descLines.push(line);
    i++;
  }
  const description = descLines.join("\n").trim();
  if (!description) {
    throw new Error(`Asset "${heading}" is missing a description.`);
  }

  const id = slugify(heading);
  if (!id) {
    throw new Error(`Asset heading "${heading}" does not produce a valid id.`);
  }
  const file = validateAssetOutputPath(
    required(kv, "file", `asset "${heading}"`),
    `asset "${heading}" file`,
  );
  const rawType = kv["type"] ?? "sprite";
  if (!VALID_TYPES.has(rawType as AssetType)) {
    throw new Error(
      `Asset "${heading}" has invalid type "${rawType}". Valid: ${[
        ...VALID_TYPES,
      ].join(", ")}`,
    );
  }

  const spec: AssetSpec = {
    id,
    file,
    section,
    type: rawType as AssetType,
    aspect: validateAspectRatio(
      kv["aspect"] ?? settings.default_aspect,
      `asset "${heading}" aspect`,
    ),
    size: validateRenderSize(
      kv["size"] ?? settings.default_size,
      `asset "${heading}" size`,
    ),
    description,
  };

  return { spec, nextIndex: i };
}

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function required(
  kv: Record<string, string>,
  key: string,
  context = "settings",
): string {
  const v = kv[key];
  if (!v) {
    throw new Error(`Missing required key "${key}" in ${context}.`);
  }
  return v;
}
