import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BflClient } from "./bfl-client.js";
import { ClaudeFormatter } from "./claude-formatter.js";
import { getPreset } from "./preset-registry.js";
import { parseSpec } from "./parse-spec.js";
import {
  MAX_CONCURRENCY,
  parseBoundedIntegerFlag,
  resolveSafeOutputPath,
} from "./validation.js";
import type {
  AssetSpec,
  GenerationRecord,
} from "./types.js";

export interface GenerateOptions {
  /** Absolute path to the spec markdown file. */
  specPath: string;
  /** Absolute path to the raw output directory. */
  outDir: string;
  /** Filter to this section name (case-insensitive substring match). */
  section?: string;
  /** Limit to at most N assets (smoke test). Picks one-per-section when possible. */
  limit?: number;
  /** Skip API calls — print what would happen. */
  dryRun?: boolean;
  /** Only print formatted Claude outputs; no BFL calls, no disk writes. */
  previewOnly?: boolean;
  /** Override the model from the spec settings. */
  modelOverride?: string;
  /** Number of assets to process in parallel. */
  concurrency?: number;
  /** Anthropic API key. */
  anthropicApiKey: string;
  /** BFL API key. */
  bflApiKey: string;
  /** Progress callback — invoked after each spec completes or fails. */
  onProgress?: (event: ProgressEvent) => void;
}

export type ProgressEvent =
  | { kind: "start"; total: number }
  | { kind: "formatting"; spec: AssetSpec; index: number; total: number }
  | { kind: "generating"; spec: AssetSpec; index: number; total: number }
  | {
      kind: "done";
      spec: AssetSpec;
      index: number;
      total: number;
      record: GenerationRecord;
    }
  | {
      kind: "error";
      spec: AssetSpec;
      index: number;
      total: number;
      error: string;
    }
  | {
      kind: "complete";
      successes: number;
      failures: number;
      total_cost_usd: number;
      duration_ms: number;
    };

export interface GenerateSummary {
  successes: GenerationRecord[];
  failures: Array<{ spec: AssetSpec; error: string }>;
  total_cost_usd: number;
  duration_ms: number;
}

export async function generate(
  opts: GenerateOptions,
): Promise<GenerateSummary> {
  const source = await readFile(opts.specPath, "utf8");
  const doc = parseSpec(source);
  const preset = getPreset(doc.settings.preset);
  const model = opts.modelOverride ?? doc.settings.model;

  const filtered = filterSpecs(doc.specs, opts.section, opts.limit);
  const concurrency = parseBoundedIntegerFlag(
    String(opts.concurrency ?? 1),
    "concurrency",
    { min: 1, max: MAX_CONCURRENCY },
  );

  opts.onProgress?.({ kind: "start", total: filtered.length });

  const successes: GenerationRecord[] = [];
  const failures: Array<{ spec: AssetSpec; error: string }> = [];
  const previewOutputs = new Array<string | undefined>(filtered.length);
  const batchStart = Date.now();

  // Claude formatter + BFL client are reused across all specs so prompt
  // caching on the Claude system prompt can kick in from the second call.
  const formatter = new ClaudeFormatter({
    apiKey: opts.anthropicApiKey,
    style: preset.style,
    palette: preset.palette,
  });
  const bfl = new BflClient({
    apiKey: opts.bflApiKey,
    model,
  });

  let nextIndex = 0;
  const processOne = async (spec: AssetSpec, index: number): Promise<void> => {
    try {
      if (opts.dryRun) {
        // No API calls at all — just confirm the spec parses and is valid.
        const record = buildRecord({
          spec,
          fmt: {
            prompt: { scene: "(dry-run)", subjects: [] },
            cost_usd: 0,
          },
          model,
          taskId: "(dry-run)",
          bflCostUsd: 0,
          durationMs: 0,
        });
        successes.push(record);
        opts.onProgress?.({
          kind: "done",
          spec,
          index,
          total: filtered.length,
          record,
        });
        return;
      }

      opts.onProgress?.({
        kind: "formatting",
        spec,
        index,
        total: filtered.length,
      });

      const fmt = await formatter.format(spec.description, {
        aspectHint: spec.aspect,
        fileHint: spec.file,
      });

      if (opts.previewOnly) {
        previewOutputs[index] = buildPreviewOutput(spec, fmt.prompt);
        return;
      }

      opts.onProgress?.({
        kind: "generating",
        spec,
        index,
        total: filtered.length,
      });

      const bflResult = await bfl.generate({
        prompt: fmt.prompt,
        size: spec.size,
        aspect: spec.aspect,
      });

      // Write the PNG to disk at its target path inside the raw output dir.
      const pngPath = resolveSafeOutputPath(
        opts.outDir,
        spec.file,
        `asset "${spec.id}" output path`,
      );
      await mkdir(dirname(pngPath), { recursive: true });
      await writeFile(pngPath, bflResult.image);

      const record = buildRecord({
        spec,
        fmt,
        model,
        taskId: bflResult.task_id,
        bflCostUsd: bflResult.cost_usd,
        durationMs: bflResult.duration_ms,
      });

      // Sidecar JSON — complete reproducibility record next to each PNG.
      const jsonPath = `${pngPath.slice(0, -4)}.json`;
      await writeFile(jsonPath, JSON.stringify(record, null, 2));

      successes.push(record);
      opts.onProgress?.({
        kind: "done",
        spec,
        index,
        total: filtered.length,
        record,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ spec, error: msg });
      opts.onProgress?.({
        kind: "error",
        spec,
        index,
        total: filtered.length,
        error: msg,
      });
    }
  };

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex++;
      if (index >= filtered.length) return;
      await processOne(filtered[index], index);
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(filtered.length, 1)) },
      () => worker(),
    ),
  );

  if (opts.previewOnly) {
    for (const preview of previewOutputs) {
      if (preview) console.log(preview);
    }
  }

  const total_cost_usd = successes.reduce(
    (sum, r) => sum + r.cost_usd + r.claude_cost_usd,
    0,
  );

  const duration_ms = Date.now() - batchStart;

  opts.onProgress?.({
    kind: "complete",
    successes: successes.length,
    failures: failures.length,
    total_cost_usd,
    duration_ms,
  });

  return { successes, failures, total_cost_usd, duration_ms };
}

function filterSpecs(
  specs: AssetSpec[],
  section: string | undefined,
  limit: number | undefined,
): AssetSpec[] {
  let filtered = specs;
  if (section) {
    const needle = section.toLowerCase();
    filtered = filtered.filter((s) =>
      s.section.toLowerCase().includes(needle),
    );
  }
  if (limit !== undefined && limit > 0 && limit < filtered.length) {
    // Pick one per section where possible, then fill up.
    filtered = pickSampleAcrossSections(filtered, limit);
  }
  return filtered;
}

function pickSampleAcrossSections(
  specs: AssetSpec[],
  limit: number,
): AssetSpec[] {
  const bySection = new Map<string, AssetSpec[]>();
  for (const s of specs) {
    const arr = bySection.get(s.section) ?? [];
    arr.push(s);
    bySection.set(s.section, arr);
  }

  const picked: AssetSpec[] = [];
  // Round-robin one from each section first.
  const sections = [...bySection.keys()];
  let round = 0;
  while (picked.length < limit) {
    let pickedThisRound = 0;
    for (const section of sections) {
      if (picked.length >= limit) break;
      const bucket = bySection.get(section)!;
      if (round < bucket.length) {
        picked.push(bucket[round]);
        pickedThisRound++;
      }
    }
    if (pickedThisRound === 0) break;
    round++;
  }
  return picked;
}

function buildRecord(args: {
  spec: AssetSpec;
  fmt: { prompt: import("./types.js").FluxJsonPrompt; cost_usd: number };
  model: string;
  taskId: string;
  bflCostUsd: number;
  durationMs: number;
}): GenerationRecord {
  return {
    spec_id: args.spec.id,
    file: args.spec.file,
    spec_type: args.spec.type,
    section: args.spec.section,
    model: args.model,
    size: args.spec.size,
    aspect: args.spec.aspect,
    raw_description: args.spec.description,
    formatted_prompt: args.fmt.prompt,
    bfl_task_id: args.taskId,
    cost_usd: args.bflCostUsd,
    claude_cost_usd: args.fmt.cost_usd,
    duration_ms: args.durationMs,
    generated_at: new Date().toISOString(),
  };
}

function buildPreviewOutput(
  spec: AssetSpec,
  prompt: import("./types.js").FluxJsonPrompt,
): string {
  return `\n--- ${spec.id} (${spec.file}) ---\n${JSON.stringify(prompt, null, 2)}`;
}
