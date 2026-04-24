# illuminator - handoff notes

Quick reference for the next agent picking this up.

## Current state

- TypeScript builds clean with `npm run build`.
- Node tests cover parser validation, path hardening, and CLI dry-run flows.
- Human-facing docs lint with `npm run lint:docs`.
- CLI supports bounded parallel generation via `--concurrency`.
- Example spec (`examples/canonry-game.md`) parses into 46 assets.
- Not verified with real API keys: Claude formatting, BFL generation, and
  `rembg` output still need live validation.

## Known limitations

### 1. No resume or skip-existing

If BFL times out late in a batch, rerunning still regenerates the earlier
assets and pays for them again.

**Fix:** add `--skip-existing` so `generate` skips assets when both the raw
PNG and sidecar JSON already exist under the output root.

**Where:** `src/cli.ts` and `src/generate.ts`.

### 2. No cost cap

A bad spec or large `--limit` can still spend more than intended because
there is no batch budget guardrail.

**Fix:** add `--max-cost <usd>` and stop dispatching new generations once
the projected spend would exceed the cap.

**Where:** `src/cli.ts` and `src/generate.ts`.

### 3. Parser errors still lack line numbers

Validation is much stricter now, but parser failures still point to the
field or asset rather than an exact source line.

**Fix:** thread line numbers through `parseSettings` and `parseSingleAsset`
so malformed specs fail with actionable locations.

**Where:** `src/parse-spec.ts`.

### 4. Python process preflight is still minimal

The `process` subcommand now resolves paths safely, but it still shells out
to `python3` without checking whether dependencies are installed up front.

**Fix:** add a short preflight import check before spawning the script, or
improve the spawned error message with dependency hints.

**Where:** `src/cli.ts`.

## Structural notes

- `examples/canonry-game.md` is a spec fixture, not prose docs.
  `markdownlint` intentionally excludes `examples/` because its heading and
  metadata layout is part of the parser contract.
- Path hardening now exists in both TypeScript and Python. If you add any new
  file-writing path, route it through the shared validation helpers or mirror
  the same containment checks.
- There is now a basic GitHub Actions workflow with step names prefixed
  `Lint` and `Test` to match the `../ahara` reporting convention.

## Entry points

| Change | File |
| --- | --- |
| Add a new style preset | `src/presets/<name>.ts` plus `src/preset-registry.ts` |
| Tweak Claude's synthesis template | `buildSystemPrompt()` in `src/claude-formatter.ts` |
| Change BFL request shape | `buildRequestBody()` in `src/bfl-client.ts` |
| Add a CLI flag | `src/cli.ts` plus `GenerateOptions` in `src/generate.ts` |
| Add a new asset type | `src/types.ts`, `src/parse-spec.ts`, `post/process.py` |
| Change spec document format | `src/parse-spec.ts` |
| Adjust docs lint scope or rules | `.markdownlint-cli2.jsonc` |
| Adjust CI checks | `.github/workflows/ci.yml` |

## Commands

```bash
npm run lint:docs
npm test
python3 -m py_compile post/process.py
```

## Suggested next order

1. `--skip-existing`
2. `--max-cost`
3. Parser line numbers
4. Better Python preflight
