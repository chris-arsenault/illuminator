import { isAbsolute, relative, resolve } from "node:path";

export const SUPPORTED_BFL_MODELS = [
  "flux-2-pro",
  "flux-2-max",
  "flux-pro-1.1-ultra",
  "flux-pro-1.1-ultra-raw",
] as const;

export const MAX_CONCURRENCY = 8;
const MIN_RENDER_DIMENSION_PX = 256;
const MAX_RENDER_DIMENSION_PX = 4096;
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateModelId(
  rawModel: string,
  context = "model",
): string {
  const model = rawModel.trim();
  if (!model) {
    throw new Error(`${context} must not be empty.`);
  }
  if (!SUPPORTED_BFL_MODELS.includes(model as (typeof SUPPORTED_BFL_MODELS)[number])) {
    throw new Error(
      `${context} must be one of: ${SUPPORTED_BFL_MODELS.join(", ")}.`,
    );
  }
  return model;
}

export function validateAspectRatio(
  rawAspect: string,
  context = "aspect",
): string {
  const aspect = rawAspect.trim();
  const match = /^([1-9][0-9]{0,3}):([1-9][0-9]{0,3})$/.exec(aspect);
  if (!match) {
    throw new Error(`${context} must be in W:H form, e.g. 1:1 or 16:9.`);
  }

  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

export function validateRenderSize(
  rawSize: string,
  context = "size",
): string {
  const size = rawSize.trim().toLowerCase();
  const match = /^([1-9][0-9]{1,4})x([1-9][0-9]{1,4})$/.exec(size);
  if (!match) {
    throw new Error(`${context} must be in WIDTHxHEIGHT form, e.g. 1024x1024.`);
  }

  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);

  for (const [dimensionName, value] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (value < MIN_RENDER_DIMENSION_PX || value > MAX_RENDER_DIMENSION_PX) {
      throw new Error(
        `${context} ${dimensionName} must be between ${MIN_RENDER_DIMENSION_PX} and ${MAX_RENDER_DIMENSION_PX}px.`,
      );
    }
    if (value % 16 !== 0) {
      throw new Error(`${context} ${dimensionName} must be a multiple of 16.`);
    }
  }

  return `${width}x${height}`;
}

export function validateAssetOutputPath(
  rawFile: string,
  context = "file",
): string {
  return validateRelativePath(rawFile, context, { extension: ".png" });
}

export function validatePromptSourcePath(
  rawPath: string,
  context = "prompt",
): string {
  return validateRelativePath(rawPath, context, { extension: ".md" });
}

export function resolveSafeOutputPath(
  outputRoot: string,
  relativeFile: string,
  context = "output path",
): string {
  const safeRelativeFile = validateAssetOutputPath(relativeFile, context);
  return resolveSafePathWithinRoot(outputRoot, safeRelativeFile, context);
}

export function resolveSafePathWithinRoot(
  rootDir: string,
  relativePath: string,
  context = "path",
): string {
  const resolvedRoot = resolve(rootDir);
  const resolvedTarget = resolve(resolvedRoot, relativePath);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${context} escapes the containing directory.`);
  }
  return resolvedTarget;
}

export function validateRelativePath(
  rawPath: string,
  context = "path",
  opts: { extension?: string } = {},
): string {
  const normalized = rawPath.trim().replace(/\\/g, "/");
  if (!normalized) {
    throw new Error(`${context} must not be empty.`);
  }
  if (normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) {
    throw new Error(`${context} must be a relative path inside the pack directory.`);
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(
      `${context} must not contain empty, '.' or '..' path segments.`,
    );
  }
  if (opts.extension && !normalized.toLowerCase().endsWith(opts.extension)) {
    throw new Error(`${context} must end in ${opts.extension}.`);
  }

  return segments.join("/");
}

export function validateIdentifier(
  rawId: string,
  context = "id",
): string {
  const id = rawId.trim();
  if (!SAFE_ID.test(id)) {
    throw new Error(
      `${context} must match ${SAFE_ID.source} and use lowercase kebab-case.`,
    );
  }
  return id;
}

export function validateNonEmptyText(
  rawText: string,
  context = "text",
): string {
  const text = rawText.trim();
  if (!text) {
    throw new Error(`${context} must not be empty.`);
  }
  return text;
}

export function parseBoundedIntegerFlag(
  rawValue: string,
  flagName: string,
  opts: { min?: number; max?: number } = {},
): number {
  const trimmed = rawValue.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(`${flagName} must be an integer.`);
  }
  const value = Number.parseInt(trimmed, 10);
  if (opts.min !== undefined && value < opts.min) {
    throw new Error(`${flagName} must be at least ${opts.min}.`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new Error(`${flagName} must be at most ${opts.max}.`);
  }
  return value;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return x || 1;
}
