import { createHash } from "node:crypto";
import type { GenerationRecord } from "./types.js";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const ITXT_TYPE = Buffer.from("iTXt", "ascii");
const METADATA_KEYWORD = "illuminator";

export interface ProvenanceMetadata {
  schema: "illuminator/provenance@1";
  stage: "raw" | "processed" | "atlas";
  pack_title?: string;
  preset: string;
  spec_id?: string;
  spec_type?: string;
  section_id?: string;
  section?: string;
  style_id?: string;
  palette_id?: string;
  model?: string;
  size?: string;
  aspect?: string;
  source_file?: string;
  output_file: string;
  variant?: string;
  processing?: string[];
  bfl_task_id?: string;
  generated_at?: string;
  processed_at?: string;
  raw_description_sha256?: string;
  formatted_prompt_sha256?: string;
  prompt_fragment_sha256?: string;
}

export function buildRawPngMetadata(
  record: GenerationRecord,
): ProvenanceMetadata {
  return {
    schema: "illuminator/provenance@1",
    stage: "raw",
    pack_title: record.pack_title,
    preset: record.preset,
    spec_id: record.spec_id,
    spec_type: record.spec_type,
    section_id: record.section_id,
    section: record.section,
    style_id: record.style_id,
    palette_id: record.palette_id,
    model: record.model,
    size: record.size,
    aspect: record.aspect,
    source_file: record.file,
    output_file: record.file,
    bfl_task_id: record.bfl_task_id,
    generated_at: record.generated_at,
    raw_description_sha256: sha256Text(record.raw_description),
    formatted_prompt_sha256: sha256Json(record.formatted_prompt),
    prompt_fragment_sha256: record.prompt_fragment
      ? sha256Text(record.prompt_fragment)
      : undefined,
  };
}

export function embedPngMetadata(
  pngBytes: Buffer,
  metadata: unknown,
): Buffer {
  if (!pngBytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Expected a PNG buffer when embedding metadata.");
  }

  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= pngBytes.length) {
    const length = pngBytes.readUInt32BE(offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + length + 4;
    if (chunkEnd > pngBytes.length) {
      throw new Error("Encountered a truncated PNG chunk.");
    }

    const type = pngBytes.toString("ascii", typeOffset, dataOffset);
    if (type === "IEND") {
      const chunk = buildITXtChunk(
        METADATA_KEYWORD,
        JSON.stringify(metadata),
      );
      return Buffer.concat([
        pngBytes.subarray(0, offset),
        chunk,
        pngBytes.subarray(offset),
      ]);
    }
    offset = chunkEnd;
  }

  throw new Error("Could not find PNG IEND chunk.");
}

function buildITXtChunk(keyword: string, text: string): Buffer {
  const keywordBytes = Buffer.from(keyword, "latin1");
  if (keywordBytes.length === 0 || keywordBytes.length > 79) {
    throw new Error("PNG metadata keyword must be 1-79 bytes.");
  }

  const textBytes = Buffer.from(text, "utf8");
  const data = Buffer.concat([
    keywordBytes,
    Buffer.from([0, 0, 0, 0, 0]),
    textBytes,
  ]);

  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([ITXT_TYPE, data])), 0);

  return Buffer.concat([length, ITXT_TYPE, data, crc]);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Json(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
