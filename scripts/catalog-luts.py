#!/usr/bin/env python3
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import argparse
import csv
import json
import re
from pathlib import Path
from typing import Any

import numpy as np


SOURCE = {
    "collection": "Q-DDL Color LUTs",
    "creator": "Q-DDL / Quick-DDL",
    "license": "Creative Commons Attribution 4.0 International",
    "license_url": "https://creativecommons.org/licenses/by/4.0/",
    "original_url": "http://quickddl.net/free_color_luts",
    "mirror_url": "https://www.photoshoplus.fr/telecharger-luts-2/",
    "reference_urls": [
        "https://www.cgchannel.com/2020/01/download-800-free-3d-luts/",
        "https://awnchina.cn/800-free-luts/",
    ],
    "attribution": "Q-DDL / Quick-DDL, Q-DDL Color LUTs, CC BY 4.0",
}


@dataclass(frozen=True)
class CubeLut:
    title: str
    size: int
    table: np.ndarray
    domain_min: list[float]
    domain_max: list[float]
    comments: list[str]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build searchable metadata for locally downloaded .cube LUTs.",
    )
    parser.add_argument(
        "root",
        nargs="?",
        default="third_party/luts/q-ddl",
        type=Path,
        help="Q-DDL cache root. Defaults to third_party/luts/q-ddl.",
    )
    args = parser.parse_args()

    root = args.root
    extract_dir = root / "extracted"
    if not extract_dir.exists():
        raise SystemExit(f"missing extracted LUT directory: {extract_dir}")

    entries = []
    for path in sorted(extract_dir.rglob("*.cube")):
        lut = load_cube_lut(path)
        traits = analyze_lut(lut)
        entry = {
            "id": lut_id(path, extract_dir, lut.title),
            "title": lut.title,
            "collection": SOURCE["collection"],
            "creator": SOURCE["creator"],
            "license": SOURCE["license"],
            "license_url": SOURCE["license_url"],
            "attribution": SOURCE["attribution"],
            "category": category_for(path),
            "pack": pack_for(path),
            "path": path.as_posix(),
            "path_from_cache": path.relative_to(root).as_posix(),
            "lut_size": lut.size,
            "domain_min": lut.domain_min,
            "domain_max": lut.domain_max,
            "file_size_bytes": path.stat().st_size,
            "sha256": sha256(path.read_bytes()).hexdigest(),
            "source_comment": lut.comments[0] if lut.comments else None,
            "traits": traits,
            "tags": tags_for(traits),
        }
        entries.append(entry)

    catalog = {
        "schema": "illuminator/lut-catalog@1",
        "generated_at": timestamp(),
        "source": SOURCE,
        "root": root.as_posix(),
        "counts": {
            "luts": len(entries),
            "categories": category_counts(entries),
        },
        "entries": entries,
    }

    catalog_path = root / "catalog.json"
    csv_path = root / "catalog.csv"
    shortlist_path = root / "washed-out-shortlist.csv"
    source_path = root / "SOURCE.json"

    catalog_path.write_text(
        json.dumps(catalog, indent=2, sort_keys=True) + "\n",
        encoding="utf8",
    )
    source_path.write_text(
        json.dumps(SOURCE, indent=2, sort_keys=True) + "\n",
        encoding="utf8",
    )
    write_catalog_csv(csv_path, entries)
    write_shortlist_csv(shortlist_path, entries)

    print(f"LUT catalog: {catalog_path}")
    print(f"LUT CSV: {csv_path}")
    print(f"Washed-out shortlist: {shortlist_path}")
    print(f"LUT entries: {len(entries)}")


def load_cube_lut(path: Path) -> CubeLut:
    title = path.stem
    size: int | None = None
    domain_min = [0.0, 0.0, 0.0]
    domain_max = [1.0, 1.0, 1.0]
    comments: list[str] = []
    rows: list[tuple[float, float, float]] = []

    for line_number, raw_line in enumerate(
        path.read_text(encoding="utf8").splitlines(),
        start=1,
    ):
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            comments.append(line.removeprefix("#").strip())
            continue

        parts = line.split()
        key = parts[0].upper()
        if key == "TITLE":
            title = line.partition(" ")[2].strip().strip('"') or title
            continue
        if key == "LUT_3D_SIZE":
            size = int(parts[1])
            continue
        if key == "DOMAIN_MIN":
            domain_min = [float(parts[1]), float(parts[2]), float(parts[3])]
            continue
        if key == "DOMAIN_MAX":
            domain_max = [float(parts[1]), float(parts[2]), float(parts[3])]
            continue
        if key.startswith("LUT_1D"):
            raise ValueError(f"{path}: 1D LUTs are not supported")

        try:
            rows.append((float(parts[0]), float(parts[1]), float(parts[2])))
        except (IndexError, ValueError) as exc:
            raise ValueError(
                f"{path}: expected numeric RGB row on line {line_number}"
            ) from exc

    if size is None:
        raise ValueError(f"{path}: missing LUT_3D_SIZE")
    expected = size**3
    if len(rows) != expected:
        raise ValueError(f"{path}: expected {expected} rows, got {len(rows)}")

    table = np.asarray(rows, dtype=np.float32).reshape((size, size, size, 3))
    return CubeLut(
        title=title,
        size=size,
        table=np.clip(table, 0.0, 1.0),
        domain_min=domain_min,
        domain_max=domain_max,
        comments=comments,
    )


def analyze_lut(lut: CubeLut) -> dict[str, float | str]:
    axis = np.linspace(0.0, 1.0, lut.size, dtype=np.float32)
    r, g, b = np.meshgrid(axis, axis, axis, indexing="ij")
    inp = np.stack([r, g, b], axis=-1)
    out = lut.table

    in_luma = luma(inp)
    out_luma = luma(out)
    in_sat = saturation(inp)
    out_sat = saturation(out)

    saturation_ratio = ratio(np.mean(out_sat), np.mean(in_sat))
    contrast_ratio = ratio(np.std(out_luma), np.std(in_luma))
    exposure_delta = float(np.mean(out_luma - in_luma))
    avg_abs_rgb_delta = float(np.mean(np.abs(out - inp)))
    warmth_delta = float(np.mean((out[..., 0] - out[..., 2]) - (inp[..., 0] - inp[..., 2])))
    green_magenta_delta = float(
        np.mean(
            (out[..., 1] - ((out[..., 0] + out[..., 2]) / 2.0))
            - (inp[..., 1] - ((inp[..., 0] + inp[..., 2]) / 2.0))
        )
    )

    shadow_mask = in_luma <= 0.08
    highlight_mask = in_luma >= 0.92
    black_lift = float(np.mean(out_luma[shadow_mask] - in_luma[shadow_mask]))
    white_shift = float(np.mean(out_luma[highlight_mask] - in_luma[highlight_mask]))
    clipped_low = float(np.mean(np.any(out <= 0.001, axis=-1)))
    clipped_high = float(np.mean(np.any(out >= 0.999, axis=-1)))

    return {
        "look_strength": round(avg_abs_rgb_delta, 4),
        "look_strength_label": strength_label(avg_abs_rgb_delta),
        "exposure_delta": round(exposure_delta, 4),
        "contrast_ratio": round(contrast_ratio, 4),
        "saturation_ratio": round(saturation_ratio, 4),
        "warmth_delta": round(warmth_delta, 4),
        "green_magenta_delta": round(green_magenta_delta, 4),
        "black_lift": round(black_lift, 4),
        "white_shift": round(white_shift, 4),
        "clipped_low_fraction": round(clipped_low, 4),
        "clipped_high_fraction": round(clipped_high, 4),
        "washed_out_recovery_score": round(
            washed_out_recovery_score(
                saturation_ratio=saturation_ratio,
                contrast_ratio=contrast_ratio,
                exposure_delta=exposure_delta,
                clipped_high=clipped_high,
                clipped_low=clipped_low,
            ),
            4,
        ),
    }


def luma(rgb: np.ndarray) -> np.ndarray:
    return (
        rgb[..., 0] * 0.2126
        + rgb[..., 1] * 0.7152
        + rgb[..., 2] * 0.0722
    )


def saturation(rgb: np.ndarray) -> np.ndarray:
    max_channel = np.max(rgb, axis=-1)
    min_channel = np.min(rgb, axis=-1)
    chroma = max_channel - min_channel
    return np.divide(
        chroma,
        max_channel,
        out=np.zeros_like(chroma),
        where=max_channel > 0,
    )


def ratio(a: np.floating[Any], b: np.floating[Any]) -> float:
    denominator = float(b)
    if denominator == 0:
        return 0.0
    return float(a) / denominator


def washed_out_recovery_score(
    *,
    saturation_ratio: float,
    contrast_ratio: float,
    exposure_delta: float,
    clipped_high: float,
    clipped_low: float,
) -> float:
    saturation_gain = saturation_ratio - 1.0
    if saturation_gain <= 0.03:
        return saturation_gain

    score = 0.0
    score += saturation_gain * 2.2
    score += max(0.0, contrast_ratio - 1.0) * 1.2
    score -= max(0.0, -exposure_delta - 0.04) * 1.5
    score -= max(0.0, exposure_delta - 0.08) * 1.0
    score -= clipped_high * 1.5
    score -= clipped_low * 0.6
    return score


def strength_label(value: float) -> str:
    if value < 0.045:
        return "subtle"
    if value < 0.09:
        return "medium"
    return "strong"


def tags_for(traits: dict[str, float | str]) -> list[str]:
    tags = [str(traits["look_strength_label"])]
    saturation_ratio = float(traits["saturation_ratio"])
    contrast_ratio = float(traits["contrast_ratio"])
    exposure_delta = float(traits["exposure_delta"])
    warmth_delta = float(traits["warmth_delta"])
    green_magenta_delta = float(traits["green_magenta_delta"])
    black_lift = float(traits["black_lift"])
    white_shift = float(traits["white_shift"])
    score = float(traits["washed_out_recovery_score"])

    if saturation_ratio >= 1.12:
        tags.append("saturation-boost")
    elif saturation_ratio <= 0.9:
        tags.append("desaturating")

    if contrast_ratio >= 1.1:
        tags.append("higher-contrast")
    elif contrast_ratio <= 0.9:
        tags.append("lower-contrast")

    if exposure_delta >= 0.04:
        tags.append("brighter")
    elif exposure_delta <= -0.04:
        tags.append("darker")

    if warmth_delta >= 0.025:
        tags.append("warm")
    elif warmth_delta <= -0.025:
        tags.append("cool")

    if green_magenta_delta >= 0.02:
        tags.append("green-shift")
    elif green_magenta_delta <= -0.02:
        tags.append("magenta-shift")

    if black_lift >= 0.035:
        tags.append("lifted-blacks")
    elif black_lift <= -0.035:
        tags.append("crushed-blacks")

    if white_shift <= -0.035:
        tags.append("highlight-rolloff")
    elif white_shift >= 0.035:
        tags.append("bright-highlights")

    if saturation_ratio >= 1.05 and score >= 0.28:
        tags.append("washed-out-recovery-candidate")

    return tags


def category_for(path: Path) -> str:
    for part in path.parts:
        normalized = part.lower()
        if "cinematic" in normalized:
            return "cinematic"
        if "color grading" in normalized:
            return "color-grading"
        if "color moods" in normalized:
            return "color-moods"
        if "film simulation" in normalized:
            return "film-simulation"
    return "unknown"


def pack_for(path: Path) -> str:
    for part in path.parts:
        match = re.match(r"^(Q-DDL_Pack_\d+)", part)
        if match:
            return match.group(1)
    return "unknown"


def lut_id(path: Path, root: Path, title: str) -> str:
    category = category_for(path)
    pack = pack_for(path).lower().replace("_", "-")
    stem = slug(title)
    rel_hash = sha256(path.relative_to(root).as_posix().encode("utf8")).hexdigest()[:8]
    return f"q-ddl-{category}-{pack}-{stem}-{rel_hash}"


def slug(value: str) -> str:
    out = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return out or "untitled"


def category_counts(entries: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for entry in entries:
        category = str(entry["category"])
        counts[category] = counts.get(category, 0) + 1
    return dict(sorted(counts.items()))


def write_catalog_csv(path: Path, entries: list[dict[str, Any]]) -> None:
    fields = [
        "id",
        "title",
        "category",
        "pack",
        "path",
        "tags",
        "look_strength",
        "look_strength_label",
        "washed_out_recovery_score",
        "saturation_ratio",
        "contrast_ratio",
        "exposure_delta",
        "warmth_delta",
        "green_magenta_delta",
        "black_lift",
        "white_shift",
        "clipped_low_fraction",
        "clipped_high_fraction",
        "license",
        "attribution",
    ]
    with path.open("w", newline="", encoding="utf8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for entry in entries:
            writer.writerow(flatten_entry(entry))


def write_shortlist_csv(path: Path, entries: list[dict[str, Any]]) -> None:
    candidates = [
        entry
        for entry in entries
        if float(entry["traits"]["saturation_ratio"]) >= 1.05
        and float(entry["traits"]["washed_out_recovery_score"]) > 0
    ]
    ranked = sorted(
        candidates,
        key=lambda entry: (
            float(entry["traits"]["washed_out_recovery_score"]),
            float(entry["traits"]["saturation_ratio"]),
            float(entry["traits"]["contrast_ratio"]),
        ),
        reverse=True,
    )[:80]
    write_catalog_csv(path, ranked)


def flatten_entry(entry: dict[str, Any]) -> dict[str, Any]:
    traits = entry["traits"]
    return {
        "id": entry["id"],
        "title": entry["title"],
        "category": entry["category"],
        "pack": entry["pack"],
        "path": entry["path"],
        "tags": "|".join(entry["tags"]),
        "look_strength": traits["look_strength"],
        "look_strength_label": traits["look_strength_label"],
        "washed_out_recovery_score": traits["washed_out_recovery_score"],
        "saturation_ratio": traits["saturation_ratio"],
        "contrast_ratio": traits["contrast_ratio"],
        "exposure_delta": traits["exposure_delta"],
        "warmth_delta": traits["warmth_delta"],
        "green_magenta_delta": traits["green_magenta_delta"],
        "black_lift": traits["black_lift"],
        "white_shift": traits["white_shift"],
        "clipped_low_fraction": traits["clipped_low_fraction"],
        "clipped_high_fraction": traits["clipped_high_fraction"],
        "license": entry["license"],
        "attribution": entry["attribution"],
    }


def timestamp() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


if __name__ == "__main__":
    main()
