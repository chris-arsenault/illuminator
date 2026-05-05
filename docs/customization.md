# Customization Guide

This guide covers the reusable art-direction layer in `illuminator`:

- presets
- named styles
- named palettes
- type prompt fragments

## Presets

Every pack starts from a preset.

A preset provides:

- one base `StyleAnchor`
- one base `Palette`

The current sample preset is `glacial-archive`. Packs can use that base
style and palette directly, or define named variants on top of it.

List presets with:

```bash
node dist/cli.js presets
```

## Named styles

Named styles are declared in `pack.toml` under `[style.<id>]`.

Example:

```toml
[style.archive]
name = "Archive Plate"
composition = "centered subject with generous negative space"

[style.cinematic]
name = "Cinematic Plate"
composition = "broader framing, deeper atmosphere, and a stronger sense of scale"
```

These do not replace the preset wholesale. They override fields on top of the
preset's base style.

Supported style fields:

- `name`
- `artistic`
- `composition`
- `medium_notes`
- `species_bias_counter`
- `wear_and_weathering`

## Named palettes

Named palettes are declared in `pack.toml` under `[palette.<id>]`.

Example:

```toml
[palette.polar]
name = "Polar"
primary = ["#E7E3D5", "#B8B5A6", "#D97742", "#C9A96B"]
secondary = ["#0B0F14", "#19202C", "#2E3A4F", "#78C9B2", "#B04646"]

[palette.signal]
name = "Signal"
primary = ["#D97742", "#B04646", "#C9A96B"]
secondary = ["#0B0F14", "#19202C", "#E7E3D5"]
```

Like styles, these override fields on top of the preset's base palette.

Supported palette fields:

- `name`
- `primary`
- `secondary`
- `notes`

## Applying shared resources

Use the top-level defaults:

```toml
default_style = "archive"
default_palette = "polar"
```

Override at the section level:

```toml
[[section]]
id = "icons"
palette = "signal"
```

Override at the asset level:

```toml
[[section.asset]]
id = "alert-icon"
file = "icons/alert.png"
type = "icon"
style = "cinematic"
palette = "signal"
prompt_inline = """
Alert icon prompt.
"""
```

Resolution order is:

1. asset override
2. section override
3. top-level default
4. preset base id

## Type prompt fragments

Type prompt fragments let you attach reusable prompt guidance by asset type.

Example:

```toml
[type_prompt_fragment]
icon = "Keep icon silhouettes crisp and readable at 16px."
chrome = "Keep decorative edges controlled and production-friendly."
```

These fragments are appended after the built-in type-specific guidance.

That means an `icon` asset receives:

- the built-in icon guidance from the parser
- then your custom `type_prompt_fragment.icon` text
- then the asset's own prompt content

Use this for production constraints that should apply to every asset of a
given type.

Type fragments only affect prompt synthesis. The downstream post-processing
policy for each asset type remains automatic and code-defined.

## Named identities

Identities are a separate axis from styles and palettes. They capture the
canonical **vocabulary of a subject's cultural / factional / species
grounding**: armor, weapons, regalia, architecture, magical register — the
world-specific nouns.

Declare them under `[identity.<id>]`:

```toml
[identity.aurora-stack]
name = "Aurora Stack"
description = """
Penguins of the sunlit vertical crystalline spire colony. Regalia: pale
ice-plate, aurora-crystal coronets, flowing white robes over segmented
silvered plate. Magic: aurora-light — cool prismatic shimmer at crystal
edges. Architecture: spires, prismatic lenses, tiered ceremonial halls.
"""

[identity.nightshelf]
name = "Nightshelf"
description = """
Penguins of the underground tunnel labyrinth. Regalia: charcoal wraps
with ember-thread embroidery, hooded robes, bone-and-volcanic-glass masks.
Magic: captured fire — warm ember glow, detonation. Architecture: tunnel
warrens, fire-core braziers, bioluminescent ice glyphs.
"""
```

Apply them at any level of the resolution chain (asset > section > pack
default), the same way styles and palettes work:

```toml
default_identity = "aurora-stack"  # pack-wide default

[[section]]
id = "nightshelf-assets"
identity = "nightshelf"             # section override

[[section.asset]]
id = "orca-leader"
identity = "orca"                   # asset override (wins)
```

Keep identity descriptions **under ~150 words**. Identity text lands in
Claude's user message alongside the asset prompt and the type fragment;
verbose identities crowd out useful detail and push Claude toward truncation.

## When to use what

Use:

- a preset for the broad project baseline
- a named style when composition or rendering treatment changes across groups
- a named palette when color language changes across groups
- a named identity when subjects' cultural / factional vocabulary differs
  and you want ONE canonical source instead of copy-pasting the vocab into
  every prompt
- a type fragment when every asset of one asset type needs shared guidance
- the asset prompt for the actual subject-matter (the specific pose,
  action, composition — the things unique to this one asset)

Do not repeat pack-wide style, palette, or identity instructions inside
every prompt. That duplication is exactly what the manifest layer is meant
to remove — and what drifts when you hand-edit it.

## Adding a new preset in code

1. Copy `src/presets/glacial-archive.ts` to `src/presets/<my-style>.ts`.
2. Edit the style and palette exports.
3. Register the new preset in `src/preset-registry.ts`.
