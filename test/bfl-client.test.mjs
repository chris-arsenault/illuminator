import test from "node:test";
import assert from "node:assert/strict";
import { buildRequestBody } from "../dist/bfl-client.js";

test("buildRequestBody sends Flux 1.1 Ultra prompts as plain text", () => {
  const body = buildRequestBody("flux-pro-1.1-ultra", {
    prompt: "ink watercolor raven on a brass compass",
    size: "1024x1024",
    aspect: "1:1",
  });

  assert.equal(body.prompt, "ink watercolor raven on a brass compass");
  assert.equal(body.aspect_ratio, "1:1");
  assert.equal(body.width, undefined);
  assert.equal(body.height, undefined);
});

test("buildRequestBody stringifies Flux 2 JSON prompts", () => {
  const prompt = {
    scene: "ink watercolor raven on a brass compass",
    subjects: [],
  };
  const body = buildRequestBody("flux-2-pro", {
    prompt,
    size: "1024x1024",
  });

  assert.equal(body.prompt, JSON.stringify(prompt));
  assert.equal(body.width, 1024);
  assert.equal(body.height, 1024);
});

test("buildRequestBody enables raw flag for Flux 1.1 Ultra raw variant", () => {
  const body = buildRequestBody("flux-pro-1.1-ultra-raw", {
    prompt: "documentary photo of windswept ruins",
    size: "1152x864",
    aspect: "4:3",
  });

  assert.equal(body.prompt, "documentary photo of windswept ruins");
  assert.equal(body.aspect_ratio, "4:3");
  assert.equal(body.raw, true);
});
