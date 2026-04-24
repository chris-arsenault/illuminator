import type { StyleAnchor, Palette } from "../types.js";

/**
 * The Glacial Archive — editorial archival aesthetic used by The Canonry Game.
 * Ink and watercolor, museum-plate composition, warm cream on cold ink.
 *
 * This is a reference preset. Copy and edit to build new style anchors; keep
 * one anchor per project so every asset in a batch reads as one book.
 */
export const glacialArchiveStyle: StyleAnchor = {
  id: "glacial-archive",
  name: "The Glacial Archive",
  artistic: [
    "editorial field-journal illustration in ink and watercolor",
    "painterly, hand-painted on aged parchment",
    "19th-century naturalist plate aesthetic, like Audubon or a polar expedition survey",
    "fine nib-pen linework with loose watercolor fills",
    "subtle grain from aged paper beneath, faint foxing at the edges",
    "restrained color saturation — muted, contemplative, archival",
  ].join("; "),
  composition: [
    "centered subject with generous negative space around it",
    "warm-cream parchment background with faint aged-paper texture",
    "a soft drop shadow grounds the subject on the page",
    "no elaborate framing or borders — the subject sits alone on the page as if pinned for study",
  ].join("; "),
  medium_notes: [
    "ink and watercolor ONLY — no digital gloss, no neon, no glow effects",
    "no cel-shading, no hard vector outlines, no airbrush, no photorealism",
    "the image should look like a 19th-century plate, not a modern digital illustration",
  ].join("; "),
  species_bias_counter: [
    "animal characters must use ADULT anatomical proportions",
    "tall, lean, narrow features with attentive dark eyes proportional to the skull",
    "for penguins specifically: tall adult emperor penguin with narrow pointed beak, small dark eyes, lean upright posture, sleek plumage",
    "never juvenile or cartoon proportions, never oversized eyes, never stubby limbs",
  ].join("; "),
  wear_and_weathering: [
    "subjects show subtle signs of a harsh polar existence",
    "wind-worn plumage, frost-dusted edges, minor weathering",
    "never pristine, never factory-new — everything has a lived-in quality",
    "but restrained — this is not grimdark, just honest",
  ].join("; "),
};

export const glacialArchivePalette: Palette = {
  id: "glacial-archive",
  name: "Glacial Archive",
  primary: [
    "#E7E3D5", // vellum — warm cream, backgrounds and highlights
    "#B8B5A6", // parchment — secondary text, muted warm
    "#D97742", // ember — rare hot accent, used on a single element only
    "#C9A96B", // gilt — warmth for small highlights, fire-lit surfaces
  ],
  secondary: [
    "#0B0F14", // ink — deepest shadow, linework
    "#19202C", // slate — mid shadow, background masses
    "#2E3A4F", // ice — cool highlight on snow and ice surfaces
    "#78C9B2", // aurora — healthy/active cool accent, rare
    "#B04646", // blood — critical/dead, very rare
  ],
  notes: [
    "Warm vellum cream dominates all backgrounds",
    "Slate ink handles all linework and deepest shadows",
    "Ember is the ONE hot accent and appears on at most one element per image",
    "Aurora is a cool cyan-green for occasional highlights (fire glow, aurora glimmers)",
    "Avoid pure white (#FFFFFF) and pure black (#000000) — always use vellum and ink",
    "Do not use hex codes in the scene text; translate to vivid names (e.g. 'warm vellum cream', 'slate ink shadow', 'ember glow')",
  ].join(". "),
};
