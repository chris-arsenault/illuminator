import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const cliPath = join(repoRoot, "dist", "cli.js");
const packPath = join(repoRoot, "examples", "field-kit");

test("cli accepts --concurrency during dry-run", () => {
  const result = spawnSync(
    process.execPath,
    [cliPath, "generate", packPath, "--dry-run", "--concurrency", "2"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Finished: 5 succeeded, 0 failed/);
});

test("generate defaults to missing raw assets and --reprocess regenerates selected assets", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "illuminator-out-"));
  const existingRaw = join(outDir, "raw", "sprites", "owl.png");
  await mkdir(dirname(existingRaw), { recursive: true });
  await writeFile(existingRaw, "already generated");

  const defaultResult = spawnSync(
    process.execPath,
    [cliPath, "generate", packPath, "--dry-run", "--out", outDir],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.match(defaultResult.stdout, /Skipped 1 existing raw asset\(s\)/);
  assert.match(defaultResult.stdout, /Finished: 4 succeeded, 0 failed/);

  const reprocessResult = spawnSync(
    process.execPath,
    [
      cliPath,
      "generate",
      packPath,
      "--dry-run",
      "--out",
      outDir,
      "--reprocess",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  assert.equal(reprocessResult.status, 0, reprocessResult.stderr);
  assert.doesNotMatch(reprocessResult.stdout, /Skipped 1 existing raw asset\(s\)/);
  assert.match(reprocessResult.stdout, /Finished: 5 succeeded, 0 failed/);
});

test("generate applies existing-output filtering after section and asset filters", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "illuminator-out-"));
  const existingRaw = join(outDir, "raw", "icons", "compass.png");
  await mkdir(dirname(existingRaw), { recursive: true });
  await writeFile(existingRaw, "already generated");

  const sectionResult = spawnSync(
    process.execPath,
    [cliPath, "generate", packPath, "--dry-run", "--out", outDir, "--section", "icons"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  assert.equal(sectionResult.status, 0, sectionResult.stderr);
  assert.match(sectionResult.stdout, /Skipped 1 existing raw asset\(s\)/);
  assert.match(sectionResult.stdout, /Finished: 2 succeeded, 0 failed/);

  const assetResult = spawnSync(
    process.execPath,
    [cliPath, "generate", packPath, "--dry-run", "--out", outDir, "--asset", "compass"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  assert.equal(assetResult.status, 0, assetResult.stderr);
  assert.match(assetResult.stdout, /Skipped 1 existing raw asset\(s\)/);
  assert.match(assetResult.stdout, /Finished: 0 succeeded, 0 failed/);

  const reprocessResult = spawnSync(
    process.execPath,
    [
      cliPath,
      "generate",
      packPath,
      "--dry-run",
      "--out",
      outDir,
      "--section",
      "icons",
      "--asset",
      "compass",
      "--reprocess",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  assert.equal(reprocessResult.status, 0, reprocessResult.stderr);
  assert.doesNotMatch(reprocessResult.stdout, /Skipped 1 existing raw asset\(s\)/);
  assert.match(reprocessResult.stdout, /Finished: 1 succeeded, 0 failed/);
});

test("generate no-ops without API keys when all selected raw assets exist", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "illuminator-out-"));
  for (const file of [
    "sprites/owl.png",
    "sprites/lantern.png",
    "icons/compass.png",
    "icons/flame.png",
    "icons/key.png",
  ]) {
    const existingRaw = join(outDir, "raw", file);
    await mkdir(dirname(existingRaw), { recursive: true });
    await writeFile(existingRaw, "already generated");
  }

  const result = spawnSync(
    process.execPath,
    [cliPath, "generate", packPath, "--out", outDir],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "",
        BFL_API_KEY: "",
        CLAUDE_API_KEY: "",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Skipped 5 existing raw asset\(s\)/);
  assert.match(result.stdout, /Finished: 0 succeeded, 0 failed/);
});

test("cli rejects unknown flags", () => {
  const result = spawnSync(
    process.execPath,
    [cliPath, "generate", packPath, "--dry-run", "--bogus"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /unknown option --bogus/i);
});
