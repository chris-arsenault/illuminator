# Pack Format Guide

The canonical input format is a `pack.toml` manifest plus optional prompt
Markdown files stored beside it.

## Minimal example

```toml
title = "My Asset Pack"
preset = "glacial-archive"
model = "flux-2-pro"
default_style = "plate"
default_palette = "polar"

[defaults]
size = "1024x1024"
aspect = "1:1"

[style.plate]
name = "Plate"
composition = "strictly centered composition with generous negative space"

[palette.polar]
name = "Polar"
primary = ["#E7E3D5", "#D97742"]
secondary = ["#19202C", "#2E3A4F"]

[type_prompt_fragment]
icon = "Keep icon silhouettes crisp and readable at 16px."

[[section]]
id = "entity-sprites"
title = "Entity sprites"
style = "plate"
palette = "polar"

[[section.asset]]
id = "penguin"
file = "sprites/penguin.png"
type = "sprite"
prompt = "prompts/entity-sprites/penguin.md"

[[section.asset]]
id = "settlement"
file = "sprites/settlement.png"
type = "sprite"
prompt_inline = """
A small snow-bound settlement of packed-snow shelters with warm light
spilling from one doorway.
"""
```

Prompt file example:

```md
A single adult emperor penguin standing upright, slight 3/4 overhead
angle, dove-grey back, cream belly with faint amber.
```

## Top-level keys

Supported top-level keys:

- `title`
- `preset`
- `model`
- `default_style`
- `default_palette`
- `default_identity`
- `defaults`
- `style`
- `palette`
- `identity`
- `type_prompt_fragment`
- `section`

Unknown keys are rejected.

## Required fields

- `preset` is required.
- `pack.section` must contain at least one `[[section]]`.
- each `[[section]]` must contain at least one `[[section.asset]]`.
- each asset must set `id`, `file`, and exactly one of `prompt` or
  `prompt_inline`.

## Defaults

`model` defaults to `flux-2-pro`.

`[defaults]` may define:

- `size`
- `aspect`

If `default_style` or `default_palette` are omitted, they fall back to the
preset's own base ids. `default_identity` is optional and has no preset-level
fallback — packs without cultural grounding leave it unset.

## Styles and palettes

Use `[style.<id>]` to define named style variants and `[palette.<id>]` to
define named palette variants. These tables override fields on top of the
selected preset's base style and palette.

Style fields:

- `name`
- `artistic`
- `composition`
- `medium_notes`
- `species_bias_counter`
- `wear_and_weathering`

Palette fields:

- `name`
- `primary`
- `secondary`
- `notes`

## Identities

Use `[identity.<id>]` to define named subject identities — canonical
descriptions of a cultural, factional, or species grounding that applies to a
subset of assets. An asset's resolved identity is spliced into Claude's user
message alongside the prompt, so every asset in the same identity reads as
from the same world without the identity text being copy-pasted into each
prompt file.

Identity fields:

- `name` — human-facing label
- `description` — the canonical vocabulary itself (required, must be non-empty)

Keep descriptions under roughly 150 words each. Identity text shares the
user message with the asset prompt and the type fragment; verbosity crowds
out useful detail and pushes Claude toward truncation.

Example:

```toml
[identity.aurora-stack]
name = "Aurora Stack"
description = """
Penguins of the sunlit vertical crystalline spire colony. Regalia: pale
ice-plate armor, aurora-crystal coronets, flowing white robes over
segmented silvered plate. Magic: aurora-light — cool prismatic shimmer at
crystal edges, slow, meditative. Architecture: spires, prismatic lenses,
tiered ceremonial halls.
"""

[identity.orca]
name = "Orca"
description = """
Ritual-scarred wake-singers of the Corpse Current. No clothing — carved
resonance-chambers on the flanks, hunt-liturgy scars across the snout.
The Dreaming Tooth when relevant. Blue-black hide, ivory scar-lines,
faint gravitational haze when pressure-magic is invoked.
"""
```

## Sections

Each `[[section]]` supports:

- `id`
- `title`
- `style`
- `palette`
- `identity`
- `asset`

`id` is required. `title` defaults to the section id if omitted.

## Assets

Each `[[section.asset]]` supports:

- `id`
- `file`
- `type`
- `aspect`
- `size`
- `style`
- `palette`
- `identity`
- `prompt`
- `prompt_inline`

Asset ids use lowercase kebab-case.

`prompt` points to a Markdown file relative to the pack directory.
`prompt_inline` embeds the prompt text directly in the TOML file.

## Resolution order

Style, palette, and identity ids all resolve with the same chain:

1. asset-level
2. section-level
3. top-level default
4. for style/palette: preset base id; for identity: null (no identity applied)

## Type prompt fragments

`[type_prompt_fragment]` maps asset types to extra prompt guidance text.

Example:

```toml
[type_prompt_fragment]
icon = "Keep icon silhouettes crisp and readable at 16px."
chrome = "Keep decorative edges controlled and production-friendly."
```

This text is appended after the built-in type-specific guidance.

## Validation rules

- `file` must be a relative `.png` path.
- `prompt` must be a relative `.md` path.
- prompt paths and output paths cannot escape their containing directory.
- `size` must be `WIDTHxHEIGHT`.
- each dimension must be between `256` and `4096`.
- each dimension must be a multiple of `16`.
- `aspect` must be `W:H` with positive integers.
- supported models are `flux-2-pro`, `flux-2-max`,
  `flux-pro-1.1-ultra`, `flux-pro-1.1-ultra-raw`,
  `gpt-image-1.5`, `gpt-image-1`, `dall-e-3`, and `dall-e-2`.

## Output metadata

`illuminator` writes:

- a sidecar JSON record next to each raw PNG
- embedded provenance metadata inside each raw PNG
- embedded provenance metadata inside each processed PNG

Processed sprite and icon outputs also participate in automatic atlas
generation. Atlas sheets are written as PNGs under `out/atlases/` with JSON
manifests beside them.

## Asset types

| Type | Post-processing |
| --- | --- |
| `sprite` | automatic rembg cutout policy + crop to content + alpha PNG + atlas candidate |
| `hex-tile` | pointy-top hex mask with feathered edges |
| `icon` | automatic rembg cutout policy + 16/32/64/128 square variants + atlas candidate |
| `card-face` | crop to 3:4, no background removal |
| `chrome` | automatic rembg cutout policy, keep native resolution |
| `background` | no cutout, resize only |
| `mask` | flatten onto white, center square, 1024px, grayscale, range-normalized; colour pipeline skipped |
| `passthrough` | copy as-is |

A `mask` asset is spatial-control material rather than a picture. It is consumed as a distance field,
gradient field, or stencil, so the colour pipeline is skipped: saturation boost and LUT grading would
distort the values those derivations read. Author mask prompts as a single bold white shape on a
black field.
