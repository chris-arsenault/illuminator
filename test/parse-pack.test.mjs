import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadPack } from "../dist/parse-pack.js";

async function createPack(files) {
  const root = await mkdtemp(join(tmpdir(), "illuminator-pack-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

test("loadPack reads prompt files and normalizes output paths", async () => {
  const root = await createPack({
    "pack.toml": `preset = "glacial-archive"
model = "flux-2-pro"

[defaults]
size = "1024x1024"
aspect = "1:1"

[[section]]
id = "sprites"
title = "Entity sprites"

[[section.asset]]
id = "penguin"
file = "sprites\\\\penguin.png"
type = "sprite"
prompt = "prompts/penguin.md"
`,
    "prompts/penguin.md": "A valid description.\n",
  });

  const doc = await loadPack(root);
  assert.equal(doc.specs[0].file, "sprites/penguin.png");
  assert.equal(doc.specs[0].section_id, "sprites");
  assert.equal(doc.specs[0].section, "Entity sprites");
  assert.equal(doc.specs[0].style_id, "glacial-archive");
  assert.equal(doc.specs[0].palette_id, "glacial-archive");
  assert.equal(doc.specs[0].description, "A valid description.");
});

test("loadPack supports inline prompts", async () => {
  const root = await createPack({
    "pack.toml": `title = "Field Kit"
preset = "glacial-archive"

[[section]]
id = "sprites"

[[section.asset]]
id = "penguin"
file = "sprites/penguin.png"
prompt_inline = """
A single adult emperor penguin.
"""
`,
  });

  const doc = await loadPack(join(root, "pack.toml"));
  assert.equal(doc.settings.title, "Field Kit");
  assert.equal(doc.specs[0].description, "A single adult emperor penguin.");
  assert.equal(doc.specs[0].prompt_fragment.includes("sprite"), true);
});

test("loadPack resolves named styles, palettes, and type prompt fragments", async () => {
  const root = await createPack({
    "pack.toml": `preset = "glacial-archive"
default_style = "plate"
default_palette = "polar"

[style.plate]
name = "Plate"
composition = "strictly centered composition"

[style.cinematic]
name = "Cinematic"
composition = "broader framing with stronger depth"

[palette.polar]
name = "Polar"
primary = ["#E7E3D5", "#D97742"]
secondary = ["#19202C", "#2E3A4F"]

[palette.signal]
name = "Signal"
primary = ["#B04646"]
secondary = ["#0B0F14"]

[type_prompt_fragment]
icon = "This icon should have cool edges."

[[section]]
id = "sprites"
style = "plate"
palette = "polar"

[[section.asset]]
id = "penguin"
file = "sprites/penguin.png"
prompt_inline = """
Penguin prompt.
"""

[[section]]
id = "icons"
palette = "signal"

[[section.asset]]
id = "alert-icon"
file = "icons/alert.png"
type = "icon"
style = "cinematic"
prompt_inline = """
Alert icon prompt.
"""
`,
  });

  const doc = await loadPack(root);
  const penguin = doc.specs.find((spec) => spec.id === "penguin");
  const alertIcon = doc.specs.find((spec) => spec.id === "alert-icon");

  assert.equal(doc.settings.default_style, "plate");
  assert.equal(doc.settings.default_palette, "polar");
  assert.equal(doc.styles.plate.composition, "strictly centered composition");
  assert.equal(doc.palettes.signal.primary[0], "#B04646");

  assert.equal(penguin.style_id, "plate");
  assert.equal(penguin.palette_id, "polar");
  assert.match(alertIcon.prompt_fragment, /icon/i);
  assert.match(alertIcon.prompt_fragment, /cool edges/i);
  assert.equal(alertIcon.style_id, "cinematic");
  assert.equal(alertIcon.palette_id, "signal");
});

test("loadPack rejects prompt path traversal", async () => {
  const root = await createPack({
    "pack.toml": `preset = "glacial-archive"

[[section]]
id = "sprites"

[[section.asset]]
id = "penguin"
file = "sprites/penguin.png"
prompt = "../escape.md"
`,
  });

  await assert.rejects(
    () => loadPack(root),
    /must not contain empty, '\.' or '\.\.' path segments/i,
  );
});

test("loadPack rejects assets with both prompt sources", async () => {
  const root = await createPack({
    "pack.toml": `preset = "glacial-archive"

[[section]]
id = "sprites"

[[section.asset]]
id = "penguin"
file = "sprites/penguin.png"
prompt = "prompts/penguin.md"
prompt_inline = """
also inline
"""
`,
    "prompts/penguin.md": "A valid description.\n",
  });

  await assert.rejects(
    () => loadPack(root),
    /must set exactly one of "prompt" or "prompt_inline"/i,
  );
});

test("loadPack rejects unsupported models", async () => {
  const root = await createPack({
    "pack.toml": `preset = "glacial-archive"
model = "flux-1-unknown"

[[section]]
id = "sprites"

[[section.asset]]
id = "penguin"
file = "sprites/penguin.png"
prompt_inline = """
A valid description.
"""
`,
  });

  await assert.rejects(
    () => loadPack(root),
    /pack\.model must be one of/i,
  );
});

test("loadPack leaves identity_id null when no identities are defined", async () => {
  const root = await createPack({
    "pack.toml": `preset = "glacial-archive"

[[section]]
id = "sprites"

[[section.asset]]
id = "penguin"
file = "sprites/penguin.png"
prompt_inline = """
A valid description.
"""
`,
  });

  const doc = await loadPack(root);
  assert.equal(doc.specs[0].identity_id, null);
  assert.deepEqual(doc.identities, {});
  assert.equal(doc.settings.default_identity, null);
});

test("loadPack resolves identity inheritance: asset > section > default", async () => {
  const root = await createPack({
    "pack.toml": `preset = "glacial-archive"
default_identity = "aurora-stack"

[identity.aurora-stack]
name = "Aurora Stack"
description = "Pale ice-plate penguins of the crystalline spires."

[identity.nightshelf]
name = "Nightshelf"
description = "Charcoal-wrapped tunnel penguins with ember-thread regalia."

[identity.orca]
name = "Orca"
description = "Ritual-scarred wake-singers of the Corpse Current."

[[section]]
id = "aurora"

[[section.asset]]
id = "aurora-general"
file = "sprites/aurora-general.png"
prompt_inline = """
An Aurora general.
"""

[[section]]
id = "nightshelf"
identity = "nightshelf"

[[section.asset]]
id = "nightshelf-broker"
file = "sprites/nightshelf-broker.png"
prompt_inline = """
A Nightshelf broker.
"""

[[section.asset]]
id = "orca-singer"
file = "sprites/orca-singer.png"
identity = "orca"
prompt_inline = """
An orca wake-singer.
"""
`,
  });

  const doc = await loadPack(root);
  const byId = Object.fromEntries(doc.specs.map((s) => [s.id, s]));

  // Pack default: aurora-stack
  assert.equal(byId["aurora-general"].identity_id, "aurora-stack");
  // Section override: nightshelf
  assert.equal(byId["nightshelf-broker"].identity_id, "nightshelf");
  // Asset override: orca (wins over section)
  assert.equal(byId["orca-singer"].identity_id, "orca");
  assert.equal(doc.identities["aurora-stack"].name, "Aurora Stack");
});

test("loadPack rejects unknown identity references", async () => {
  const root = await createPack({
    "pack.toml": `preset = "glacial-archive"

[identity.aurora-stack]
description = "Pale ice-plate penguins."

[[section]]
id = "sprites"
identity = "missing-identity"

[[section.asset]]
id = "penguin"
file = "sprites/penguin.png"
prompt_inline = """
A valid description.
"""
`,
  });

  await assert.rejects(
    () => loadPack(root),
    /unknown identity "missing-identity"/i,
  );
});

test("loadPack rejects default_identity pointing at missing identity", async () => {
  const root = await createPack({
    "pack.toml": `preset = "glacial-archive"
default_identity = "ghost"

[[section]]
id = "sprites"

[[section.asset]]
id = "penguin"
file = "sprites/penguin.png"
prompt_inline = """
A valid description.
"""
`,
  });

  await assert.rejects(
    () => loadPack(root),
    /unknown identity "ghost"/i,
  );
});

test("loadPack requires identity description text", async () => {
  const root = await createPack({
    "pack.toml": `preset = "glacial-archive"

[identity.empty-one]
name = "Nothing"
description = ""

[[section]]
id = "sprites"

[[section.asset]]
id = "penguin"
file = "sprites/penguin.png"
identity = "empty-one"
prompt_inline = """
A valid description.
"""
`,
  });

  await assert.rejects(
    () => loadPack(root),
    /pack\.identity\.empty-one\.description/i,
  );
});

test("loadPack rejects unknown style references", async () => {
  const root = await createPack({
    "pack.toml": `preset = "glacial-archive"

[[section]]
id = "sprites"
style = "missing-style"

[[section.asset]]
id = "penguin"
file = "sprites/penguin.png"
prompt_inline = """
A valid description.
"""
`,
  });

  await assert.rejects(
    () => loadPack(root),
    /unknown style "missing-style"/i,
  );
});

test("loadPack accepts the mask asset type and injects its guidance", async () => {
  const root = await createPack({
    "pack.toml": `preset = "glacial-archive"

[[section]]
id = "masks"
title = "Spatial masks"

[[section.asset]]
id = "inkblot"
file = "masks/inkblot.png"
type = "mask"
prompt_inline = """
A symmetrical inkblot silhouette.
"""
`,
  });

  const doc = await loadPack(root);
  const asset = doc.specs.find((entry) => entry.id === "inkblot");

  assert.equal(asset.type, "mask");
  // A mask must be prompted as a shape, not a picture, or the distance field is meaningless.
  assert.match(asset.prompt_fragment ?? "", /grayscale spatial mask/i);
  assert.match(asset.prompt_fragment ?? "", /white on a pure black field/i);
});

test("loadPack infers the mask type from a masks/ output path", async () => {
  const root = await createPack({
    "pack.toml": `preset = "glacial-archive"

[[section]]
id = "masks"

[[section.asset]]
id = "logo"
file = "masks/logo.png"
type = "mask"
prompt_inline = """
A bold emblem silhouette.
"""
`,
  });

  const doc = await loadPack(root);
  assert.equal(doc.specs[0].type, "mask");
});
