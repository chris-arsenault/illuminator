import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
