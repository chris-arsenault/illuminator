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

Expects Python 3.10+ with: rembg, pillow, click.
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
from PIL import Image, ImageDraw, ImageFilter, ImageOps, ImageStat
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
    "--concurrency",
    "concurrency",
    default=1,
    type=click.IntRange(1, MAX_CONCURRENCY),
    help=f"Parallel workers for per-image processing (1-{MAX_CONCURRENCY}, default: 1).",
)
def main(
    raw_dir: Path,
    out_dir: Path,
    only_type: str | None,
    concurrency: int,
) -> None:
    """Process every PNG in RAW_DIR that has a sidecar .json, write to OUT_DIR."""
    out_dir.mkdir(parents=True, exist_ok=True)
    out_dir = out_dir.resolve()

    pairs = list(find_png_json_pairs(raw_dir))
    if not pairs:
        click.echo(f"No PNG+JSON pairs found in {raw_dir}")
        sys.exit(1)

    # Filter to jobs we actually intend to run so the summary math is honest
    # when --type is applied.
    jobs: list[tuple[Path, dict[str, Any], str, Path, Path]] = []
    for png_path, meta in pairs:
        asset_type = resolve_asset_type(meta)
        if only_type and asset_type != only_type:
            continue
        rel_out = validate_output_path(meta.get("file", png_path.name))
        target = resolve_safe_output_path(out_dir, rel_out)
        target.parent.mkdir(parents=True, exist_ok=True)
        jobs.append((png_path, meta, asset_type, rel_out, target))

    if not jobs:
        click.echo("No jobs matched the given filter.")
        sys.exit(0)

    results: list[tuple[Path, str, list[ProcessedOutput]]] = []
    processed_outputs: list[ProcessedOutput] = []
    # click.echo and shared lists must be serialized across worker threads.
    io_lock = Lock()

    def _run(job: tuple[Path, dict[str, Any], str, Path, Path]) -> None:
        png_path, meta, asset_type, rel_out, target = job
        try:
            outputs = process_one(png_path, target, asset_type, meta, out_dir)
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
    if processed_outputs:
        try:
            atlas_outputs = build_atlases(out_dir, processed_outputs)
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
    if ok != total:
        sys.exit(1)


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


def process_one(
    src: Path,
    target: Path,
    asset_type: str,
    meta: dict[str, Any],
    out_dir: Path,
) -> list[ProcessedOutput]:
    """Dispatch to the right transform. Returns the files written."""
    with Image.open(src) as opened:
        img = opened.convert("RGBA")

    if asset_type == "sprite":
        return [process_sprite(img, target, meta, out_dir)]
    if asset_type == "hex-tile":
        return [process_hex_tile(img, target, meta, out_dir)]
    if asset_type == "icon":
        return process_icon(img, target, meta, out_dir)
    if asset_type == "card-face":
        return [process_card_face(img, target, meta, out_dir)]
    if asset_type == "chrome":
        return [process_chrome(img, target, meta, out_dir)]
    if asset_type == "background":
        return [process_background(img, target, meta, out_dir)]
    return [process_passthrough(img, target, meta, out_dir)]


# ---------------------------------------------------------------------------
# Per-type transforms
# ---------------------------------------------------------------------------


def process_sprite(
    img: Image.Image,
    target: Path,
    meta: dict[str, Any],
    out_dir: Path,
) -> ProcessedOutput:
    policy = choose_cutout_policy("sprite", img)
    cut = _rembg(img, policy)
    cropped = _crop_to_content(cut, padding=SPRITE_CONTENT_PADDING_PX)
    processing = [policy.processing_step(), f"crop-to-content:{SPRITE_CONTENT_PADDING_PX}"]
    _save_processed_png(
        cropped,
        target,
        out_dir,
        meta,
        processing=processing,
        variant=None,
    )
    return ProcessedOutput(target, "sprite", meta, tuple(processing))


def process_hex_tile(
    img: Image.Image,
    target: Path,
    meta: dict[str, Any],
    out_dir: Path,
) -> ProcessedOutput:
    square = _center_square(img)
    masked = _apply_hex_mask(square, feather=HEX_FEATHER_RADIUS_PX)
    processing = ["center-square", f"hex-mask:{HEX_FEATHER_RADIUS_PX}"]
    _save_processed_png(
        masked,
        target,
        out_dir,
        meta,
        processing=processing,
        variant=None,
    )
    return ProcessedOutput(target, "hex-tile", meta, tuple(processing))


def process_icon(
    img: Image.Image,
    target: Path,
    meta: dict[str, Any],
    out_dir: Path,
) -> list[ProcessedOutput]:
    policy = choose_cutout_policy("icon", img)
    cut = _rembg(img, policy)
    cropped = _crop_to_content(cut, padding=ICON_CONTENT_PADDING_PX)

    outputs: list[ProcessedOutput] = []
    stem = target.stem
    for size in ICON_SIZES:
        sized = _fit_into_square(cropped, size)
        out = target.parent / f"{stem}@{size}.png"
        processing = [
            policy.processing_step(),
            f"crop-to-content:{ICON_CONTENT_PADDING_PX}",
            f"fit-square:{size}",
        ]
        _save_processed_png(
            sized,
            out,
            out_dir,
            meta,
            processing=processing,
            variant=f"size:{size}",
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
) -> ProcessedOutput:
    cropped = _crop_to_aspect(img, aspect_w=3, aspect_h=4)
    processing = ["crop-to-aspect:3:4"]
    _save_processed_png(
        cropped,
        target,
        out_dir,
        meta,
        processing=processing,
        variant=None,
    )
    return ProcessedOutput(target, "card-face", meta, tuple(processing))


def process_chrome(
    img: Image.Image,
    target: Path,
    meta: dict[str, Any],
    out_dir: Path,
) -> ProcessedOutput:
    policy = choose_cutout_policy("chrome", img)
    cut = _rembg(img, policy)
    processing = [policy.processing_step()]
    _save_processed_png(
        cut,
        target,
        out_dir,
        meta,
        processing=processing,
        variant=None,
    )
    return ProcessedOutput(target, "chrome", meta, tuple(processing))


def process_background(
    img: Image.Image,
    target: Path,
    meta: dict[str, Any],
    out_dir: Path,
) -> ProcessedOutput:
    processing = ["png-copy"]
    _save_processed_png(
        img,
        target,
        out_dir,
        meta,
        processing=processing,
        variant=None,
    )
    return ProcessedOutput(target, "background", meta, tuple(processing))


def process_passthrough(
    img: Image.Image,
    target: Path,
    meta: dict[str, Any],
    out_dir: Path,
) -> ProcessedOutput:
    processing = ["png-copy"]
    _save_processed_png(
        img,
        target,
        out_dir,
        meta,
        processing=processing,
        variant=None,
    )
    return ProcessedOutput(target, "passthrough", meta, tuple(processing))


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


def build_atlases(out_dir: Path, outputs: list[ProcessedOutput]) -> list[Path]:
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
) -> None:
    metadata = build_png_provenance(
        meta,
        output_file=target.relative_to(out_dir).as_posix(),
        processing=processing,
        variant=variant,
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
