# Usage Guide

This guide covers the normal `illuminator` workflow:

1. install dependencies
2. prepare a pack directory
3. run generation
4. post-process the raw outputs

For the pack schema itself, see [Pack Format Guide](pack-format.md).

## Install

```bash
npm install
npm run build

python3 -m venv .venv && source .venv/bin/activate
pip install -r post/requirements.txt
```

## Environment

```bash
export BFL_API_KEY=...
export ANTHROPIC_API_KEY=...
```

`BFL_API_KEY` is required for image generation. `ANTHROPIC_API_KEY` is
required for formatting prompts through Claude.

## Input layout

The CLI expects either:

- a directory containing `pack.toml`
- or a direct path to `pack.toml`

Example pack:

```text
examples/field-kit/
├── pack.toml
└── prompts/
```

## Generate assets

Generate the whole pack:

```bash
node dist/cli.js generate examples/field-kit --out ./raw
```

Point directly at the manifest:

```bash
node dist/cli.js generate examples/field-kit/pack.toml --out ./raw
```

Generate one section by matching its id or title:

```bash
node dist/cli.js generate examples/field-kit --section icons --out ./raw
```

Limit the run:

```bash
node dist/cli.js generate examples/field-kit --limit 10 --out ./raw
```

Run the built-in smoke test:

```bash
node dist/cli.js generate examples/field-kit --smoke-test --out ./raw
```

Increase parallelism:

```bash
node dist/cli.js generate examples/field-kit --concurrency 3 --out ./raw
```

Override the pack model:

```bash
node dist/cli.js generate examples/field-kit --model flux-2-max --out ./raw
```

## Preview and validation

Validate the pack without calling Claude or BFL:

```bash
node dist/cli.js generate examples/field-kit --dry-run
```

Print Claude-formatted Flux 2 JSON without generating images:

```bash
node dist/cli.js generate examples/field-kit --preview
```

`--dry-run` is the cheapest way to validate pack structure, prompt paths,
style/palette references, and output paths before spending money.

## Post-process outputs

After generation, convert the raw PNG outputs into game-ready assets:

```bash
node dist/cli.js process ./raw ./out
```

Or run the Python script directly:

```bash
python3 post/process.py ./raw ./out
```

The processor is opinionated and automatic:

- cutout-heavy asset types use type-based rembg policies with session reuse
- output PNGs get embedded provenance metadata
- `sprite` and `icon` outputs are packed into atlas PNGs and JSON manifests

## Typical workflow

```bash
# 1. validate the pack
node dist/cli.js generate examples/field-kit --dry-run

# 2. preview prompt synthesis if needed
node dist/cli.js generate examples/field-kit --preview

# 3. run a small sample
node dist/cli.js generate examples/field-kit --smoke-test --concurrency 2 --out ./raw

# 4. run the full batch
node dist/cli.js generate examples/field-kit --concurrency 3 --out ./raw

# 5. post-process the results
node dist/cli.js process ./raw ./out
```

After `process`, look under `./out/atlases/` for generated sprite and icon
atlases.

## Other commands

List available presets:

```bash
node dist/cli.js presets
```

Show CLI help:

```bash
node dist/cli.js --help
```
