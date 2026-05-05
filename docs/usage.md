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

Output goes to `<pack-dir>/output/` by default — raw Flux PNGs land under
`<pack-dir>/output/raw/`, and post-processed variants land under
`<pack-dir>/output/processed/` (when `--and-process` is on). Use `--out` only
when you want outputs somewhere other than next to the pack.

Generation is incremental by default: Illuminator scans the raw output
directory and only runs pack assets whose raw PNG is missing. Add
`--reprocess` to regenerate the selected assets even if their raw PNGs already
exist.

Generate the whole pack (output at `examples/field-kit/output/raw/`):

```bash
node dist/cli.js generate examples/field-kit
```

Generate and post-process in one step:

```bash
node dist/cli.js generate examples/field-kit --and-process --concurrency 3
```

Point directly at the manifest:

```bash
node dist/cli.js generate examples/field-kit/pack.toml
```

Generate one section by matching its id or title:

```bash
node dist/cli.js generate examples/field-kit --section icons
```

Regenerate every asset in a section, including raw PNGs that already exist:

```bash
node dist/cli.js generate examples/field-kit --section icons --reprocess
```

Limit the run:

```bash
node dist/cli.js generate examples/field-kit --limit 10
```

Run the built-in smoke test:

```bash
node dist/cli.js generate examples/field-kit --smoke-test
```

Increase parallelism:

```bash
node dist/cli.js generate examples/field-kit --concurrency 3
```

Override the pack model:

```bash
node dist/cli.js generate examples/field-kit --model flux-2-max
```

Override the output location (writes to `/tmp/my-batch/raw/` etc.):

```bash
node dist/cli.js generate examples/field-kit --out /tmp/my-batch
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

The recommended flow is `--and-process` during generation, which runs the
post-processor on successful renders automatically. For re-processing
(e.g. you regenerated a few assets and want to rebuild atlases), the separate
`process` subcommand points directly at raw/ and processed/ dirs:

```bash
node dist/cli.js process examples/field-kit/output/raw examples/field-kit/output/processed
```

Or run the Python script directly:

```bash
python3 post/process.py examples/field-kit/output/raw examples/field-kit/output/processed --concurrency 3
```

The processor is opinionated and automatic:

- cutout-heavy asset types use type-based rembg policies with session reuse
- output PNGs get embedded provenance metadata
- `sprite` and `icon` outputs are packed into atlas PNGs and JSON manifests
- per-image work runs on a `ThreadPoolExecutor` using `--concurrency`

## Typical workflow

```bash
# 1. validate the pack (no API cost)
node dist/cli.js generate examples/field-kit --dry-run

# 2. preview prompt synthesis if needed (Claude cost only)
node dist/cli.js generate examples/field-kit --preview

# 3. run a small sample, generate and process in one shot
node dist/cli.js generate examples/field-kit --smoke-test --and-process --concurrency 3

# 4. run the full batch the same way
node dist/cli.js generate examples/field-kit --and-process --concurrency 3
```

After a run, look under `examples/field-kit/output/processed/atlases/` for
generated sprite and icon atlases. The raw Flux outputs and their sidecar
JSONs live under `examples/field-kit/output/raw/`.

## Other commands

List available presets:

```bash
node dist/cli.js presets
```

Show CLI help:

```bash
node dist/cli.js --help
```
