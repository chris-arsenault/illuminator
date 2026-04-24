import test from "node:test";
import assert from "node:assert/strict";
import { buildRawPngMetadata, embedPngMetadata } from "../dist/png-metadata.js";

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nX2IAAAAASUVORK5CYII=",
  "base64",
);

test("buildRawPngMetadata derives stable provenance fields", () => {
  const metadata = buildRawPngMetadata({
    pack_title: "Field Kit",
    preset: "glacial-archive",
    spec_id: "owl",
    file: "sprites/owl.png",
    spec_type: "sprite",
    section_id: "specimens",
    section: "Specimens",
    style_id: "refined",
    palette_id: "glacial-archive",
    model: "flux-2-pro",
    size: "1024x1024",
    aspect: "1:1",
    prompt_fragment: "Sprite guidance.",
    raw_description: "An owl perched on a branch.",
    formatted_prompt: { scene: "scene", subjects: [] },
    bfl_task_id: "task_123",
    cost_usd: 0.1,
    claude_cost_usd: 0.01,
    duration_ms: 1234,
    generated_at: "2026-04-24T00:00:00Z",
  });

  assert.equal(metadata.stage, "raw");
  assert.equal(metadata.output_file, "sprites/owl.png");
  assert.equal(metadata.preset, "glacial-archive");
  assert.match(metadata.raw_description_sha256, /^[a-f0-9]{64}$/);
  assert.match(metadata.formatted_prompt_sha256, /^[a-f0-9]{64}$/);
  assert.match(metadata.prompt_fragment_sha256, /^[a-f0-9]{64}$/);
});

test("embedPngMetadata inserts an iTXt chunk before IEND", () => {
  const metadata = {
    schema: "illuminator/provenance@1",
    stage: "raw",
    output_file: "sprites/owl.png",
  };

  const output = embedPngMetadata(ONE_BY_ONE_PNG, metadata);
  const parsed = readPngChunks(output);
  const textChunk = parsed.find((chunk) => chunk.type === "iTXt");

  assert.ok(textChunk, "expected an iTXt chunk");
  assert.equal(parsed.at(-1)?.type, "IEND");
  assert.deepEqual(parseITXtPayload(textChunk.data), metadata);
});

function readPngChunks(buffer) {
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += length + 12;
  }
  return chunks;
}

function parseITXtPayload(data) {
  const keywordEnd = data.indexOf(0);
  assert.notEqual(keywordEnd, -1);
  const text = data.subarray(keywordEnd + 5).toString("utf8");
  return JSON.parse(text);
}
