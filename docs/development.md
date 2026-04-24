# Development Guide

This guide covers local checks and the high-level code layout.

## Quality checks

Run the human-facing docs lint:

```bash
npm run lint:docs
```

Run the Node build and tests:

```bash
npm test
```

Check the Python post-processor for syntax errors:

```bash
python3 -m py_compile post/process.py
```

## CI

The repository includes a GitHub Actions workflow at
`.github/workflows/ci.yml`.

Its step names use `Lint ...` and `Test ...` prefixes so they align with the
reporting conventions used in `../ahara`.

## Architecture

```text
illuminator/
├── src/
│   ├── types.ts
│   ├── palette.ts
│   ├── preset-registry.ts
│   ├── parse-pack.ts
│   ├── claude-formatter.ts
│   ├── bfl-client.ts
│   ├── generate.ts
│   ├── png-metadata.ts
│   ├── validation.ts
│   └── cli.ts
├── src/presets/
│   └── glacial-archive.ts
├── post/
│   ├── process.py
│   └── requirements.txt
├── docs/
├── examples/
│   └── field-kit/
│       ├── pack.toml
│       └── prompts/
└── test/
```

## Main code paths

- `src/parse-pack.ts`: parses `pack.toml`, resolves prompt files, named
  styles, named palettes, and type prompt fragments
- `src/generate.ts`: orchestrates pack loading, Claude formatting, BFL
  generation, raw PNG metadata embedding, and sidecar writes
- `src/png-metadata.ts`: embeds provenance metadata in generated PNGs
- `src/claude-formatter.ts`: builds the Claude prompt template and parses the
  Flux 2 JSON response
- `src/bfl-client.ts`: submits, polls, and downloads images from BFL
- `post/process.py`: post-processes raw PNG outputs by asset type, embeds
  processed PNG metadata, and builds sprite/icon atlases

## Example pack

A minimal demo pack exercising the full format (both prompt forms, a
named style override, a named palette override, a type prompt fragment)
lives at:

- [examples/field-kit/pack.toml](../examples/field-kit/pack.toml)

Its prompt Markdown lives under:

- `examples/field-kit/prompts/`

For a full production pack consuming this tool, see the sibling
`the-canonry-game` repository (`illumination/pack.toml`).

## Notes

- Prompt Markdown in `examples/` is input data, not prose documentation.
- The docs lint intentionally targets `README.md` and `docs/**/*.md`.
