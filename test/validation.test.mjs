import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CONCURRENCY,
  parseBoundedIntegerFlag,
  resolveSafeOutputPath,
  validateAspectRatio,
  validateRenderSize,
} from "../dist/validation.js";

test("validateAspectRatio reduces ratios to canonical form", () => {
  assert.equal(validateAspectRatio("1024:768"), "4:3");
});

test("validateRenderSize rejects non-multiple-of-16 dimensions", () => {
  assert.throws(
    () => validateRenderSize("1025x1024"),
    /multiple of 16/i,
  );
});

test("resolveSafeOutputPath keeps writes inside the output root", () => {
  const safe = resolveSafeOutputPath("/tmp/raw", "sprites/penguin.png");
  assert.equal(safe, "/tmp/raw/sprites/penguin.png");
  assert.throws(
    () => resolveSafeOutputPath("/tmp/raw", "../escape.png"),
    /must not contain empty, '\.' or '\.\.' path segments/i,
  );
});

test("parseBoundedIntegerFlag enforces the concurrency ceiling", () => {
  assert.equal(
    parseBoundedIntegerFlag(String(MAX_CONCURRENCY), "--concurrency", {
      min: 1,
      max: MAX_CONCURRENCY,
    }),
    MAX_CONCURRENCY,
  );
  assert.throws(
    () =>
      parseBoundedIntegerFlag(String(MAX_CONCURRENCY + 1), "--concurrency", {
        min: 1,
        max: MAX_CONCURRENCY,
      }),
    /at most/i,
  );
});
