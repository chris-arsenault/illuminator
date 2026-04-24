import test from "node:test";
import assert from "node:assert/strict";
import { parseSpec } from "../dist/parse-spec.js";

const VALID_SPEC = `# Demo

<!-- settings -->
preset: glacial-archive
model: flux-2-pro
default_size: 1024x1024
default_aspect: 1:1
<!-- /settings -->

## Sprites

### penguin
file: sprites\\penguin.png
type: sprite

A valid description.
`;

test("parseSpec normalizes Windows-style relative output paths", () => {
  const doc = parseSpec(VALID_SPEC);
  assert.equal(doc.specs[0].file, "sprites/penguin.png");
});

test("parseSpec rejects output path traversal", () => {
  assert.throws(
    () =>
      parseSpec(
        VALID_SPEC.replace("sprites\\penguin.png", "../escape.png"),
      ),
    /must not contain empty, '\.' or '\.\.' path segments/i,
  );
});

test("parseSpec rejects duplicate output files", () => {
  const src = `${VALID_SPEC}
### penguin-2
file: sprites/penguin.png
type: sprite

Another valid description.
`;

  assert.throws(() => parseSpec(src), /Duplicate asset output path/i);
});

test("parseSpec rejects empty descriptions", () => {
  const src = VALID_SPEC.replace("A valid description.", "");
  assert.throws(() => parseSpec(src), /missing a description/i);
});

test("parseSpec rejects unsupported models", () => {
  const src = VALID_SPEC.replace("model: flux-2-pro", "model: flux-1-unknown");
  assert.throws(() => parseSpec(src), /settings\.model must be one of/i);
});
