# illuminator

CLI for generating cohesive illustration batches from a single Markdown
spec document. Every image in a run shares the same style, palette, and
composition rules because Claude reformats each one against a single
cached style anchor before sending it to Flux 2.

Pipeline per asset:

```text
spec.md  →  parse  →  Claude (Flux 2 JSON synthesis)  →  BFL Flux 2  →  raw PNG + sidecar JSON
                                                                                  │
                                                                                  ▼
                                                                        Python post-process
                                                                        (rembg, hex mask, …)
                                                                                  │
                                                                                  ▼
                                                                        game-ready assets
```

## Install

```bash
npm install
npm run build

python3 -m venv .venv && source .venv/bin/activate
pip install -r post/requirements.txt
```

## Environment

```bash
export BFL_API_KEY=...            # Black Forest Labs API key
export ANTHROPIC_API_KEY=...      # Claude prompt formatter
```

## Usage

```bash
# generate everything from a spec
node dist/cli.js generate examples/canonry-game.md --out ./raw

# generate only a specific section
node dist/cli.js generate examples/canonry-game.md --section sprites --out ./raw

# generate up to 3 assets at a time
node dist/cli.js generate examples/canonry-game.md --concurrency 3 --out ./raw

# smoke test: 3 assets across sections, before spending a full batch
node dist/cli.js generate examples/canonry-game.md --smoke-test --out ./raw

# dump the Claude-formatted Flux 2 prompts without calling BFL
node dist/cli.js generate examples/canonry-game.md --preview

# post-process raw PNGs into game-ready assets
node dist/cli.js process ./raw ./out
# or run python directly:
python3 post/process.py ./raw ./out
```

## Spec format

See `examples/canonry-game.md` for a complete example. Short version:

```markdown
# My Asset Pack

<!-- settings -->
preset: glacial-archive
model: flux-2-pro
default_size: 1024x1024
default_aspect: 1:1
<!-- /settings -->

## 1 · Entity sprites

### penguin
file: sprites/penguin.png
type: sprite
aspect: 1:1

A single adult emperor penguin standing upright, slight 3/4 overhead
angle, dove-grey back, cream belly with faint amber.

### settlement
file: sprites/settlement.png
type: sprite

A small snow-bound settlement of packed-snow shelters with warm
light spilling from one doorway.
```

**Rules:**

- Settings block at the top, delimited by HTML comments.
- `##` opens a section (used for filtering with `--section`).
- `###` opens an asset. Key:value lines follow the heading until the first blank line. Everything after the blank line until the next heading is the raw description.
- `file` is required and must be a relative `.png` path inside the chosen output directory.
- Every asset must live under a `##` section and must have a non-empty description.
- `type` defaults to `sprite`. `aspect` and `size` fall back to the settings defaults.
- `size` must be `WIDTHxHEIGHT`, between `256` and `4096` on each side, and each dimension must be a multiple of `16`.
- `aspect` must be `W:H` with positive integers.
- Supported BFL models are `flux-2-pro`, `flux-2-max`,
  `flux-pro-1.1-ultra`, and `flux-pro-1.1-ultra-raw`.

**Asset types:**

| Type | Post-processing |
| --- | --- |
| `sprite` | rembg cutout + crop to content + alpha PNG |
| `hex-tile` | pointy-top hex mask with feathered edges |
| `icon` | rembg + resize to 16/32/64/128 variants |
| `card-face` | crop to 3:4, no background removal |
| `chrome` | rembg, keep native resolution |
| `background` | no cutout, resize only |
| `passthrough` | copy as-is |

## Style presets

Each preset defines the `StyleAnchor` and `Palette` applied to every image in a batch. List available presets:

```bash
node dist/cli.js presets
```

To add a new preset:

1. Copy `src/presets/glacial-archive.ts` to `src/presets/<my-style>.ts`
2. Edit the `artistic`, `composition`, `palette`, etc.
3. Register it in `src/preset-registry.ts`

## Cost per run (rough)

- Claude (Sonnet 4.6, formatting): ~$0.002 per asset after the first call (prompt cache kicks in).
- BFL Flux 2 Pro: ~$0.06 per image (actual cost returned on each submit).

A full 50-asset batch runs ~$3. Smoke-test runs (`--smoke-test`) are ~$0.18.

## Quality checks

```bash
npm run lint:docs
npm test
```

## Architecture

```text
illuminator/
├── src/                        TypeScript sources
│   ├── types.ts                Shared types
│   ├── palette.ts              Palette → Claude context
│   ├── preset-registry.ts      Preset registry (load by id)
│   ├── parse-spec.ts           Markdown spec parser
│   ├── claude-formatter.ts     Flux 2 JSON synthesis via Claude
│   ├── bfl-client.ts           Direct BFL Flux 2 API
│   ├── generate.ts             Orchestrator (parse → format → generate → disk)
│   ├── validation.ts           Input and path validation helpers
│   └── cli.ts                  CLI entry
├── src/presets/                Style preset definitions
│   └── glacial-archive.ts
├── post/                       Python post-processor
│   ├── process.py              rembg / hex-mask / resize
│   └── requirements.txt
├── test/                       Node test suite
└── examples/                   Sample spec docs
```

## Why a separate Claude formatting step?

Flux 2 ignores negations, degrades on long prompts, and defaults to
cute cartoon proportions on animal subjects. It uses a **JSON prompt
format** (scene + subjects) that's wildly different from free-text.
Writing 50 prompts by hand that all respect these constraints is
error-prone; letting Claude rewrite each short description against a
cached template enforces them uniformly.

Lessons baked into the system prompt (adapted from the canonry monorepo's `FLUX_2_SUBJECT_SYNTHESIS_TEMPLATE`):

- Positive descriptions only — never "avoid", "no", "without"
- ~20 words per subject description before the color tag
- Adult anatomical proportions required for animal characters
- Primary palette colors → focal subjects; secondary → atmosphere
- Vivid color names in scene text; hex codes only in subject color anchors
