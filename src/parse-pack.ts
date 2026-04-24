import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { getPreset } from "./preset-registry.js";
import type {
  AssetDoc,
  AssetSpec,
  AssetType,
  DocSettings,
  Palette,
  StyleAnchor,
} from "./types.js";
import {
  resolveSafePathWithinRoot,
  validateAspectRatio,
  validateAssetOutputPath,
  validateIdentifier,
  validateModelId,
  validateNonEmptyText,
  validatePromptSourcePath,
  validateRenderSize,
} from "./validation.js";

export const PACK_FILENAME = "pack.toml";

const VALID_TYPES: ReadonlySet<AssetType> = new Set([
  "sprite",
  "hex-tile",
  "icon",
  "card-face",
  "chrome",
  "background",
  "passthrough",
]);

const BUILTIN_TYPE_PROMPT_FRAGMENTS: Record<AssetType, string> = {
  sprite:
    "This asset is a sprite. Keep the silhouette clean and readable, with one clear focal subject and strong separation from the background.",
  "hex-tile":
    "This asset is a top-down hex tile. Compose it for clear map readability, with the terrain filling the frame evenly and no horizon line.",
  icon:
    "This asset is an icon. Use crisp, reduced shapes, bold edges, and high readability at very small sizes.",
  "card-face":
    "This asset is a card face. Compose for a vertical 3:4 frame with a strong focal subject and room for card framing or overlay treatment.",
  chrome:
    "This asset is UI chrome or ornamentation. Keep it decorative, controlled, and cleanly cuttable from the background.",
  background:
    "This asset is a background or texture. Prioritize atmosphere and surface coherence over a single isolated subject.",
  passthrough:
    "This asset should remain straightforward and production-friendly, with composition that survives direct downstream use.",
};

type TomlTable = Record<string, unknown>;

interface StyleDefinition {
  name?: string;
  artistic?: string;
  composition?: string;
  medium_notes?: string;
  species_bias_counter?: string;
  wear_and_weathering?: string;
}

interface PaletteDefinition {
  name?: string;
  primary?: string[];
  secondary?: string[];
  notes?: string;
}

export async function loadPack(inputPath: string): Promise<AssetDoc> {
  const packPath = await resolvePackPath(inputPath);
  const packDir = dirname(packPath);
  const source = await readFile(packPath, "utf8");

  let parsed: unknown;
  try {
    parsed = parseToml(source);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${packPath} as TOML: ${msg}`);
  }

  const root = asTable(parsed, "pack");
  assertAllowedKeys(
    root,
    new Set([
      "title",
      "preset",
      "model",
      "default_style",
      "default_palette",
      "defaults",
      "style",
      "palette",
      "type_prompt_fragment",
      "section",
    ]),
    "pack",
  );

  const presetId = validateNonEmptyText(
    readString(required(root, "preset", "pack"), "pack.preset"),
    "pack.preset",
  );
  const preset = getPreset(presetId);

  const styles = parseStyleRegistry(root.style, preset.style);
  const palettes = parsePaletteRegistry(root.palette, preset.palette);
  const settings = parseSettings(root, preset.style.id, preset.palette.id);
  const typePromptFragments = parseTypePromptFragments(root.type_prompt_fragment);

  assertKnownStyleId(settings.default_style, styles, "pack.default_style");
  assertKnownPaletteId(settings.default_palette, palettes, "pack.default_palette");

  const specs = await parseSections(
    root.section,
    {
      settings,
      styles,
      palettes,
      typePromptFragments,
      packDir,
    },
  );

  return { packDir, settings, styles, palettes, specs };
}

async function resolvePackPath(inputPath: string): Promise<string> {
  const resolved = resolve(inputPath);
  const details = await stat(resolved).catch(() => null);
  if (!details) {
    throw new Error(`Pack path does not exist: ${inputPath}`);
  }

  if (details.isDirectory()) {
    const packPath = resolve(resolved, PACK_FILENAME);
    const packDetails = await stat(packPath).catch(() => null);
    if (!packDetails || !packDetails.isFile()) {
      throw new Error(
        `Directory ${inputPath} does not contain ${PACK_FILENAME}.`,
      );
    }
    return packPath;
  }

  return resolved;
}

function parseSettings(
  root: TomlTable,
  fallbackStyleId: string,
  fallbackPaletteId: string,
): DocSettings {
  if (root.title !== undefined) {
    readString(root.title, "pack.title");
  }

  const defaultsRaw = root.defaults === undefined
    ? {}
    : asTable(root.defaults, "pack.defaults");
  assertAllowedKeys(defaultsRaw, new Set(["size", "aspect"]), "pack.defaults");

  return {
    title: readOptionalTrimmedString(root.title, "pack.title"),
    preset: validateNonEmptyText(
      readString(required(root, "preset", "pack"), "pack.preset"),
      "pack.preset",
    ),
    model: validateModelId(
      readOptionalString(root.model, "pack.model") ?? "flux-2-pro",
      "pack.model",
    ),
    default_style: validateIdentifier(
      readOptionalString(root.default_style, "pack.default_style") ?? fallbackStyleId,
      "pack.default_style",
    ),
    default_palette: validateIdentifier(
      readOptionalString(root.default_palette, "pack.default_palette") ?? fallbackPaletteId,
      "pack.default_palette",
    ),
    default_size: validateRenderSize(
      readOptionalString(defaultsRaw.size, "pack.defaults.size") ?? "1024x1024",
      "pack.defaults.size",
    ),
    default_aspect: validateAspectRatio(
      readOptionalString(defaultsRaw.aspect, "pack.defaults.aspect") ?? "1:1",
      "pack.defaults.aspect",
    ),
  };
}

function parseStyleRegistry(
  rawStyles: unknown,
  baseStyle: StyleAnchor,
): Record<string, StyleAnchor> {
  const registry: Record<string, StyleAnchor> = {
    [baseStyle.id]: baseStyle,
  };

  if (rawStyles === undefined) return registry;

  const styleTable = asTable(rawStyles, "pack.style");
  for (const [rawId, rawStyle] of Object.entries(styleTable)) {
    const id = validateIdentifier(rawId, `pack.style.${rawId}`);
    const style = parseStyleDefinition(rawStyle, `pack.style.${id}`);
    registry[id] = mergeStyleAnchor(baseStyle, style, id);
  }
  return registry;
}

function parsePaletteRegistry(
  rawPalettes: unknown,
  basePalette: Palette,
): Record<string, Palette> {
  const registry: Record<string, Palette> = {
    [basePalette.id]: basePalette,
  };

  if (rawPalettes === undefined) return registry;

  const paletteTable = asTable(rawPalettes, "pack.palette");
  for (const [rawId, rawPalette] of Object.entries(paletteTable)) {
    const id = validateIdentifier(rawId, `pack.palette.${rawId}`);
    const palette = parsePaletteDefinition(rawPalette, `pack.palette.${id}`);
    registry[id] = mergePalette(basePalette, palette, id);
  }
  return registry;
}

function parseStyleDefinition(rawStyle: unknown, context: string): StyleDefinition {
  const style = asTable(rawStyle, context);
  assertAllowedKeys(
    style,
    new Set([
      "name",
      "artistic",
      "composition",
      "medium_notes",
      "species_bias_counter",
      "wear_and_weathering",
    ]),
    context,
  );

  return {
    name: readOptionalTrimmedString(style.name, `${context}.name`),
    artistic: readOptionalTrimmedString(style.artistic, `${context}.artistic`),
    composition: readOptionalTrimmedString(style.composition, `${context}.composition`),
    medium_notes: readOptionalTrimmedString(style.medium_notes, `${context}.medium_notes`),
    species_bias_counter: readOptionalTrimmedString(
      style.species_bias_counter,
      `${context}.species_bias_counter`,
    ),
    wear_and_weathering: readOptionalTrimmedString(
      style.wear_and_weathering,
      `${context}.wear_and_weathering`,
    ),
  };
}

function parsePaletteDefinition(
  rawPalette: unknown,
  context: string,
): PaletteDefinition {
  const palette = asTable(rawPalette, context);
  assertAllowedKeys(
    palette,
    new Set(["name", "primary", "secondary", "notes"]),
    context,
  );

  return {
    name: readOptionalTrimmedString(palette.name, `${context}.name`),
    primary: readOptionalStringArray(palette.primary, `${context}.primary`),
    secondary: readOptionalStringArray(palette.secondary, `${context}.secondary`),
    notes: readOptionalTrimmedString(palette.notes, `${context}.notes`),
  };
}

function parseTypePromptFragments(
  rawFragments: unknown,
): Partial<Record<AssetType, string>> {
  const parsed: Partial<Record<AssetType, string>> = {};
  if (rawFragments === undefined) return parsed;

  const table = asTable(rawFragments, "pack.type_prompt_fragment");
  for (const [key, rawFragment] of Object.entries(table)) {
    if (!VALID_TYPES.has(key as AssetType)) {
      throw new Error(
        `pack.type_prompt_fragment.${key} must target one of: ${[...VALID_TYPES].join(", ")}.`,
      );
    }
    parsed[key as AssetType] = validateNonEmptyText(
      readString(rawFragment, `pack.type_prompt_fragment.${key}`),
      `pack.type_prompt_fragment.${key}`,
    );
  }

  return parsed;
}

async function parseSections(
  rawSections: unknown,
  opts: {
    settings: DocSettings;
    styles: Record<string, StyleAnchor>;
    palettes: Record<string, Palette>;
    typePromptFragments: Partial<Record<AssetType, string>>;
    packDir: string;
  },
): Promise<AssetSpec[]> {
  if (!Array.isArray(rawSections) || rawSections.length === 0) {
    throw new Error("pack.section must contain at least one [[section]] entry.");
  }

  const specs: AssetSpec[] = [];
  const seenSectionIds = new Set<string>();
  const seenAssetIds = new Set<string>();
  const seenFiles = new Set<string>();

  for (let i = 0; i < rawSections.length; i++) {
    const context = `pack.section[${i}]`;
    const section = asTable(rawSections[i], context);
    assertAllowedKeys(section, new Set(["id", "title", "style", "palette", "asset"]), context);

    const sectionId = validateIdentifier(
      readString(required(section, "id", context), `${context}.id`),
      `${context}.id`,
    );
    if (seenSectionIds.has(sectionId)) {
      throw new Error(`Duplicate section id "${sectionId}".`);
    }
    seenSectionIds.add(sectionId);

    const sectionTitle = validateNonEmptyText(
      readOptionalString(section.title, `${context}.title`) ?? sectionId,
      `${context}.title`,
    );
    const sectionStyleId = resolveStyleId(
      readOptionalString(section.style, `${context}.style`) ?? opts.settings.default_style,
      opts.styles,
      `${context}.style`,
    );
    const sectionPaletteId = resolvePaletteId(
      readOptionalString(section.palette, `${context}.palette`) ?? opts.settings.default_palette,
      opts.palettes,
      `${context}.palette`,
    );

    if (!Array.isArray(section.asset) || section.asset.length === 0) {
      throw new Error(
        `${context} (${sectionId}) must contain at least one [[section.asset]] entry.`,
      );
    }

    for (let assetIndex = 0; assetIndex < section.asset.length; assetIndex++) {
      const asset = await parseAsset(section.asset[assetIndex], {
        context: `${context}.asset[${assetIndex}]`,
        sectionId,
        sectionTitle,
        defaultStyleId: sectionStyleId,
        defaultPaletteId: sectionPaletteId,
        settings: opts.settings,
        styles: opts.styles,
        palettes: opts.palettes,
        packDir: opts.packDir,
        typePromptFragments: opts.typePromptFragments,
      });
      if (seenAssetIds.has(asset.id)) {
        throw new Error(`Duplicate asset id "${asset.id}".`);
      }
      if (seenFiles.has(asset.file)) {
        throw new Error(`Duplicate asset output path "${asset.file}".`);
      }
      seenAssetIds.add(asset.id);
      seenFiles.add(asset.file);
      specs.push(asset);
    }
  }

  return specs;
}

async function parseAsset(
  rawAsset: unknown,
  opts: {
    context: string;
    sectionId: string;
    sectionTitle: string;
    defaultStyleId: string;
    defaultPaletteId: string;
    settings: DocSettings;
    styles: Record<string, StyleAnchor>;
    palettes: Record<string, Palette>;
    packDir: string;
    typePromptFragments: Partial<Record<AssetType, string>>;
  },
): Promise<AssetSpec> {
  const asset = asTable(rawAsset, opts.context);
  assertAllowedKeys(
    asset,
    new Set([
      "id",
      "file",
      "type",
      "aspect",
      "size",
      "style",
      "palette",
      "prompt",
      "prompt_inline",
    ]),
    opts.context,
  );

  const id = validateIdentifier(
    readString(required(asset, "id", opts.context), `${opts.context}.id`),
    `${opts.context}.id`,
  );
  const file = validateAssetOutputPath(
    readString(required(asset, "file", opts.context), `${opts.context}.file`),
    `${opts.context}.file`,
  );

  const rawType = readOptionalString(asset.type, `${opts.context}.type`) ?? "sprite";
  if (!VALID_TYPES.has(rawType as AssetType)) {
    throw new Error(
      `${opts.context}.type must be one of: ${[...VALID_TYPES].join(", ")}.`,
    );
  }
  const type = rawType as AssetType;

  const styleId = resolveStyleId(
    readOptionalString(asset.style, `${opts.context}.style`) ?? opts.defaultStyleId,
    opts.styles,
    `${opts.context}.style`,
  );
  const paletteId = resolvePaletteId(
    readOptionalString(asset.palette, `${opts.context}.palette`) ?? opts.defaultPaletteId,
    opts.palettes,
    `${opts.context}.palette`,
  );
  const description = await loadPromptText(asset, opts.context, opts.packDir);
  const promptFragment = buildTypePromptFragment(type, opts.typePromptFragments[type]);

  return {
    id,
    file,
    section_id: opts.sectionId,
    section: opts.sectionTitle,
    style_id: styleId,
    palette_id: paletteId,
    type,
    prompt_fragment: promptFragment,
    aspect: validateAspectRatio(
      readOptionalString(asset.aspect, `${opts.context}.aspect`) ?? opts.settings.default_aspect,
      `${opts.context}.aspect`,
    ),
    size: validateRenderSize(
      readOptionalString(asset.size, `${opts.context}.size`) ?? opts.settings.default_size,
      `${opts.context}.size`,
    ),
    description,
  };
}

async function loadPromptText(
  asset: TomlTable,
  context: string,
  packDir: string,
): Promise<string> {
  const prompt = readOptionalString(asset.prompt, `${context}.prompt`);
  const promptInline = readOptionalString(
    asset.prompt_inline,
    `${context}.prompt_inline`,
  );

  if ((prompt ? 1 : 0) + (promptInline ? 1 : 0) !== 1) {
    throw new Error(
      `${context} must set exactly one of "prompt" or "prompt_inline".`,
    );
  }

  if (promptInline) {
    return validateNonEmptyText(promptInline, `${context}.prompt_inline`);
  }

  const promptPath = validatePromptSourcePath(prompt!, `${context}.prompt`);
  const absolutePromptPath = resolveSafePathWithinRoot(
    packDir,
    promptPath,
    `${context}.prompt`,
  );

  let source: string;
  try {
    source = await readFile(absolutePromptPath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read ${context}.prompt (${promptPath}): ${msg}`);
  }

  return validateNonEmptyText(source, `${context}.prompt`);
}

function mergeStyleAnchor(
  base: StyleAnchor,
  override: StyleDefinition,
  id: string,
): StyleAnchor {
  return {
    id,
    name: override.name ?? base.name,
    artistic: override.artistic ?? base.artistic,
    composition: override.composition ?? base.composition,
    medium_notes: override.medium_notes ?? base.medium_notes,
    species_bias_counter:
      override.species_bias_counter ?? base.species_bias_counter,
    wear_and_weathering:
      override.wear_and_weathering ?? base.wear_and_weathering,
  };
}

function mergePalette(
  base: Palette,
  override: PaletteDefinition,
  id: string,
): Palette {
  return {
    id,
    name: override.name ?? base.name,
    primary: override.primary ?? [...base.primary],
    secondary: override.secondary ?? [...base.secondary],
    notes: override.notes ?? base.notes,
  };
}

function buildTypePromptFragment(
  type: AssetType,
  customFragment: string | undefined,
): string | undefined {
  const fragments = [BUILTIN_TYPE_PROMPT_FRAGMENTS[type], customFragment]
    .filter((fragment) => fragment && fragment.trim().length > 0)
    .map((fragment) => fragment!.trim());
  return fragments.length > 0 ? fragments.join("\n") : undefined;
}

function resolveStyleId(
  rawId: string,
  styles: Record<string, StyleAnchor>,
  context: string,
): string {
  const id = validateIdentifier(rawId, context);
  assertKnownStyleId(id, styles, context);
  return id;
}

function resolvePaletteId(
  rawId: string,
  palettes: Record<string, Palette>,
  context: string,
): string {
  const id = validateIdentifier(rawId, context);
  assertKnownPaletteId(id, palettes, context);
  return id;
}

function assertKnownStyleId(
  id: string,
  styles: Record<string, StyleAnchor>,
  context: string,
): void {
  if (!(id in styles)) {
    throw new Error(
      `${context} references unknown style "${id}". Available: ${Object.keys(styles).join(", ")}.`,
    );
  }
}

function assertKnownPaletteId(
  id: string,
  palettes: Record<string, Palette>,
  context: string,
): void {
  if (!(id in palettes)) {
    throw new Error(
      `${context} references unknown palette "${id}". Available: ${Object.keys(palettes).join(", ")}.`,
    );
  }
}

function asTable(value: unknown, context: string): TomlTable {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be a TOML table.`);
  }
  return value as TomlTable;
}

function assertAllowedKeys(
  table: TomlTable,
  allowed: ReadonlySet<string>,
  context: string,
): void {
  for (const key of Object.keys(table)) {
    if (!allowed.has(key)) {
      throw new Error(`${context} contains unknown key "${key}".`);
    }
  }
}

function required(
  table: TomlTable,
  key: string,
  context: string,
): unknown {
  if (!(key in table)) {
    throw new Error(`${context} is missing required key "${key}".`);
  }
  return table[key];
}

function readString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`${context} must be a string.`);
  }
  return value;
}

function readOptionalString(value: unknown, context: string): string | undefined {
  if (value === undefined) return undefined;
  return readString(value, context);
}

function readOptionalTrimmedString(
  value: unknown,
  context: string,
): string | undefined {
  const raw = readOptionalString(value, context);
  return raw === undefined ? undefined : validateNonEmptyText(raw, context);
}

function readOptionalStringArray(
  value: unknown,
  context: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array of strings.`);
  }
  return value.map((entry, index) =>
    validateNonEmptyText(
      readString(entry, `${context}[${index}]`),
      `${context}[${index}]`,
    ),
  );
}
