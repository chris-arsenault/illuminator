# LUT Sources

Illuminator supports optional `.cube` LUT experiments in `post/process.py`, but
third-party LUT payloads must stay out of git. The local cache path is:

```text
third_party/luts/
```

That directory is ignored by `.gitignore`.

## Q-DDL CC BY 4.0 LUTs

The current local cache uses the Q-DDL color LUT collection:

- license: Creative Commons Attribution 4.0 International
- format: `.cube`
- count: 856 LUTs across cinematic, color grading, color moods, and film
  simulation packs
- original source: Q-DDL / Quick-DDL
- current mirror: Photoshoplus, because `quickddl.net` no longer resolves

Download or refresh the local cache with:

```bash
scripts/fetch-qddl-luts.sh
```

The script writes archives and extracted LUTs under:

```text
third_party/luts/q-ddl/
```

It also writes local metadata beside the ignored payloads:

```text
third_party/luts/q-ddl/SOURCE.json
third_party/luts/q-ddl/catalog.json
third_party/luts/q-ddl/catalog.csv
third_party/luts/q-ddl/washed-out-shortlist.csv
```

`catalog.json` is the machine-readable catalog. `catalog.csv` is for browsing
in a spreadsheet. `washed-out-shortlist.csv` ranks LUTs that actually increase
saturation and are therefore plausible recovery candidates for pale Flux
renders.

Each catalog entry includes:

- source, creator, license, attribution, and reference URLs
- category and Q-DDL pack
- title, stable id, local path, file size, and SHA-256
- LUT size and domain
- computed behavior: look strength, exposure delta, contrast ratio,
  saturation ratio, warmth/coolness, green/magenta shift, black lift, highlight
  shift, clipping fractions, and washed-out recovery score
- derived tags such as `saturation-boost`, `higher-contrast`, `warm`,
  `cool`, `lifted-blacks`, `highlight-rolloff`, and
  `washed-out-recovery-candidate`

Regenerate only the metadata with:

```bash
scripts/catalog-luts.py third_party/luts/q-ddl
```

Use one LUT at a time while evaluating pack cohesion:

```bash
LUT="third_party/luts/q-ddl/extracted/Q-DDL Color LUTs - Color Grading/Q-DDL_Pack_9_s5493/Q-DDL_Pack_9/Dunn.cube"

python3 post/process.py examples/field-kit/output/raw examples/field-kit/output/processed \
  --lut "$LUT" \
  --lut-strength 0.25
```

When sharing a workflow, credit Q-DDL and link to the source page or mirror.
Do not commit the downloaded `.zip` or `.cube` files to this repository.
