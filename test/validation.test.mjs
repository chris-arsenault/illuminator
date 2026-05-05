import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CONCURRENCY,
  getFluxGeneration,
  getImageProvider,
  getOpenAiModelFamily,
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

test("getFluxGeneration classifies Flux 1.1 Ultra separately from Flux 2", () => {
  assert.equal(getFluxGeneration("flux-pro-1.1-ultra"), "flux-1");
  assert.equal(getFluxGeneration("flux-pro-1.1-ultra-raw"), "flux-1");
  assert.equal(getFluxGeneration("flux-2-pro"), "flux-2");
});

test("image model helpers classify OpenAI image models", () => {
  assert.equal(getImageProvider("gpt-image-1.5"), "openai");
  assert.equal(getImageProvider("dall-e-3"), "openai");
  assert.equal(getImageProvider("flux-2-pro"), "bfl");
  assert.equal(getOpenAiModelFamily("gpt-image-1"), "gpt-image");
  assert.equal(getOpenAiModelFamily("dall-e-2"), "dall-e-2");
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
