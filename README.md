# illuminator

`illuminator` is a CLI for generating cohesive illustration batches from a
structured TOML pack. It separates three concerns cleanly:

- asset prompts stay short and local
- shared art direction lives in named styles and palettes
- type-specific production guidance is injected automatically

The goal is to make batch illustration authoring predictable. You define a
pack, resolve shared visual context once, let Claude translate each asset
into Flux 2 JSON, then post-process the raw renders into game-ready assets
with embedded provenance metadata and automatic atlas export for sprites and
icons.

## Why this exists

Most image-generation workflows break down at the batch level. A single image
is easy. Fifty related assets with consistent style, palette, and production
constraints is where things drift.

`illuminator` treats a batch as a real build artifact:

- a TOML manifest defines structure and reusable art direction
- prompt Markdown stays focused on the asset-specific subject matter
- every generated and processed PNG carries embedded provenance metadata
- raw PNGs still get sidecar JSON records for full reproducibility
- the post-processor applies deterministic transforms by asset type
- sprite and icon outputs are packed into atlases automatically

## Documentation

- [Usage Guide](docs/usage.md): install, environment, CLI commands, and the
  normal end-to-end workflow
- [Pack Format Guide](docs/pack-format.md): `pack.toml` schema, prompt files,
  resolution rules, and asset types
- [Customization Guide](docs/customization.md): named styles, named palettes,
  type prompt fragments, and presets
- [Development Guide](docs/development.md): quality checks, architecture, and
  repo layout

## Quick orientation

- Canonical input is a `pack.toml` file plus optional prompt `.md` files.
- The CLI accepts either a pack directory or a direct path to `pack.toml`.
- The sample pack lives under
  [examples/field-kit/pack.toml](examples/field-kit/pack.toml).

Example:

```bash
node dist/cli.js generate examples/field-kit --and-process --concurrency 3
```

Raw Flux outputs land at `examples/field-kit/output/raw/`, post-processed
assets at `examples/field-kit/output/processed/`. Override with `--out /some/dir`
if you want them elsewhere.

If you want details, start with the [Usage Guide](docs/usage.md).
