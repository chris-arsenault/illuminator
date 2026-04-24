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

const USAGE = `illuminator — generate illustrations from a spec document.

Usage:
  illuminator generate <spec.md> [options]
  illuminator process <raw-dir> <out-dir>
  illuminator presets
  illuminator --help

generate options:
  --out <dir>           Output directory for raw PNGs (default: ./raw)
  --section <name>      Only generate assets whose section contains this text
  --limit <n>           Limit to N assets — picks round-robin across sections
  --smoke-test          Alias for --limit 3
  --dry-run             Parse + format + validate, skip BFL generation
  --preview             Print formatted Flux 2 JSON to stdout, skip everything else
  --model <id>          Override model from spec (e.g. flux-2-pro, flux-2-max)
  --concurrency <n>     Parallelism for formatting/generation (1-${MAX_CONCURRENCY}, default: 1)

Environment:
  BFL_API_KEY           Required for BFL image generation
  ANTHROPIC_API_KEY     Required for Claude prompt formatting
  CLAUDE_API_KEY        Fallback alias for ANTHROPIC_API_KEY

process: runs the Python post-processor (post/process.py) against the
raw directory and writes finished assets to out-dir. Requires python3 with
rembg, Pillow, and click installed — see post/requirements.txt.

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
  const booleanFlags = new Set(["dry-run", "preview", "smoke-test"]);
  const valueFlags = new Set(["out", "section", "limit", "model", "concurrency"]);

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
    failUsage("generate: missing <spec.md>");
  }
  if (positional.length > 1) {
    failUsage("generate: expected exactly one <spec.md> path.");
  }
  if (bools.has("dry-run") && bools.has("preview")) {
    failUsage("generate: --dry-run and --preview cannot be used together.");
  }

  const specPath = resolve(process.cwd(), positional[0]);
  const outDir = resolve(
    process.cwd(),
    flags.get("out") ?? "raw",
  );

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

  if (!previewOnly && !dryRun && !bflApiKey) {
    console.error(
      "error: BFL_API_KEY is not set. Export it or use --dry-run / --preview.",
    );
    process.exit(2);
  }
  // Claude is only needed when we actually call it: --preview and real runs.
  if (!dryRun && !anthropicApiKey) {
    console.error(
      "error: ANTHROPIC_API_KEY is not set. Claude formatting is required.",
    );
      process.exit(2);
  }

  const summary = await generate({
    specPath,
    outDir,
    section: flags.get("section"),
    limit,
    dryRun,
    previewOnly,
    modelOverride,
    concurrency,
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
  console.log(`Finished: ${summary.successes.length} succeeded, ${summary.failures.length} failed`);
  console.log(`Total cost: $${summary.total_cost_usd.toFixed(4)}`);
  console.log(`Duration: ${(summary.duration_ms / 1000).toFixed(1)}s`);
  if (summary.failures.length > 0) {
    console.log("\nFailures:");
    for (const f of summary.failures) {
      console.log(`  ${f.spec.id}: ${f.error}`);
    }
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
