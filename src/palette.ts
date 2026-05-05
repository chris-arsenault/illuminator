import type { Palette } from "./types.js";

/**
 * Format a palette as a Claude-facing instruction block. Embedded into the
 * system prompt so every prompt synthesis uses the same swatches.
 *
 * Primary colors are directed toward focal subjects; secondary colors toward
 * atmosphere. This pattern comes from illuminator's buildPaletteContext and
 * the Flux synthesis templates — separating primary/secondary forces the
 * image model to distribute color intentionally instead of averaging.
 */
export function buildPaletteContext(palette: Palette): string {
  const primaryList = palette.primary
    .map((hex) => `  - ${hex}`)
    .join("\n");
  const secondaryList = palette.secondary
    .map((hex) => `  - ${hex}`)
    .join("\n");

  const notes = palette.notes
    ? `\nPalette notes: ${palette.notes}`
    : "";

  return `
PALETTE — PRIMARY colors (use for focal subjects; pick vivid descriptors, never just hex codes):
${primaryList}

PALETTE — SECONDARY colors (use for atmosphere, shadow, less important elements):
${secondaryList}
${notes}
`.trim();
}
