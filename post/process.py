"""
Post-process illuminator's raw Flux outputs into game-ready assets.

Reads the sidecar JSON next to each PNG to determine the asset type, then
applies the appropriate transform:

  sprite      → rembg background removal, crop to content, resize
  hex-tile    → pointy-top hex mask with feathered edges
  icon        → rembg + resize to multiple sizes (16/32/64/128)
  card-face   → crop to aspect, no background removal
  chrome      → rembg, no resize (keep native resolution)
  background  → resize only
  passthrough → copy as-is

Usage:
  python process.py <raw_dir> <out_dir> [--type <only-this-type>]

Expects Python 3.10+ with: rembg, pillow, click.
"""

from __future__ import annotations

import json
import math
import re
import shutil
import sys
from pathlib import Path
from typing import Iterable

import click
from PIL import Image, ImageDraw, ImageFilter

try:
    from rembg import remove as rembg_remove
except ImportError:  # pragma: no cover
    rembg_remove = None  # type: ignore


ICON_SIZES = [16, 32, 64, 128]
SPRITE_CONTENT_PADDING_PX = 24
HEX_FEATHER_RADIUS_PX = 6
VALID_ASSET_TYPES = {
    "sprite",
    "hex-tile",
    "icon",
    "card-face",
    "chrome",
    "background",
    "passthrough",
}


@click.command()
@click.argument("raw_dir", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.argument("out_dir", type=click.Path(file_okay=False, path_type=Path))
@click.option(
    "--type",
    "only_type",
    default=None,
    help="Only process this asset type (e.g. sprite, hex-tile, icon).",
)
def main(raw_dir: Path, out_dir: Path, only_type: str | None) -> None:
    """Process every PNG in RAW_DIR that has a sidecar .json, write to OUT_DIR."""
    out_dir.mkdir(parents=True, exist_ok=True)
    out_dir = out_dir.resolve()

    pairs = list(find_png_json_pairs(raw_dir))
    if not pairs:
        click.echo(f"No PNG+JSON pairs found in {raw_dir}")
        sys.exit(1)

    results = []
    for png_path, meta in pairs:
        asset_type = resolve_asset_type(meta)
        if only_type and asset_type != only_type:
            continue

        rel_out = validate_output_path(meta.get("file", png_path.name))
        target = resolve_safe_output_path(out_dir, rel_out)
        target.parent.mkdir(parents=True, exist_ok=True)

        try:
            outputs = process_one(png_path, target, asset_type)
            results.append((png_path, "ok", outputs))
            click.echo(f"  {asset_type:<12} {rel_out} → {', '.join(str(p.relative_to(out_dir)) for p in outputs)}")
        except Exception as exc:  # noqa: BLE001 — report and continue
            results.append((png_path, f"fail: {exc}", []))
            click.echo(f"  {asset_type:<12} {rel_out} FAILED: {exc}", err=True)

    total = len(results)
    ok = sum(1 for _, status, _ in results if status == "ok")
    click.echo(f"\n{ok}/{total} succeeded")
    if ok != total:
        sys.exit(1)


def find_png_json_pairs(root: Path) -> Iterable[tuple[Path, dict]]:
    """Yield (png_path, metadata_dict) for every PNG with a sibling .json."""
    for png in sorted(root.rglob("*.png")):
        sidecar = png.with_suffix(".json")
        if not sidecar.exists():
            continue
        try:
            meta = json.loads(sidecar.read_text())
        except json.JSONDecodeError as exc:
            click.echo(f"  [skip] {png.name}: bad JSON ({exc})", err=True)
            continue

        yield png, meta


def resolve_asset_type(meta: dict) -> str:
    raw_type = meta.get("spec_type")
    if raw_type is None:
        return infer_type_from_path(str(meta.get("file", "")))
    if not isinstance(raw_type, str) or raw_type not in VALID_ASSET_TYPES:
        raise ValueError(f"invalid spec_type {raw_type!r}")
    return raw_type


def infer_type_from_path(file: str) -> str:
    """Guess asset type from its output path — sprites/ → sprite, etc."""
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


def process_one(src: Path, target: Path, asset_type: str) -> list[Path]:
    """Dispatch to the right transform. Returns the list of files written."""
    img = Image.open(src).convert("RGBA")

    if asset_type == "sprite":
        return [process_sprite(img, target)]
    if asset_type == "hex-tile":
        return [process_hex_tile(img, target)]
    if asset_type == "icon":
        return process_icon(img, target)
    if asset_type == "card-face":
        return [process_card_face(img, target)]
    if asset_type == "chrome":
        return [process_chrome(img, target)]
    if asset_type == "background":
        return [process_background(img, target)]
    # passthrough
    shutil.copy2(src, target)
    return [target]


# ---------------------------------------------------------------------------
# Per-type transforms
# ---------------------------------------------------------------------------


def process_sprite(img: Image.Image, target: Path) -> Path:
    """Remove background via rembg, crop to content, write PNG with alpha."""
    cut = _rembg(img)
    cropped = _crop_to_content(cut, padding=SPRITE_CONTENT_PADDING_PX)
    cropped.save(target, "PNG")
    return target


def process_hex_tile(img: Image.Image, target: Path) -> Path:
    """Crop to square center, apply pointy-top hex mask with feathered edges."""
    square = _center_square(img)
    masked = _apply_hex_mask(square, feather=HEX_FEATHER_RADIUS_PX)
    masked.save(target, "PNG")
    return target


def process_icon(img: Image.Image, target: Path) -> list[Path]:
    """Rembg + write one PNG per ICON_SIZES. Files named <stem>@<size>.png."""
    cut = _rembg(img)
    cropped = _crop_to_content(cut, padding=8)
    outputs: list[Path] = []
    stem = target.stem
    for size in ICON_SIZES:
        sized = cropped.resize((size, size), Image.Resampling.LANCZOS)
        out = target.parent / f"{stem}@{size}.png"
        sized.save(out, "PNG")
        outputs.append(out)
    return outputs


def process_card_face(img: Image.Image, target: Path) -> Path:
    """Crop to 3:4 centered, no background removal."""
    cropped = _crop_to_aspect(img, aspect_w=3, aspect_h=4)
    cropped.save(target, "PNG")
    return target


def process_chrome(img: Image.Image, target: Path) -> Path:
    """rembg, keep native resolution."""
    cut = _rembg(img)
    cut.save(target, "PNG")
    return target


def process_background(img: Image.Image, target: Path) -> Path:
    """No cutout — just save as-is. Resize only if metadata requests it."""
    img.save(target, "PNG")
    return target


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------


def _rembg(img: Image.Image) -> Image.Image:
    if rembg_remove is None:
        raise RuntimeError(
            "rembg is not installed. Install with: pip install rembg[cpu]"
        )
    return rembg_remove(img)


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


def _center_square(img: Image.Image) -> Image.Image:
    side = min(img.width, img.height)
    left = (img.width - side) // 2
    top = (img.height - side) // 2
    return img.crop((left, top, left + side, top + side))


def _crop_to_aspect(img: Image.Image, aspect_w: int, aspect_h: int) -> Image.Image:
    target_ratio = aspect_w / aspect_h
    current_ratio = img.width / img.height
    if current_ratio > target_ratio:
        # Too wide — trim sides.
        new_w = int(img.height * target_ratio)
        left = (img.width - new_w) // 2
        return img.crop((left, 0, left + new_w, img.height))
    else:
        # Too tall — trim top/bottom.
        new_h = int(img.width / target_ratio)
        top = (img.height - new_h) // 2
        return img.crop((0, top, img.width, top + new_h))


def _apply_hex_mask(img: Image.Image, feather: int = 0) -> Image.Image:
    """Mask a square image into a pointy-top hexagon with feathered edges.

    The hex fills the full square width and is centered vertically. Pointy-top
    means two vertices sit at the top and bottom of the image, left and right
    edges of the hex touch the horizontal midpoints of the square sides.
    """
    w, h = img.size
    assert w == h, "hex mask expects a square image"

    # Pointy-top hex with 2r = h: six vertices around the center.
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
