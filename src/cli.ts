#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generate } from "./generate.js";
import { listPresets } from "./preset-registry.js";
import {
  MAX_CONCURRENCY,
  parseBoundedIntegerFlag,
  validateModelId,
} from "./validation.js";
import type { ProgressEvent } from "./generate.js";

const USAGE = `illuminator — generate illustrations from a TOML pack.

Usage:
  illuminator generate <pack.toml|dir> [options]
  illuminator process <raw-dir> <out-dir>
  illuminator presets
  illuminator --help

generate options:
  --out <dir>           Container directory for outputs. Raw PNGs go to
                        <out>/raw, processed assets to <out>/processed.
                        Defaults to <pack-dir>/output.
  --section <name>      Only generate assets whose section id/title matches
  --asset <id[,id…]>    Only generate these asset ids (comma-separated, exact
                        match against AssetSpec.id). Combines with --section
                        and bypasses --limit's round-robin.
  --limit <n>           Limit to N assets — picks round-robin across sections
  --smoke-test          Alias for --limit 3
  --reprocess           Regenerate selected assets even when raw PNGs already
                        exist. By default, only missing raw assets are run.
  --dry-run             Parse + validate only, skip Claude and BFL
  --preview             Print formatted Flux 2 JSON to stdout, skip everything else
  --model <id>          Override model from pack (e.g. flux-2-pro, flux-2-max)
  --concurrency <n>     Parallelism for formatting/generation (1-${MAX_CONCURRENCY}, default: 1)
  --and-process         Run the Python post-processor on generated raw/ assets
                        immediately after generation. Uses --concurrency for
                        internal parallelism; atlases built at the end.

Environment:
  BFL_API_KEY           Required for BFL image generation
  ANTHROPIC_API_KEY     Required for Claude prompt formatting
  CLAUDE_API_KEY        Fallback alias for ANTHROPIC_API_KEY

process: runs the Python post-processor (post/process.py) against the
raw directory and writes finished assets to out-dir. It embeds provenance
metadata in output PNGs, applies automatic cutout policies by asset type,
and builds sprite/icon atlases. Requires python3 with rembg, Pillow, and
click installed — see post/requirements.txt.

presets: list available style presets.
`;

async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }

  const command = args[0];

  switch (command) {
    case "generate":
      await runGenerate(args.slice(1));
      return;
    case "process":
      await runProcess(args.slice(1));
      return;
    case "presets":
      for (const id of listPresets()) console.log(id);
      return;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      process.exit(2);
  }
}

async function runGenerate(args: string[]): Promise<void> {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const booleanFlags = new Set([
    "dry-run",
    "preview",
    "smoke-test",
    "and-process",
    "reprocess",
  ]);
  const valueFlags = new Set(["out", "section", "asset", "limit", "model", "concurrency"]);

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const nextValue = args[i + 1];

      if (booleanFlags.has(name)) {
        bools.add(name);
        continue;
      }
      if (!valueFlags.has(name)) {
        failUsage(`generate: unknown option --${name}`);
      }
      if (!nextValue || nextValue.startsWith("--")) {
        failUsage(`generate: option --${name} requires a value.`);
      }
      flags.set(name, nextValue);
      i++;
    } else {
      positional.push(a);
    }
  }

  if (positional.length === 0) {
    failUsage("generate: missing <pack.toml|dir>");
  }
  if (positional.length > 1) {
    failUsage("generate: expected exactly one <pack.toml|dir> argument.");
  }
  if (bools.has("dry-run") && bools.has("preview")) {
    failUsage("generate: --dry-run and --preview cannot be used together.");
  }

  const packPath = resolve(process.cwd(), positional[0]);
  // Resolve --out to absolute path iff provided; otherwise leave undefined so
  // the generator defaults it to <pack-dir>/output.
  const outDir = flags.has("out")
    ? resolve(process.cwd(), flags.get("out")!)
    : undefined;

  const anthropicApiKey =
    process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "";
  const bflApiKey = process.env.BFL_API_KEY || "";

  const dryRun = bools.has("dry-run");
  const previewOnly = bools.has("preview");
  const limit = bools.has("smoke-test")
    ? 3
    : flags.has("limit")
      ? parseBoundedIntegerFlag(flags.get("limit")!, "--limit", { min: 1 })
      : undefined;
  const concurrency = flags.has("concurrency")
    ? parseBoundedIntegerFlag(flags.get("concurrency")!, "--concurrency", {
        min: 1,
        max: MAX_CONCURRENCY,
      })
    : 1;
  const modelOverride = flags.has("model")
    ? validateModelId(flags.get("model")!, "--model")
    : undefined;

  const summary = await generate({
    packPath,
    outDir,
    section: flags.get("section"),
    asset: flags.get("asset"),
    limit,
    dryRun,
    previewOnly,
    modelOverride,
    concurrency,
    andProcess: bools.has("and-process"),
    reprocess: bools.has("reprocess"),
    anthropicApiKey,
    bflApiKey,
    onProgress: logProgress,
  });

  if (previewOnly) {
    if (summary.failures.length > 0) {
      console.log("\nPreview failures:");
      for (const f of summary.failures) {
        console.log(`  ${f.spec.id}: ${f.error}`);
      }
      process.exit(1);
    }
    return;
  }

  console.log("");
  if (summary.skippedExisting > 0) {
    console.log(
      `Skipped ${summary.skippedExisting} existing raw asset(s); use --reprocess to regenerate.`,
    );
  }
  console.log(`Finished: ${summary.successes.length} succeeded, ${summary.failures.length} failed`);
  console.log(`Total cost: $${summary.total_cost_usd.toFixed(4)}`);
  console.log(`Duration: ${(summary.duration_ms / 1000).toFixed(1)}s`);
  console.log(`Raw output: ${summary.rawDir}`);
  if (summary.processedDir) {
    const pp = summary.postProcess;
    const ppDuration = pp ? ` (${(pp.duration_ms / 1000).toFixed(1)}s)` : "";
    console.log(`Processed output: ${summary.processedDir}${ppDuration}`);
  }
  if (summary.failures.length > 0) {
    console.log("\nFailures:");
    for (const f of summary.failures) {
      console.log(`  ${f.spec.id}: ${f.error}`);
    }
    process.exit(1);
  }
  if (summary.postProcess && summary.postProcess.exit_code !== 0) {
    console.error(
      `\nPost-processor exited with code ${summary.postProcess.exit_code}.`,
    );
    process.exit(1);
  }
}

function logProgress(event: ProgressEvent): void {
  switch (event.kind) {
    case "start":
      console.log(`Generating ${event.total} asset(s)…`);
      return;
    case "formatting":
      console.log(
        `  [${event.index + 1}/${event.total}] ${event.spec.id} - formatting`,
      );
      return;
    case "generating":
      console.log(
        `  [${event.index + 1}/${event.total}] ${event.spec.id} - generating`,
      );
      return;
    case "done":
      console.log(
        `  [${event.index + 1}/${event.total}] ${event.spec.id} - done (${(
          event.record.duration_ms / 1000
        ).toFixed(1)}s, $${(
          event.record.cost_usd + event.record.claude_cost_usd
        ).toFixed(4)})`,
      );
      return;
    case "error":
      console.log(
        `  [${event.index + 1}/${event.total}] ${event.spec.id} - failed`,
      );
      console.log(`    ${event.error}`);
      return;
    case "complete":
      return;
  }
}

async function runProcess(args: string[]): Promise<void> {
  if (args.length < 2) {
    failUsage("process: expected <raw-dir> <out-dir>");
  }
  if (args.length > 2) {
    failUsage("process: unexpected extra arguments.");
  }
  const rawDir = resolve(process.cwd(), args[0]);
  const outDir = resolve(process.cwd(), args[1]);

  // post/process.py lives relative to this file in the built output.
  const here = fileURLToPath(import.meta.url);
  const scriptPath = resolve(dirname(here), "../post/process.py");

  await new Promise<void>((resolveFn, rejectFn) => {
    const child = spawn(
      "python3",
      [scriptPath, rawDir, outDir],
      { stdio: "inherit" },
    );
    child.on("close", (code) => {
      if (code === 0) resolveFn();
      else rejectFn(new Error(`python3 exited with code ${code}`));
    });
    child.on("error", rejectFn);
  });
}

main(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

function failUsage(message: string): never {
  console.error(message);
  process.exit(2);
}
