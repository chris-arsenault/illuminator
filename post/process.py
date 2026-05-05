"""
Post-process illuminator's raw Flux outputs into game-ready assets.

Reads the sidecar JSON next to each PNG to determine the asset type, then
applies the appropriate transform:

  sprite      -> automatic rembg cutout, crop to content, metadata PNG
  hex-tile    -> pointy-top hex mask with feathered edges
  icon        -> automatic rembg cutout, fit to 16/32/64/128 variants
  card-face   -> crop to aspect, no background removal
  chrome      -> automatic rembg cutout, keep native resolution
  background  -> copy as PNG with embedded provenance metadata
  passthrough -> copy as PNG with embedded provenance metadata

For `sprite` and `icon` outputs, the processor also builds deterministic atlas
PNG sheets and JSON manifests automatically.

Usage:
  python process.py <raw_dir> <out_dir> [--type <only-this-type>]
      [--asset <spec-id[,spec-id]>] [--reprocess]
      [--color-recovery auto|always|off] [--lut <look.cube>]

Expects Python 3.10+ with: rembg, pillow, click, numpy.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from threading import Lock
import json
import math
import re
import sys
from pathlib import Path
from typing import Any, Iterable

import click
import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps, ImageStat
from PIL.PngImagePlugin import PngInfo

try:
    from rembg import new_session, remove as rembg_remove
except ImportError:  # pragma: no cover
    new_session = None  # type: ignore[assignment]
    rembg_remove = None  # type: ignore[assignment]


ICON_SIZES = [16, 32, 64, 128]
SPRITE_CONTENT_PADDING_PX = 24
ICON_CONTENT_PADDING_PX = 8
HEX_FEATHER_RADIUS_PX = 6
ATLAS_PADDING_PX = 2
ATLAS_MAX_EDGE_PX = {
    "sprite": 4096,
    "icon": 2048,
}
DEFAULT_SATURATION_BOOST = 2.35
DEFAULT_LUT_STRENGTH = 0.35
WASHED_SATURATION_THRESHOLD = 0.18
WASHED_CONTRAST_THRESHOLD = 0.38
METRIC_ALPHA_THRESHOLD = 8
VALID_ASSET_TYPES = {
    "sprite",
    "hex-tile",
    "icon",
    "card-face",
    "chrome",
    "background",
    "passthrough",
}
_REMBG_SESSIONS: dict[str, Any] = {}


@dataclass(frozen=True)
class ProcessedOutput:
    path: Path
    asset_type: str
    meta: dict[str, Any]
    processing: tuple[str, ...]
    variant: str | None = None


@dataclass(frozen=True)
class CutoutPolicy:
    model: str
    post_process_mask: bool = True
    alpha_matting: bool = False
    foreground_threshold: int = 245
    background_threshold: int = 15
    erode_size: int = 8

    def processing_step(self) -> str:
        parts = [f"cutout:{self.model}"]
        if self.post_process_mask:
            parts.append("mask-post")
        if self.alpha_matting:
            parts.append(
                "alpha"
                f"({self.foreground_threshold}/{self.background_threshold}/{self.erode_size})"
            )
        return "+".join(parts)


@dataclass(frozen=True)
class CubeLut:
    path: Path
    title: str
    size: int
    table: np.ndarray
    domain_min: np.ndarray
    domain_max: np.ndarray


@dataclass(frozen=True)
class ColorConfig:
    recovery_mode: str
    saturation_boost: float
    washed_saturation_threshold: float
    washed_contrast_threshold: float
    lut: CubeLut | None
    lut_strength: float


@dataclass(frozen=True)
class ColorMetrics:
    visible_coverage: float
    saturation_mean: float
    saturation_p90: float
    luma_stddev: float
    luma_p95_p05: float
    washed_out: bool


@dataclass(frozen=True)
class ColorResult:
    image: Image.Image
    processing: tuple[str, ...]
    diagnostics: dict[str, Any]


MAX_CONCURRENCY = 16


@click.command()
@click.argument("raw_dir", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.argument("out_dir", type=click.Path(file_okay=False, path_type=Path))
@click.option(
    "--type",
    "only_type",
    default=None,
    help="Only process this asset type (e.g. sprite, hex-tile, icon).",
)
@click.option(
    "--asset",
    "only_assets",
    default=None,
    help="Only process these asset ids (comma-separated spec_id values).",
)
@click.option(
    "--reprocess",
    "reprocess",
    is_flag=True,
    help="Overwrite existing processed outputs. Defaults to no overwrite.",
)
@click.option(
    "--skip-atlases",
    "skip_atlases",
    is_flag=True,
    help="Do not rebuild sprite/icon atlas sheets.",
)
@click.option(
    "--concurrency",
    "concurrency",
    default=1,
    type=click.IntRange(1, MAX_CONCURRENCY),
    help=f"Parallel workers for per-image processing (1-{MAX_CONCURRENCY}, default: 1).",
)
@click.option(
    "--color-recovery",
    "color_recovery",
    default="auto",
    show_default=True,
    type=click.Choice(["auto", "always", "off"]),
    help="Recover washed-out renders by boosting saturation.",
)
@click.option(
    "--saturation-boost",
    "saturation_boost",
    default=DEFAULT_SATURATION_BOOST,
    show_default=True,
    type=click.FloatRange(1.0, 4.0),
    help="Saturation multiplier used by color recovery.",
)
@click.option(
    "--washed-saturation-threshold",
    "washed_saturation_threshold",
    default=WASHED_SATURATION_THRESHOLD,
    show_default=True,
    type=click.FloatRange(0.0, 1.0),
    help="Mean saturation below this value can trigger auto recovery.",
)
@click.option(
    "--washed-contrast-threshold",
    "washed_contrast_threshold",
    default=WASHED_CONTRAST_THRESHOLD,
    show_default=True,
    type=click.FloatRange(0.0, 1.0),
    help="P95-P05 luminance contrast below this value can trigger auto recovery.",
)
@click.option(
    "--lut",
    "lut_path",
    default=None,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="Optional .cube LUT to apply after saturation recovery.",
)
@click.option(
    "--lut-strength",
    "lut_strength",
    default=DEFAULT_LUT_STRENGTH,
    show_default=True,
    type=click.FloatRange(0.0, 1.0),
    help="Blend amount for the optional LUT.",
)
def main(
    raw_dir: Path,
    out_dir: Path,
    only_type: str | None,
    only_assets: str | None,
    reprocess: bool,
    skip_atlases: bool,
    concurrency: int,
    color_recovery: str,
    saturation_boost: float,
    washed_saturation_threshold: float,
    washed_contrast_threshold: float,
    lut_path: Path | None,
    lut_strength: float,
) -> None:
    """Process every PNG in RAW_DIR that has a sidecar .json, write to OUT_DIR."""
    out_dir.mkdir(parents=True, exist_ok=True)
    out_dir = out_dir.resolve()
    asset_filter = parse_asset_filter(only_assets)
    filtered_run = only_type is not None or asset_filter is not None
    color_config = ColorConfig(
        recovery_mode=color_recovery,
        saturation_boost=saturation_boost,
        washed_saturation_threshold=washed_saturation_threshold,
        washed_contrast_threshold=washed_contrast_threshold,
        lut=load_cube_lut(lut_path) if lut_path is not None else None,
        lut_strength=lut_strength,
    )

    pairs = list(find_png_json_pairs(raw_dir))
    if not pairs:
        click.echo(f"No PNG+JSON pairs found in {raw_dir}")
        sys.exit(1)

    # Filter to jobs we actually intend to run so the summary math is honest
    # when --type is applied.
    jobs: list[tuple[Path, dict[str, Any], str, Path, Path]] = []
    skipped_existing = 0
    for png_path, meta in pairs:
        asset_type = resolve_asset_type(meta)
        if only_type and asset_type != only_type:
            continue
        spec_id = meta.get("spec_id")
        if asset_filter is not None and (
            not isinstance(spec_id, str) or spec_id not in asset_filter
        ):
            continue
        rel_out = validate_output_path(meta.get("file", png_path.name))
        target = resolve_safe_output_path(out_dir, rel_out)
        target.parent.mkdir(parents=True, exist_ok=True)
        existing_outputs = [
            output.path
            for output in expected_processed_outputs(target, asset_type, meta)
            if output.path.exists()
        ]
        if existing_outputs and not reprocess:
            skipped_existing += 1
            continue
        jobs.append((png_path, meta, asset_type, rel_out, target))

    if not jobs:
        atlas_outputs: list[Path] = []
        if skipped_existing and not skip_atlases and not filtered_run:
            atlas_inputs = collect_processed_outputs_for_atlases(pairs, out_dir)
            if atlas_inputs:
                try:
                    atlas_outputs = build_atlases(out_dir, atlas_inputs, reprocess=True)
                except Exception as exc:  # noqa: BLE001 -- report and fail
                    click.echo(f"\nAtlas build failed: {exc}", err=True)
                    sys.exit(1)

        if atlas_outputs:
            click.echo("")
            for atlas_path in atlas_outputs:
                click.echo(f"  atlas        {atlas_path.relative_to(out_dir)}")
            click.echo(f"{len(atlas_outputs)} atlas sheet(s) built")
        if skipped_existing:
            click.echo(
                f"Skipped {skipped_existing} existing processed asset(s); "
                "use --reprocess to overwrite."
            )
        else:
            click.echo("No jobs matched the given filter.")
        sys.exit(0)

    results: list[tuple[Path, str, list[ProcessedOutput]]] = []
    processed_outputs: list[ProcessedOutput] = []
    # click.echo and shared lists must be serialized across worker threads.
    io_lock = Lock()

    def _run(job: tuple[Path, dict[str, Any], str, Path, Path]) -> None:
        png_path, meta, asset_type, rel_out, target = job
        try:
            outputs = process_one(
                png_path,
                target,
                asset_type,
                meta,
                out_dir,
                color_config,
            )
            with io_lock:
                processed_outputs.extend(outputs)
                results.append((png_path, "ok", outputs))
                click.echo(
                    f"  {asset_type:<12} {rel_out} -> "
                    f"{', '.join(str(p.path.relative_to(out_dir)) for p in outputs)}"
                )
        except Exception as exc:  # noqa: BLE001 -- report and continue
            with io_lock:
                results.append((png_path, f"fail: {exc}", []))
                click.echo(
                    f"  {asset_type:<12} {rel_out} FAILED: {exc}", err=True
                )

    # ONNX inference inside rembg releases the GIL, so a ThreadPoolExecutor
    # gives real parallelism without spawning one model load per worker
    # process. Pillow ops likewise release the GIL for C-backed paths.
    workers = max(1, min(concurrency, len(jobs)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(as_completed(pool.submit(_run, job) for job in jobs))

    atlas_outputs: list[Path] = []
    if processed_outputs and not skip_atlases:
        if filtered_run:
            click.echo(
                "  atlas        skipped for filtered run; process the full raw "
                "directory to rebuild atlases"
            )
        else:
            atlas_inputs = collect_processed_outputs_for_atlases(pairs, out_dir)
            if atlas_inputs:
                try:
                    atlas_outputs = build_atlases(out_dir, atlas_inputs, reprocess=True)
                except Exception as exc:  # noqa: BLE001 -- report and fail
                    click.echo(f"\nAtlas build failed: {exc}", err=True)
                    sys.exit(1)

    total = len(results)
    ok = sum(1 for _, status, _ in results if status == "ok")

    if atlas_outputs:
        click.echo("")
        for atlas_path in atlas_outputs:
            click.echo(f"  atlas        {atlas_path.relative_to(out_dir)}")

    click.echo(f"\n{ok}/{total} succeeded")
    if atlas_outputs:
        click.echo(f"{len(atlas_outputs)} atlas sheet(s) built")
    if skipped_existing:
        click.echo(
            f"{skipped_existing} existing processed asset(s) skipped; "
            "use --reprocess to overwrite"
        )
    if ok != total:
        sys.exit(1)


def parse_asset_filter(raw: str | None) -> set[str] | None:
    if raw is None:
        return None
    values = {part.strip() for part in raw.split(",") if part.strip()}
    return values or set()


def find_png_json_pairs(root: Path) -> Iterable[tuple[Path, dict[str, Any]]]:
    """Yield (png_path, metadata_dict) for every PNG with a sibling .json."""
    for png in sorted(root.rglob("*.png")):
        sidecar = png.with_suffix(".json")
        if not sidecar.exists():
            continue
        try:
            meta = json.loads(sidecar.read_text(encoding="utf8"))
        except json.JSONDecodeError as exc:
            click.echo(f"  [skip] {png.name}: bad JSON ({exc})", err=True)
            continue

        yield png, meta


def resolve_asset_type(meta: dict[str, Any]) -> str:
    raw_type = meta.get("spec_type")
    if raw_type is None:
        return infer_type_from_path(str(meta.get("file", "")))
    if not isinstance(raw_type, str) or raw_type not in VALID_ASSET_TYPES:
        raise ValueError(f"invalid spec_type {raw_type!r}")
    return raw_type


def infer_type_from_path(file: str) -> str:
    """Guess asset type from its output path — sprites/ -> sprite, etc."""
    lower = file.lower()
    if lower.startswith("sprites/") or lower.startswith("sprite/"):
        return "sprite"
    if lower.startswith("terrain/") or lower.startswith("hex/"):
        return "hex-tile"
    if lower.startswith("icons/") or lower.startswith("icon/"):
        return "icon"
    if lower.startswith("cards/") or lower.startswith("card-faces/"):
        return "card-face"
    if lower.startswith("chrome/"):
        return "chrome"
    if lower.startswith("backgrounds/") or lower.startswith("bg/"):
        return "background"
    return "passthrough"


def validate_output_path(raw_path: object) -> Path:
    if not isinstance(raw_path, str):
        raise ValueError("sidecar file path must be a string")
    normalized = raw_path.strip().replace("\\", "/")
    if not normalized:
        raise ValueError("sidecar file path must not be empty")
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:/", normalized):
        raise ValueError("sidecar file path must be relative")
    if not normalized.lower().endswith(".png"):
        raise ValueError("sidecar file path must end in .png")

    parts = normalized.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError("sidecar file path contains an unsafe segment")
    return Path(*parts)


def resolve_safe_output_path(out_dir: Path, relative_path: Path) -> Path:
    base = out_dir.resolve()
    target = (base / relative_path).resolve()
    if target != base and base not in target.parents:
        raise ValueError("sidecar file path escapes the output directory")
    return target


def expected_output_paths(target: Path, asset_type: str) -> list[Path]:
    return [
        output.path
        for output in expected_processed_outputs(target, asset_type, meta={})
    ]


def expected_processed_outputs(
    target: Path,
    asset_type: str,
    meta: dict[str, Any],
) -> list[ProcessedOutput]:
    if asset_type == "icon":
        return [
            ProcessedOutput(
                target.parent / f"{target.stem}@{size}.png",
                asset_type,
                meta,
                tuple(),
                variant=f"size:{size}",
            )
            for size in ICON_SIZES
        ]
    return [ProcessedOutput(target, asset_type, meta, tuple())]


def collect_processed_outputs_for_atlases(
    pairs: Iterable[tuple[Path, dict[str, Any]]],
    out_dir: Path,
) -> list[ProcessedOutput]:
    outputs: list[ProcessedOutput] = []
    for png_path, meta in pairs:
        asset_type = resolve_asset_type(meta)
        if asset_type not in {"sprite", "icon"}:
            continue
        rel_out = validate_output_path(meta.get("file", png_path.name))
        target = resolve_safe_output_path(out_dir, rel_out)
        outputs.extend(
            output
            for output in expected_processed_outputs(target, asset_type, meta)
            if output.path.exists()
        )
    return outputs


def process_one(
    src: Path,
    target: Path,
    asset_type: str,
    meta: dict[str, Any],
    out_dir: Path,
    color_config: ColorConfig,
) -> list[ProcessedOutput]:
    """Dispatch to the right transform. Returns the files written."""
    with Image.open(src) as opened:
        img = opened.convert("RGBA")

    if asset_type == "sprite":
        return [process_sprite(img, target, meta, out_dir, color_config)]
    if asset_type == "hex-tile":
        return [process_hex_tile(img, target, meta, out_dir, color_config)]
    if asset_type == "icon":
        return process_icon(img, target, meta, out_dir, color_config)
    if asset_type == "card-face":
        return [process_card_face(img, target, meta, out_dir, color_config)]
    if asset_type == "chrome":
        return [process_chrome(img, target, meta, out_dir, color_config)]
    if asset_type == "background":
        return [process_background(img, target, meta, out_dir, color_config)]
    return [process_passthrough(img, target, meta, out_dir, color_config)]


# ---------------------------------------------------------------------------
# Per-type transforms
# ---------------------------------------------------------------------------


def process_sprite(
    img: Image.Image,
    target: Path,
    meta: dict[str, Any],
    out_dir: Path,
    color_config: ColorConfig,
) -> ProcessedOutput:
    policy = choose_cutout_policy("sprite", img)
    cut = _rembg(img, policy)
    cropped = _crop_to_content(cut, padding=SPRITE_CONTENT_PADDING_PX)
    color = apply_color_pipeline(cropped, color_config)
    processing = [
        policy.processing_step(),
        f"crop-to-content:{SPRITE_CONTENT_PADDING_PX}",
        *color.processing,
    ]
    _save_processed_png(
        color.image,
        target,
        out_dir,
        meta,
        processing=processing,
        variant=None,
        color=color.diagnostics,
    )
    return ProcessedOutput(target, "sprite", meta, tuple(processing))


def process_hex_tile(
    img: Image.Image,
    target: Path,
    meta: dict[str, Any],
    out_dir: Path,
    color_config: ColorConfig,
) -> ProcessedOutput:
    square = _center_square(img)
    masked = _apply_hex_mask(square, feather=HEX_FEATHER_RADIUS_PX)
    color = apply_color_pipeline(masked, color_config)
    processing = [
        "center-square",
        f"hex-mask:{HEX_FEATHER_RADIUS_PX}",
        *color.processing,
    ]
    _save_processed_png(
        color.image,
        target,
        out_dir,
        meta,
        processing=processing,
        variant=None,
        color=color.diagnostics,
    )
    return ProcessedOutput(target, "hex-tile", meta, tuple(processing))


def process_icon(
    img: Image.Image,
    target: Path,
    meta: dict[str, Any],
    out_dir: Path,
    color_config: ColorConfig,
) -> list[ProcessedOutput]:
    policy = choose_cutout_policy("icon", img)
    cut = _rembg(img, policy)
    cropped = _crop_to_content(cut, padding=ICON_CONTENT_PADDING_PX)
    color = apply_color_pipeline(cropped, color_config)

    outputs: list[ProcessedOutput] = []
    stem = target.stem
    for size in ICON_SIZES:
        sized = _fit_into_square(color.image, size)
        out = target.parent / f"{stem}@{size}.png"
        processing = [
            policy.processing_step(),
            f"crop-to-content:{ICON_CONTENT_PADDING_PX}",
            *color.processing,
            f"fit-square:{size}",
        ]
        _save_processed_png(
            sized,
            out,
            out_dir,
            meta,
            processing=processing,
            variant=f"size:{size}",
            color=color.diagnostics,
        )
        outputs.append(
            ProcessedOutput(
                out,
                "icon",
                meta,
                tuple(processing),
                variant=f"size:{size}",
            )
        )
    return outputs


def process_card_face(
    img: Image.Image,
    target: Path,
    meta: dict[str, Any],
    out_dir: Path,
    color_config: ColorConfig,
) -> ProcessedOutput:
    cropped = _crop_to_aspect(img, aspect_w=3, aspect_h=4)
    color = apply_color_pipeline(cropped, color_config)
    processing = ["crop-to-aspect:3:4", *color.processing]
    _save_processed_png(
        color.image,
        target,
        out_dir,
        meta,
        processing=processing,
        variant=None,
        color=color.diagnostics,
    )
    return ProcessedOutput(target, "card-face", meta, tuple(processing))


def process_chrome(
    img: Image.Image,
    target: Path,
    meta: dict[str, Any],
    out_dir: Path,
    color_config: ColorConfig,
) -> ProcessedOutput:
    policy = choose_cutout_policy("chrome", img)
    cut = _rembg(img, policy)
    color = apply_color_pipeline(cut, color_config)
    processing = [policy.processing_step(), *color.processing]
    _save_processed_png(
        color.image,
        target,
        out_dir,
        meta,
        processing=processing,
        variant=None,
        color=color.diagnostics,
    )
    return ProcessedOutput(target, "chrome", meta, tuple(processing))


def process_background(
    img: Image.Image,
    target: Path,
    meta: dict[str, Any],
    out_dir: Path,
    color_config: ColorConfig,
) -> ProcessedOutput:
    color = apply_color_pipeline(img, color_config)
    processing = ["png-copy", *color.processing]
    _save_processed_png(
        color.image,
        target,
        out_dir,
        meta,
        processing=processing,
        variant=None,
        color=color.diagnostics,
    )
    return ProcessedOutput(target, "background", meta, tuple(processing))


def process_passthrough(
    img: Image.Image,
    target: Path,
    meta: dict[str, Any],
    out_dir: Path,
    color_config: ColorConfig,
) -> ProcessedOutput:
    color = apply_color_pipeline(img, color_config)
    processing = ["png-copy", *color.processing]
    _save_processed_png(
        color.image,
        target,
        out_dir,
        meta,
        processing=processing,
        variant=None,
        color=color.diagnostics,
    )
    return ProcessedOutput(target, "passthrough", meta, tuple(processing))


# ---------------------------------------------------------------------------
# Color analysis and correction
# ---------------------------------------------------------------------------


def apply_color_pipeline(img: Image.Image, config: ColorConfig) -> ColorResult:
    """Analyze color, recover washed-out renders, then optionally blend a LUT."""
    metrics = analyze_color(img, config)
    out = img
    processing: list[str] = []
    recovery_applied = False

    if config.recovery_mode == "always" or (
        config.recovery_mode == "auto" and metrics.washed_out
    ):
        out = _boost_saturation(out, config.saturation_boost)
        processing.append(f"color-recovery:saturation:{config.saturation_boost:g}")
        recovery_applied = True

    lut_applied = False
    if config.lut is not None and config.lut_strength > 0:
        out = apply_cube_lut(out, config.lut, config.lut_strength)
        processing.append(
            f"lut:{config.lut.path.stem}:strength:{config.lut_strength:g}"
        )
        lut_applied = True

    diagnostics = color_diagnostics(
        metrics,
        config,
        recovery_applied=recovery_applied,
        lut_applied=lut_applied,
    )
    return ColorResult(out, tuple(processing), diagnostics)


def analyze_color(img: Image.Image, config: ColorConfig) -> ColorMetrics:
    rgba = np.asarray(img.convert("RGBA"), dtype=np.float32)
    alpha = rgba[..., 3]
    visible = alpha > METRIC_ALPHA_THRESHOLD
    visible_count = int(np.count_nonzero(visible))
    total_count = int(alpha.size)

    if visible_count == 0 or total_count == 0:
        return ColorMetrics(
            visible_coverage=0.0,
            saturation_mean=0.0,
            saturation_p90=0.0,
            luma_stddev=0.0,
            luma_p95_p05=0.0,
            washed_out=False,
        )

    rgb = rgba[..., :3][visible] / 255.0
    max_channel = np.max(rgb, axis=1)
    min_channel = np.min(rgb, axis=1)
    chroma = max_channel - min_channel
    saturation = np.divide(
        chroma,
        max_channel,
        out=np.zeros_like(chroma),
        where=max_channel > 0,
    )
    luma = (
        rgb[:, 0] * 0.2126
        + rgb[:, 1] * 0.7152
        + rgb[:, 2] * 0.0722
    )

    saturation_mean = float(np.mean(saturation))
    saturation_p90 = float(np.percentile(saturation, 90))
    luma_stddev = float(np.std(luma))
    luma_p95_p05 = float(np.percentile(luma, 95) - np.percentile(luma, 5))
    washed_out = (
        saturation_mean <= config.washed_saturation_threshold
        and luma_p95_p05 <= config.washed_contrast_threshold
    )

    return ColorMetrics(
        visible_coverage=visible_count / total_count,
        saturation_mean=saturation_mean,
        saturation_p90=saturation_p90,
        luma_stddev=luma_stddev,
        luma_p95_p05=luma_p95_p05,
        washed_out=washed_out,
    )


def color_diagnostics(
    metrics: ColorMetrics,
    config: ColorConfig,
    *,
    recovery_applied: bool,
    lut_applied: bool,
) -> dict[str, Any]:
    diagnostics: dict[str, Any] = {
        "visible_coverage": _round_metric(metrics.visible_coverage),
        "saturation_mean": _round_metric(metrics.saturation_mean),
        "saturation_p90": _round_metric(metrics.saturation_p90),
        "luma_stddev": _round_metric(metrics.luma_stddev),
        "luma_p95_p05": _round_metric(metrics.luma_p95_p05),
        "washed_out": metrics.washed_out,
        "recovery_mode": config.recovery_mode,
        "recovery_applied": recovery_applied,
        "saturation_boost": config.saturation_boost,
        "washed_saturation_threshold": config.washed_saturation_threshold,
        "washed_contrast_threshold": config.washed_contrast_threshold,
        "lut_applied": lut_applied,
    }
    if config.lut is not None:
        diagnostics["lut"] = config.lut.path.name
        diagnostics["lut_title"] = config.lut.title
        diagnostics["lut_strength"] = config.lut_strength
    return diagnostics


def _round_metric(value: float) -> float:
    return round(float(value), 4)


def _boost_saturation(img: Image.Image, factor: float) -> Image.Image:
    rgba = img.convert("RGBA")
    alpha = rgba.getchannel("A")
    rgb = rgba.convert("RGB")
    boosted = ImageEnhance.Color(rgb).enhance(factor).convert("RGBA")
    boosted.putalpha(alpha)
    return boosted


def load_cube_lut(path: Path) -> CubeLut:
    title = path.stem
    size: int | None = None
    domain_min = np.array([0.0, 0.0, 0.0], dtype=np.float32)
    domain_max = np.array([1.0, 1.0, 1.0], dtype=np.float32)
    rows: list[tuple[float, float, float]] = []

    lines = path.read_text(encoding="utf8").splitlines()
    for line_number, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        parts = line.split()
        key = parts[0].upper()
        if key == "TITLE":
            title = line.partition(" ")[2].strip().strip('"') or title
            continue
        if key == "LUT_3D_SIZE":
            if len(parts) != 2:
                raise ValueError(f"{path}: bad LUT_3D_SIZE on line {line_number}")
            size = int(parts[1])
            if size < 2:
                raise ValueError(f"{path}: LUT_3D_SIZE must be at least 2")
            continue
        if key == "DOMAIN_MIN":
            domain_min = _parse_lut_domain(path, line_number, parts)
            continue
        if key == "DOMAIN_MAX":
            domain_max = _parse_lut_domain(path, line_number, parts)
            continue
        if key.startswith("LUT_1D"):
            raise ValueError(f"{path}: 1D LUTs are not supported")

        if len(parts) < 3:
            raise ValueError(f"{path}: expected RGB row on line {line_number}")
        try:
            rows.append((float(parts[0]), float(parts[1]), float(parts[2])))
        except ValueError as exc:
            raise ValueError(
                f"{path}: expected numeric RGB row on line {line_number}"
            ) from exc

    if size is None:
        raise ValueError(f"{path}: missing LUT_3D_SIZE")
    expected = size**3
    if len(rows) != expected:
        raise ValueError(
            f"{path}: expected {expected} RGB rows for "
            f"LUT_3D_SIZE {size}, got {len(rows)}"
        )
    if np.any(domain_max <= domain_min):
        raise ValueError(f"{path}: DOMAIN_MAX must be greater than DOMAIN_MIN")

    table = np.asarray(rows, dtype=np.float32).reshape((size, size, size, 3))
    return CubeLut(
        path=path,
        title=title,
        size=size,
        table=np.clip(table, 0.0, 1.0),
        domain_min=domain_min,
        domain_max=domain_max,
    )


def _parse_lut_domain(path: Path, line_number: int, parts: list[str]) -> np.ndarray:
    if len(parts) != 4:
        raise ValueError(f"{path}: bad {parts[0]} on line {line_number}")
    try:
        return np.array(
            [float(parts[1]), float(parts[2]), float(parts[3])],
            dtype=np.float32,
        )
    except ValueError as exc:
        raise ValueError(f"{path}: bad {parts[0]} on line {line_number}") from exc


def apply_cube_lut(img: Image.Image, lut: CubeLut, strength: float) -> Image.Image:
    rgba = np.asarray(img.convert("RGBA"), dtype=np.float32) / 255.0
    rgb = rgba[..., :3]
    domain_span = lut.domain_max - lut.domain_min
    coords = np.clip((rgb - lut.domain_min) / domain_span, 0.0, 1.0)
    coords *= lut.size - 1

    low = np.floor(coords).astype(np.int32)
    high = np.clip(low + 1, 0, lut.size - 1)
    frac = coords - low

    r0 = low[..., 0]
    g0 = low[..., 1]
    b0 = low[..., 2]
    r1 = high[..., 0]
    g1 = high[..., 1]
    b1 = high[..., 2]
    rf = frac[..., 0][..., None]
    gf = frac[..., 1][..., None]
    bf = frac[..., 2][..., None]

    c000 = lut.table[r0, g0, b0]
    c001 = lut.table[r0, g0, b1]
    c010 = lut.table[r0, g1, b0]
    c011 = lut.table[r0, g1, b1]
    c100 = lut.table[r1, g0, b0]
    c101 = lut.table[r1, g0, b1]
    c110 = lut.table[r1, g1, b0]
    c111 = lut.table[r1, g1, b1]

    c00 = c000 * (1.0 - bf) + c001 * bf
    c01 = c010 * (1.0 - bf) + c011 * bf
    c10 = c100 * (1.0 - bf) + c101 * bf
    c11 = c110 * (1.0 - bf) + c111 * bf
    c0 = c00 * (1.0 - gf) + c01 * gf
    c1 = c10 * (1.0 - gf) + c11 * gf
    graded = c0 * (1.0 - rf) + c1 * rf

    strength = float(strength)
    rgba[..., :3] = rgb * (1.0 - strength) + graded * strength
    out = np.clip(rgba * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(out)


# ---------------------------------------------------------------------------
# Automatic cutout policy
# ---------------------------------------------------------------------------


def choose_cutout_policy(asset_type: str, img: Image.Image) -> CutoutPolicy:
    complexity = _estimate_border_complexity(img)
    large_image = max(img.width, img.height) >= 1536

    if asset_type == "sprite":
        if complexity >= 24.0 or large_image:
            return CutoutPolicy(
                model="isnet-general-use",
                post_process_mask=True,
                alpha_matting=True,
                foreground_threshold=245,
                background_threshold=15,
                erode_size=8,
            )
        return CutoutPolicy(model="u2netp", post_process_mask=True)

    if asset_type in {"icon", "chrome"}:
        if complexity >= 32.0 and large_image:
            return CutoutPolicy(model="u2net", post_process_mask=True)
        return CutoutPolicy(model="u2netp", post_process_mask=True)

    raise ValueError(f"unsupported cutout asset type {asset_type!r}")


def _estimate_border_complexity(img: Image.Image) -> float:
    rgb = img.convert("RGB")
    border = max(8, min(rgb.width, rgb.height) // 32)
    crops = [
        rgb.crop((0, 0, rgb.width, border)),
        rgb.crop((0, rgb.height - border, rgb.width, rgb.height)),
        rgb.crop((0, border, border, rgb.height - border)),
        rgb.crop((rgb.width - border, border, rgb.width, rgb.height - border)),
    ]
    stddev_values: list[float] = []
    for crop in crops:
        stat = ImageStat.Stat(crop)
        stddev_values.extend(float(value) for value in stat.stddev[:3])
    return sum(stddev_values) / max(len(stddev_values), 1)


# ---------------------------------------------------------------------------
# Atlas packing
# ---------------------------------------------------------------------------


def build_atlases(
    out_dir: Path,
    outputs: list[ProcessedOutput],
    reprocess: bool,
) -> list[Path]:
    groups: dict[tuple[str, str, str | None], list[ProcessedOutput]] = {}
    for output in outputs:
        if output.asset_type not in {"sprite", "icon"}:
            continue
        rel_parent = output.path.relative_to(out_dir).parent.as_posix()
        variant = output.variant if output.asset_type == "icon" else None
        key = (output.asset_type, rel_parent, variant)
        groups.setdefault(key, []).append(output)

    atlas_paths: list[Path] = []
    for asset_type, rel_parent, variant in sorted(groups):
        sheets = _pack_group(groups[(asset_type, rel_parent, variant)], asset_type)
        for index, sheet in enumerate(sheets, start=1):
            atlas_path, manifest_path = _atlas_output_paths(
                out_dir,
                asset_type,
                rel_parent,
                variant,
                sheet_index=index,
                sheet_count=len(sheets),
            )
            if not reprocess and (atlas_path.exists() or manifest_path.exists()):
                continue
            atlas_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_path.parent.mkdir(parents=True, exist_ok=True)

            atlas = Image.new("RGBA", (sheet["width"], sheet["height"]), (0, 0, 0, 0))
            entries = []
            for placement in sheet["placements"]:
                atlas.alpha_composite(placement["image"], (placement["x"], placement["y"]))
                entries.append(
                    {
                        "spec_id": placement["output"].meta.get("spec_id"),
                        "spec_type": placement["output"].meta.get("spec_type"),
                        "source_file": placement["output"].path.relative_to(out_dir).as_posix(),
                        "x": placement["x"],
                        "y": placement["y"],
                        "width": placement["image"].width,
                        "height": placement["image"].height,
                    }
                )

            sample_meta = sheet["placements"][0]["output"].meta
            manifest = {
                "schema": "illuminator/atlas@1",
                "pack_title": _string_or_none(sample_meta.get("pack_title")),
                "preset": _string_or_none(sample_meta.get("preset")),
                "type": asset_type,
                "group": None if rel_parent == "." else rel_parent,
                "variant": variant,
                "image": atlas_path.relative_to(out_dir).as_posix(),
                "width": sheet["width"],
                "height": sheet["height"],
                "padding": ATLAS_PADDING_PX,
                "generated_at": _timestamp(),
                "entries": entries,
            }
            manifest_path.write_text(
                json.dumps(manifest, indent=2) + "\n",
                encoding="utf8",
            )

            metadata = {
                "schema": "illuminator/provenance@1",
                "stage": "atlas",
                "pack_title": manifest["pack_title"],
                "preset": manifest["preset"],
                "output_file": atlas_path.relative_to(out_dir).as_posix(),
                "variant": variant,
                "processing": ["atlas-pack"],
                "processed_at": manifest["generated_at"],
                "atlas_type": asset_type,
                "atlas_group": manifest["group"],
                "atlas_entry_count": len(entries),
                "atlas_manifest_sha256": _sha256_json(manifest),
            }
            save_png_with_metadata(atlas, atlas_path, metadata)
            atlas_paths.append(atlas_path)

    return atlas_paths


def _pack_group(
    outputs: list[ProcessedOutput],
    asset_type: str,
) -> list[dict[str, Any]]:
    max_edge = ATLAS_MAX_EDGE_PX[asset_type]
    items = []
    for output in outputs:
        with Image.open(output.path) as opened:
            image = opened.convert("RGBA")
        items.append(
            {
                "output": output,
                "image": image,
                "width": image.width,
                "height": image.height,
            }
        )

    items.sort(
        key=lambda item: (
            -item["height"],
            -item["width"],
            item["output"].path.as_posix(),
        )
    )

    sheets: list[dict[str, Any]] = []
    remaining = items
    while remaining:
        placements = []
        deferred = []
        x = ATLAS_PADDING_PX
        y = ATLAS_PADDING_PX
        row_height = 0
        used_width = ATLAS_PADDING_PX
        used_height = ATLAS_PADDING_PX

        for item in remaining:
            width = item["width"]
            height = item["height"]
            if width + (ATLAS_PADDING_PX * 2) > max_edge or height + (ATLAS_PADDING_PX * 2) > max_edge:
                raise ValueError(
                    f"{item['output'].path.name} is too large for the {asset_type} atlas size limit ({max_edge}px)."
                )

            if x + width + ATLAS_PADDING_PX > max_edge:
                x = ATLAS_PADDING_PX
                y += row_height + ATLAS_PADDING_PX
                row_height = 0

            if y + height + ATLAS_PADDING_PX > max_edge:
                deferred.append(item)
                continue

            placements.append(
                {
                    "output": item["output"],
                    "image": item["image"],
                    "x": x,
                    "y": y,
                }
            )
            x += width + ATLAS_PADDING_PX
            row_height = max(row_height, height)
            used_width = max(used_width, x)
            used_height = max(used_height, y + height)

        if not placements:
            raise ValueError(f"Could not place any {asset_type} atlas entries.")

        sheets.append(
            {
                "placements": placements,
                "width": used_width + ATLAS_PADDING_PX,
                "height": used_height + ATLAS_PADDING_PX,
            }
        )
        remaining = deferred

    return sheets


def _atlas_output_paths(
    out_dir: Path,
    asset_type: str,
    rel_parent: str,
    variant: str | None,
    *,
    sheet_index: int,
    sheet_count: int,
) -> tuple[Path, Path]:
    parent = Path() if rel_parent == "." else Path(rel_parent)
    atlas_base = Path("atlases") / parent
    stem = atlas_base.name or asset_type
    if asset_type == "icon" and variant:
        stem = f"{stem}@{variant.removeprefix('size:')}"
    if sheet_count > 1:
        stem = f"{stem}-{sheet_index}"
    atlas_dir = out_dir / atlas_base.parent
    return atlas_dir / f"{stem}.png", atlas_dir / f"{stem}.json"


# ---------------------------------------------------------------------------
# Metadata helpers
# ---------------------------------------------------------------------------


def _save_processed_png(
    img: Image.Image,
    target: Path,
    out_dir: Path,
    meta: dict[str, Any],
    *,
    processing: list[str],
    variant: str | None,
    color: dict[str, Any],
) -> None:
    metadata = build_png_provenance(
        meta,
        output_file=target.relative_to(out_dir).as_posix(),
        processing=processing,
        variant=variant,
        color=color,
    )
    save_png_with_metadata(img, target, metadata)


def save_png_with_metadata(
    img: Image.Image,
    target: Path,
    metadata: dict[str, Any],
) -> None:
    pnginfo = PngInfo()
    pnginfo.add_itxt(
        "illuminator",
        json.dumps(metadata, sort_keys=True, separators=(",", ":"), ensure_ascii=False),
    )
    img.save(target, "PNG", pnginfo=pnginfo)


def build_png_provenance(
    meta: dict[str, Any],
    *,
    output_file: str,
    processing: list[str],
    variant: str | None,
    color: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema": "illuminator/provenance@1",
        "stage": "processed",
        "pack_title": _string_or_none(meta.get("pack_title")),
        "preset": _string_or_none(meta.get("preset")),
        "spec_id": _string_or_none(meta.get("spec_id")),
        "spec_type": _string_or_none(meta.get("spec_type")),
        "section_id": _string_or_none(meta.get("section_id")),
        "section": _string_or_none(meta.get("section")),
        "style_id": _string_or_none(meta.get("style_id")),
        "palette_id": _string_or_none(meta.get("palette_id")),
        "model": _string_or_none(meta.get("model")),
        "size": _string_or_none(meta.get("size")),
        "aspect": _string_or_none(meta.get("aspect")),
        "source_file": _string_or_none(meta.get("file")),
        "output_file": output_file,
        "variant": variant,
        "processing": processing,
        "bfl_task_id": _string_or_none(meta.get("bfl_task_id")),
        "generated_at": _string_or_none(meta.get("generated_at")),
        "processed_at": _timestamp(),
    }

    if isinstance(meta.get("raw_description"), str):
        payload["raw_description_sha256"] = _sha256_text(meta["raw_description"])
    if meta.get("formatted_prompt") is not None:
        payload["formatted_prompt_sha256"] = _sha256_json(meta["formatted_prompt"])
    if isinstance(meta.get("prompt_fragment"), str):
        payload["prompt_fragment_sha256"] = _sha256_text(meta["prompt_fragment"])
    if color is not None:
        payload["color"] = color

    return {key: value for key, value in payload.items() if value not in (None, [], "")}


def _string_or_none(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _sha256_text(value: str) -> str:
    return sha256(value.encode("utf8")).hexdigest()


def _sha256_json(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return _sha256_text(encoded)


def _timestamp() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------


def _rembg(img: Image.Image, policy: CutoutPolicy) -> Image.Image:
    if rembg_remove is None:
        raise RuntimeError(
            "rembg is not installed. Install with: pip install rembg[cpu]"
        )

    kwargs: dict[str, Any] = {
        "post_process_mask": policy.post_process_mask,
    }
    session = _get_rembg_session(policy.model)
    if session is not None:
        kwargs["session"] = session
    if policy.alpha_matting:
        kwargs.update(
            {
                "alpha_matting": True,
                "alpha_matting_foreground_threshold": policy.foreground_threshold,
                "alpha_matting_background_threshold": policy.background_threshold,
                "alpha_matting_erode_size": policy.erode_size,
            }
        )

    return rembg_remove(img, **kwargs)


def _get_rembg_session(model_name: str) -> Any | None:
    if new_session is None:
        return None
    session = _REMBG_SESSIONS.get(model_name)
    if session is None:
        session = new_session(model_name)
        _REMBG_SESSIONS[model_name] = session
    return session


def _crop_to_content(img: Image.Image, padding: int = 0) -> Image.Image:
    """Crop to the bounding box of non-transparent pixels plus padding."""
    bbox = img.getbbox()
    if bbox is None:
        return img
    left = max(0, bbox[0] - padding)
    top = max(0, bbox[1] - padding)
    right = min(img.width, bbox[2] + padding)
    bottom = min(img.height, bbox[3] + padding)
    return img.crop((left, top, right, bottom))


def _fit_into_square(img: Image.Image, size: int) -> Image.Image:
    contained = ImageOps.contain(img, (size, size), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    left = (size - contained.width) // 2
    top = (size - contained.height) // 2
    canvas.paste(contained, (left, top), contained)
    return canvas


def _center_square(img: Image.Image) -> Image.Image:
    side = min(img.width, img.height)
    left = (img.width - side) // 2
    top = (img.height - side) // 2
    return img.crop((left, top, left + side, top + side))


def _crop_to_aspect(img: Image.Image, aspect_w: int, aspect_h: int) -> Image.Image:
    target_ratio = aspect_w / aspect_h
    current_ratio = img.width / img.height
    if current_ratio > target_ratio:
        new_w = int(img.height * target_ratio)
        left = (img.width - new_w) // 2
        return img.crop((left, 0, left + new_w, img.height))
    new_h = int(img.width / target_ratio)
    top = (img.height - new_h) // 2
    return img.crop((0, top, img.width, top + new_h))


def _apply_hex_mask(img: Image.Image, feather: int = 0) -> Image.Image:
    """Mask a square image into a pointy-top hexagon with feathered edges."""
    w, h = img.size
    if w != h:
        raise ValueError("hex mask expects a square image")

    cx, cy = w / 2.0, h / 2.0
    r = w / 2.0
    vertices = []
    for i in range(6):
        angle = math.radians(60 * i - 30)
        vertices.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))

    mask = Image.new("L", img.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.polygon(vertices, fill=255)

    if feather > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(radius=feather))

    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


if __name__ == "__main__":
    main()
