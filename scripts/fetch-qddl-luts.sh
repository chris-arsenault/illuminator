#!/usr/bin/env bash
set -euo pipefail

# Downloads the Q-DDL CC BY 4.0 LUT collection into a gitignored local cache.
# The original quickddl.net host is no longer resolving, so these URLs use the
# Photoshoplus mirror of the original Q-DDL zip files.

target_dir="${1:-third_party/luts/q-ddl}"
archive_dir="$target_dir/archives"
extract_dir="$target_dir/extracted"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$archive_dir" "$extract_dir"

names=(
  "cinematic"
  "color-grading"
  "color-moods"
  "film-simulation"
)

urls=(
  "https://www.photoshoplus.fr/download/q-ddl-color-luts-cinematic-5-packs/"
  "https://www.photoshoplus.fr/download/q-ddl-color-luts-color-grading-5-packs/"
  "https://www.photoshoplus.fr/download/q-ddl-color-luts-color-moods-5-packs/"
  "https://www.photoshoplus.fr/download/q-ddl-color-luts-film-simulation-5-packs/"
)

for index in "${!urls[@]}"; do
  archive="$archive_dir/q-ddl-${names[$index]}.zip"
  if [[ ! -s "$archive" ]]; then
    curl \
      --location \
      --fail \
      --max-time 180 \
      --user-agent "Mozilla/5.0" \
      --output "$archive" \
      "${urls[$index]}"
  fi
  unzip -oq "$archive" -d "$extract_dir"
done

while IFS= read -r -d "" nested_zip; do
  nested_dir="${nested_zip%.zip}"
  mkdir -p "$nested_dir"
  unzip -oq "$nested_zip" -d "$nested_dir"
done < <(find "$extract_dir" -mindepth 2 -name "*.zip" -print0)

echo "Q-DDL archives: $(find "$archive_dir" -maxdepth 1 -name '*.zip' | wc -l)"
echo "Q-DDL .cube files: $(find "$extract_dir" -type f -iname '*.cube' | wc -l)"
echo "Local cache: $target_dir"

python3 "$script_dir/catalog-luts.py" "$target_dir"
