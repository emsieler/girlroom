#!/usr/bin/env bash
# Encode video → HLS (single or multi-rung ladder) → upload to Cloudflare R2 → prepend data/archive.json
#
# Loads secrets from repo-root `.dotenv` only (set -a; source).
#
# Prerequisites: ffmpeg, rclone, python3
#
# Usage:
#   INPUT="/path/to/recording.mkv" TITLE="2026-05-06 set" ./scripts/archive-to-r2.sh
#
# Env knobs (all optional):
#   MODE=single | ladder        (default single — one index.m3u8)
#   HW=cpu | nvenc              (default nvenc — set HW=cpu if no GPU)
#   SLUG=my-folder-name         (default: $(date -I)-<slug-from-title>)
#   SKIP_ENCODE=1               (re-use existing out/<SLUG>/, just upload + json)
#   SKIP_UPLOAD=1               (skip rclone, still update archive.json)
#   DRY_RUN=1                   (print plan; do nothing else)
#   RCLONE_TRANSFERS=16         (parallel file uploads — many small .ts segments)
#   RCLONE_CHECKERS=32          (parallel existence checks)
#   RCLONE_MT_STREAMS=4         (per-file streams for big files)
#   RCLONE_MT_CUTOFF=64M        (use multi-stream above this size)
#   S3_UPLOAD_CONCURRENCY=4     (rclone S3 multipart concurrency per file)
#   TRIM_START=2:53               (optional — skip leading seconds from INPUT before encode;
#                                  use instead of hacking the first .ts — binary trim breaks HLS)
#
# NOTE: this whole script is wrapped in `main()` so editing the file mid-run is safe —
# bash parses main() to its closing brace before executing it.

set -euo pipefail

main() {
  local SCRIPT_DIR ROOT
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  cd "$ROOT"

  # Preserve caller env: sourcing `.dotenv` with `set -a` must not wipe INPUT/TITLE
  # if those keys ever appear (or were empty) in .dotenv.
  local _cli_INPUT _cli_TITLE
  _cli_INPUT="${INPUT-}"
  _cli_TITLE="${TITLE-}"

  if [[ -f "$ROOT/.dotenv" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$ROOT/.dotenv"
    set +a
  else
    echo "Missing $ROOT/.dotenv — copy .dotenv.example and fill R2_* variables." >&2
    exit 1
  fi

  INPUT="${_cli_INPUT:-$INPUT}"
  TITLE="${_cli_TITLE:-$TITLE}"

  : "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID in .dotenv}"
  : "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY in .dotenv}"
  : "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID in .dotenv}"
  : "${R2_BUCKET:?set R2_BUCKET in .dotenv}"
  : "${R2_PUBLIC_BASE:?set R2_PUBLIC_BASE in .dotenv (public r2.dev or custom domain — NOT cloudflarestorage.com)}"

  R2_ENDPOINT="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
  : "${INPUT:?set INPUT=/path/to/video.mkv}"
  : "${TITLE:?set TITLE=\"Show title for archive\"}"
  local MODE HW
  MODE="${MODE:-single}"
  HW="${HW:-nvenc}"

  local -a SEEK_FLAGS=()
  if [[ -n "${TRIM_START:-}" ]]; then
    SEEK_FLAGS=(-ss "$TRIM_START")
  fi

  local VCODEC SCALE_FILTER
  local -a SINGLE_QFLAGS LADDER_PRESET INPUT_HWFLAGS
  case "$HW" in
    cpu)
      VCODEC=libx264
      SINGLE_QFLAGS=(-preset medium -crf 22)
      LADDER_PRESET=(-preset medium)
      INPUT_HWFLAGS=()
      SCALE_FILTER="scale"
      ;;
    nvenc)
      VCODEC=h264_nvenc
      SINGLE_QFLAGS=(-preset p5 -rc vbr -cq 22 -b:v 0)
      LADDER_PRESET=(-preset p5 -rc vbr)
      # Default to full GPU pipeline: decode → scale → encode all on the GPU.
      # Detect CUDA filter support at runtime; if missing, decode on GPU but
      # scale on CPU (still uses NVENC for encode).
      INPUT_HWFLAGS=(-hwaccel cuda)
      SCALE_FILTER="scale"
      if ffmpeg -hide_banner -filters 2>/dev/null | grep -q '\bscale_cuda\b'; then
        INPUT_HWFLAGS=(-hwaccel cuda -hwaccel_output_format cuda -extra_hw_frames 8)
        SCALE_FILTER="scale_cuda"
      fi
      ;;
    *)
      echo "HW must be 'cpu' or 'nvenc', got: $HW" >&2
      exit 1
      ;;
  esac

  slugify() {
    echo "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9._-]\+/-/g' -e 's/^-\|-$//g' | cut -c1-80
  }

  local SLUG OUT MASTER_NAME PLAYLIST_URL
  SLUG="${SLUG:-$(date -I)-$(slugify "$TITLE")}"
  OUT="$ROOT/out/${SLUG}"
  MASTER_NAME="master.m3u8"
  PLAYLIST_URL="${R2_PUBLIC_BASE%/}/${SLUG}/${MASTER_NAME}"

  if [[ "${DRY_RUN:-}" == "1" ]]; then
    echo "DRY_RUN=1 — no encode, upload, or json changes."
    echo "  MODE=$MODE  HW=$HW  SLUG=$SLUG  INPUT=$INPUT"
    echo "  OUT=$OUT"
    echo "  Would upload to s3://${R2_BUCKET}/${SLUG}/"
    echo "  Public playlist would be: $PLAYLIST_URL (ladder) or .../index.m3u8 (single)"
    echo "  TRIM_START=${TRIM_START:-<none>}"
    exit 0
  fi

  echo "==> MODE=$MODE  HW=$HW  VCODEC=$VCODEC  SLUG=$SLUG"
  echo "==> OUT=$OUT"
  if [[ -n "${TRIM_START:-}" ]]; then
    echo "==> TRIM_START=$TRIM_START (leading portion dropped from INPUT)"
  fi

  if [[ "${SKIP_ENCODE:-}" != "1" && "$VCODEC" == "h264_nvenc" ]]; then
    if ! ffmpeg -hide_banner -encoders 2>/dev/null | grep -q 'h264_nvenc'; then
      echo "HW=nvenc but this ffmpeg has no h264_nvenc. Use HW=cpu or an NVENC-capable ffmpeg build." >&2
      exit 1
    fi
  fi

  if [[ "${SKIP_ENCODE:-}" != "1" ]]; then
    rm -rf "$OUT"
    mkdir -p "$OUT"

    if [[ "$MODE" == "single" ]]; then
      echo "==> Encoding single-rendition HLS  (${VCODEC}${INPUT_HWFLAGS:+, hwaccel})…"
      ffmpeg -hide_banner -y "${INPUT_HWFLAGS[@]}" -i "$INPUT" \
        -c:v "$VCODEC" "${SINGLE_QFLAGS[@]}" \
        -c:a aac -b:a 160k -ac 2 \
        -f hls -hls_time 6 -hls_playlist_type vod \
        -hls_segment_filename "${OUT}/seg_%03d.ts" \
        "${OUT}/index.m3u8"
    elif [[ "$MODE" == "ladder" ]]; then
      echo "==> Encoding multi-rung HLS (1080p / 720p / 480p)  (${VCODEC}, scale=${SCALE_FILTER})…"
      mkdir -p "${OUT}/v0" "${OUT}/v1" "${OUT}/v2"

      local FILTER_CHAIN
      if [[ "$SCALE_FILTER" == "scale_cuda" ]]; then
        # CUDA frames stay on the GPU through split + scale_cuda → NVENC.
        FILTER_CHAIN="[0:v]split=3[s1][s2][s3];[s1]${SCALE_FILTER}=-2:1080[v1];[s2]${SCALE_FILTER}=-2:720[v2];[s3]${SCALE_FILTER}=-2:480[v3]"
      else
        FILTER_CHAIN="[0:v]split=3[s1][s2][s3];[s1]${SCALE_FILTER}=-2:1080,format=yuv420p,setsar=1[v1];[s2]${SCALE_FILTER}=-2:720,format=yuv420p,setsar=1[v2];[s3]${SCALE_FILTER}=-2:480,format=yuv420p,setsar=1[v3]"
      fi

      ffmpeg -hide_banner -y "${INPUT_HWFLAGS[@]}" -i "$INPUT" \
        -filter_complex "$FILTER_CHAIN" \
        -map "[v1]" -map "[v2]" -map "[v3]" -map "0:a:0" \
        -c:v:0 "$VCODEC" "${LADDER_PRESET[@]}" -b:v:0 5000k -maxrate:v:0 5500k -bufsize:v:0 11000k -g 60 -keyint_min 60 -sc_threshold 0 \
        -c:v:1 "$VCODEC" "${LADDER_PRESET[@]}" -b:v:1 2800k -maxrate:v:1 3100k -bufsize:v:1 6200k -g 60 -keyint_min 60 -sc_threshold 0 \
        -c:v:2 "$VCODEC" "${LADDER_PRESET[@]}" -b:v:2 1200k -maxrate:v:2 1400k -bufsize:v:2 2800k -g 60 -keyint_min 60 -sc_threshold 0 \
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
  else
    echo "==> SKIP_ENCODE=1 — using existing $OUT"
    [[ -d "$OUT" ]] || { echo "No such dir: $OUT" >&2; exit 1; }
  fi

  # Determine canonical playlist URL based on what's actually in OUT.
  if [[ -f "$OUT/index.m3u8" && ! -f "$OUT/$MASTER_NAME" ]]; then
    PLAYLIST_URL="${R2_PUBLIC_BASE%/}/${SLUG}/index.m3u8"
  fi

  if [[ "${SKIP_UPLOAD:-}" != "1" ]]; then
    local TRANSFERS CHECKERS MT_STREAMS MT_CUTOFF S3_CONC S3_CHUNK
    TRANSFERS="${RCLONE_TRANSFERS:-16}"
    CHECKERS="${RCLONE_CHECKERS:-32}"
    MT_STREAMS="${RCLONE_MT_STREAMS:-4}"
    MT_CUTOFF="${RCLONE_MT_CUTOFF:-64M}"
    S3_CONC="${S3_UPLOAD_CONCURRENCY:-4}"
    S3_CHUNK="${S3_CHUNK_SIZE:-32M}"

    echo "==> Uploading to R2 bucket ${R2_BUCKET}/${SLUG}/  (transfers=$TRANSFERS, mt-streams=$MT_STREAMS)"
    rclone copy "$OUT/" ":s3:${R2_BUCKET}/${SLUG}" \
      --s3-provider=Cloudflare \
      --s3-access-key-id="$R2_ACCESS_KEY_ID" \
      --s3-secret-access-key="$R2_SECRET_ACCESS_KEY" \
      --s3-endpoint="$R2_ENDPOINT" \
      --s3-region=auto \
      --s3-upload-concurrency="$S3_CONC" \
      --s3-chunk-size="$S3_CHUNK" \
      --transfers="$TRANSFERS" \
      --checkers="$CHECKERS" \
      --multi-thread-streams="$MT_STREAMS" \
      --multi-thread-cutoff="$MT_CUTOFF" \
      --fast-list \
      --progress
  else
    echo "==> SKIP_UPLOAD=1 — skipping rclone."
  fi

  export ROOT PLAYLIST_URL
  export ENTRY_ID="$SLUG"
  export ENTRY_DATE
  ENTRY_DATE="$(date -I)"
  export TITLE

  python3 - <<'PY'
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
# Idempotent: replace any prior entry with the same id, else prepend.
data = [e for e in data if e.get("id") != entry["id"]]
data.insert(0, entry)
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print("Wrote archive entry:", path)
PY

  echo
  echo "Done. Public playlist URL:"
  echo "  $PLAYLIST_URL"
  echo "Hard-refresh the site. New entry is first in data/archive.json."
}

main "$@"
