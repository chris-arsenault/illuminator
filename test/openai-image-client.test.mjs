import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenAiImageRequestBody } from "../dist/openai-image-client.js";

test("buildOpenAiImageRequestBody builds GPT Image requests", () => {
  const body = buildOpenAiImageRequestBody("gpt-image-1.5", {
    prompt: "ink watercolor compass icon",
    size: "1536x1024",
    quality: "standard",
  });

  assert.equal(body.model, "gpt-image-1.5");
  assert.equal(body.prompt, "ink watercolor compass icon");
  assert.equal(body.size, "1536x1024");
  assert.equal(body.quality, "medium");
  assert.equal(body.response_format, undefined);
});

test("buildOpenAiImageRequestBody builds DALL-E requests", () => {
  const body = buildOpenAiImageRequestBody("dall-e-3", {
    prompt: "ink watercolor compass icon",
    size: "1792x1024",
    quality: "high",
  });

  assert.equal(body.model, "dall-e-3");
  assert.equal(body.size, "1792x1024");
  assert.equal(body.quality, "hd");
  assert.equal(body.response_format, "b64_json");
});

test("buildOpenAiImageRequestBody rejects Flux JSON prompts", () => {
  assert.throws(
    () => buildOpenAiImageRequestBody("gpt-image-1", {
      prompt: { scene: "scene", subjects: [] },
      size: "1024x1024",
    }),
    /plain text prompt/i,
  );
});
