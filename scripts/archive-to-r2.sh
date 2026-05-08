#!/usr/bin/env bash
# Encode video → HLS (single or multi-rung ladder) → upload to Cloudflare R2 → prepend data/archive.json
#
# Loads secrets from repo-root `.dotenv` only (set -a; source).
#
# Prerequisites: ffmpeg, rclone, python3
#
# Usage (single-rendition HLS — default):
#   INPUT="/path/to/recording.mkv" \
#   TITLE="2026-05-06 set" \
#   ./scripts/archive-to-r2.sh
#
# Multi-rung ladder (slow, large upload):
#   MODE=ladder INPUT="/path/to/file.mkv" TITLE="..." ./scripts/archive-to-r2.sh
#
# Optional: SLUG=my-folder-name   DRY_RUN=1   (print plan; no encode/upload/json)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.dotenv" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.dotenv"
  set +a
else
  echo "Missing $ROOT/.dotenv — copy .dotenv.example and fill R2_* variables." >&2
  exit 1
fi

: "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID in .dotenv}"
: "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY in .dotenv}"
: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID in .dotenv}"
: "${R2_BUCKET:?set R2_BUCKET in .dotenv}"
: "${R2_PUBLIC_BASE:?set R2_PUBLIC_BASE in .dotenv (public r2.dev or custom domain — NOT cloudflarestorage.com)}"

R2_ENDPOINT="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
MODE="${MODE:-single}"
INPUT="${INPUT:?set INPUT=/path/to/video.mkv}"
TITLE="${TITLE:?set TITLE=\"Show title for archive\"}"

slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9._-]\+/-/g' -e 's/^-\|-$//g' | cut -c1-80
}

SLUG="${SLUG:-$(date -I)-$(slugify "$TITLE")}"
OUT="$ROOT/out/${SLUG}"
MASTER_NAME="master.m3u8"
PLAYLIST_URL="${R2_PUBLIC_BASE%/}/${SLUG}/${MASTER_NAME}"

if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "DRY_RUN=1 — no encode, upload, or json changes."
  echo "  MODE=$MODE  SLUG=$SLUG  INPUT=$INPUT"
  echo "  Would upload to s3://${R2_BUCKET}/${SLUG}/"
  echo "  Public playlist would be: $PLAYLIST_URL (ladder) or .../index.m3u8 (single)"
  exit 0
fi

echo "==> MODE=$MODE  SLUG=$SLUG  OUT=$OUT"
rm -rf "$OUT"
mkdir -p "$OUT"

if [[ "$MODE" == "single" ]]; then
  echo "==> Encoding single-rendition HLS…"
  ffmpeg -hide_banner -y -i "$INPUT" \
    -c:v libx264 -preset medium -crf 22 \
    -c:a aac -b:a 160k -ac 2 \
    -f hls -hls_time 6 -hls_playlist_type vod \
    -hls_segment_filename "${OUT}/seg_%03d.ts" \
    "${OUT}/index.m3u8"
  PLAYLIST_URL="${R2_PUBLIC_BASE%/}/${SLUG}/index.m3u8"
elif [[ "$MODE" == "ladder" ]]; then
  echo "==> Encoding multi-rung HLS (1080p / 720p / 480p) — this can take a long time…"
  mkdir -p "${OUT}/v0" "${OUT}/v1" "${OUT}/v2"
  # Requires at least one audio stream; if video-only, add -f lavfi -i anullsrc=... first.
  ffmpeg -hide_banner -y -i "$INPUT" \
    -filter_complex "[0:v]split=3[s1][s2][s3];[s1]scale=-2:1080,format=yuv420p,setsar=1[v1];[s2]scale=-2:720,format=yuv420p,setsar=1[v2];[s3]scale=-2:480,format=yuv420p,setsar=1[v3]" \
    -map "[v1]" -map "[v2]" -map "[v3]" -map "0:a:0" \
    -c:v:0 libx264 -preset medium -b:v:0 5000k -maxrate:v:0 5500k -bufsize:v:0 11000k -g 60 -keyint_min 60 -sc_threshold 0 \
    -c:v:1 libx264 -preset medium -b:v:1 2800k -maxrate:v:1 3100k -bufsize:v:1 6200k -g 60 -keyint_min 60 -sc_threshold 0 \
    -c:v:2 libx264 -preset medium -b:v:2 1200k -maxrate:v:2 1400k -bufsize:v:2 2800k -g 60 -keyint_min 60 -sc_threshold 0 \
    -c:a:0 aac -b:a:0 128k -ac 2 \
    -f hls -hls_time 6 -hls_playlist_type vod \
    -hls_segment_type mpegts \
    -master_pl_name "$MASTER_NAME" \
    -var_stream_map "v:0,a:3 v:1,a:3 v:2,a:3" \
    -hls_segment_filename "${OUT}/v%v/seg_%03d.ts" \
    "${OUT}/v%v.m3u8"
else
  echo "MODE must be 'single' or 'ladder', got: $MODE" >&2
  exit 1
fi

echo "==> Uploading to R2 bucket ${R2_BUCKET}/${SLUG}/ …"
rclone copy "$OUT/" ":s3:${R2_BUCKET}/${SLUG}" \
  --s3-provider=Cloudflare \
  --s3-access-key-id="$R2_ACCESS_KEY_ID" \
  --s3-secret-access-key="$R2_SECRET_ACCESS_KEY" \
  --s3-endpoint="$R2_ENDPOINT" \
  --s3-region=auto \
  --progress

export ROOT PLAYLIST_URL
export ENTRY_ID="$SLUG"
export ENTRY_DATE="$(date -I)"
export TITLE

python3 <<'PY'
import json, os, pathlib

root = pathlib.Path(os.environ["ROOT"])
path = root / "data" / "archive.json"
entry = {
    "id": os.environ["ENTRY_ID"],
    "title": os.environ["TITLE"],
    "date": os.environ["ENTRY_DATE"],
    "poster": "",
    "hls": os.environ["PLAYLIST_URL"],
}
data = json.loads(path.read_text(encoding="utf-8"))
if not isinstance(data, list):
    raise SystemExit("archive.json must be a JSON array")
data.insert(0, entry)
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print("Prepended archive entry:", path)
PY

echo
echo "Done. Public playlist URL:"
echo "  $PLAYLIST_URL"
echo "Hard-refresh the site. New entry is first in data/archive.json."
