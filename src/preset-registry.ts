import type { StyleAnchor, Palette } from "./types.js";
import {
  glacialArchiveStyle,
  glacialArchivePalette,
} from "./presets/glacial-archive.js";

/**
 * Registry of available base presets. Each preset is a pair of
 * (StyleAnchor, Palette) that a pack can use directly or override with named
 * style/palette entries.
 *
 * To add a new preset: create `src/presets/<name>.ts` exporting a style +
 * palette, import here, and register it below.
 */
const PRESETS: Record<string, { style: StyleAnchor; palette: Palette }> = {
  "glacial-archive": {
    style: glacialArchiveStyle,
    palette: glacialArchivePalette,
  },
};

export function getPreset(id: string): { style: StyleAnchor; palette: Palette } {
  const preset = PRESETS[id];
  if (!preset) {
    const available = Object.keys(PRESETS).join(", ");
    throw new Error(
      `Unknown preset "${id}". Available: ${available}`,
    );
  }
  return preset;
}

export function listPresets(): string[] {
  return Object.keys(PRESETS);
}
