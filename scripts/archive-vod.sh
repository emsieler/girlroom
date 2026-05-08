#!/usr/bin/env bash
# Post-stream: MP4 → HLS (VOD) → upload to Cloudflare R2 → print archive.json snippet
#
# For a **multi-bitrate ladder** (1080p + 720p + 480p), see README.md — the one-liner
# below is intentionally simple so it works on any recent ffmpeg.
#
# Prerequisites: ffmpeg, rclone (configured: `rclone config`)
#
# Usage:
#   SLUG=2026-05-07-show-name \
#   INPUT=./recording.mp4 \
#   R2_REMOTE=r2:girlroom-archive \
#   PUBLIC_BASE=https://cdn.girlroom.com \
#   ./scripts/archive-vod.sh
#
# After upload, delete the Mux asset in the Mux dashboard to stop VOD storage billing.

set -euo pipefail

SLUG="${SLUG:?set SLUG=unique-folder-name}"
INPUT="${INPUT:?set INPUT=path/to/recording.mp4}"
R2_REMOTE="${R2_REMOTE:?set R2_REMOTE=r2:bucket/prefix}"
PUBLIC_BASE="${PUBLIC_BASE:?set PUBLIC_BASE=https://cdn.example.com}"

OUT="out/${SLUG}"
rm -rf "${OUT}"
mkdir -p "${OUT}"

ffmpeg -y -i "${INPUT}" \
  -c:v libx264 -preset slow -crf 21 \
  -c:a aac -b:a 160k \
  -f hls -hls_time 6 -hls_playlist_type vod \
  -hls_segment_filename "${OUT}/seg%03d.ts" \
  "${OUT}/index.m3u8"

rclone copy "${OUT}/" "${R2_REMOTE}/${SLUG}/" --progress

PLAYLIST_URL="${PUBLIC_BASE%/}/${SLUG}/index.m3u8"
echo "Uploaded. Playlist URL:"
echo "${PLAYLIST_URL}"
echo
echo "Append this object to data/archive.json (newest first):"
cat <<EOF
{
  "id": "${SLUG}",
  "title": "CHANGE ME",
  "date": "$(date -I)",
  "poster": "",
  "hls": "${PLAYLIST_URL}"
},
EOF
