# girl room

Static site for **girl room**: marquee, three-column lander (side galleries + fake-iMac video), bottom nav, archive page. Video is a real `<video>` element with **[hls.js](https://github.com/video-dev/hls.js)** — no Twitch/YouTube iframe — so the UI inside the “screen” is fully yours.

**Streaming model (recommended):**

- **OBS** sends **two RTMP outputs** (free [obs-multi-rtmp](https://github.com/sorayuki/obs-multi-rtmp) plugin): one to **Twitch**, one to **Mux Live** for the site.
- **Live on site:** Mux gives you an **HLS** (`.m3u8`) URL → `data/stream.json`.
- **Archive on site (cheap):** after each show, download the recording from Mux, run `scripts/archive-vod.sh` to package **HLS** and upload to **Cloudflare R2**, append to `data/archive.json`, then delete the Mux asset so you are not billed for long-term Mux VOD storage.

This repo is **plain HTML/CSS/JS** — no bundler. Open via a local HTTP server (required for ES modules + `fetch`).

---

## Folder layout

```text
girlroom/
  index.html              # lander
  about.html
  archive.html
  contact.html
  css/
    base.css              # reset + @font-face hook
    lander.css            # 3-column layout + iMac bezel (CSS placeholder)
    archive.css
    page.css              # inner pages
  js/
    lander.js             # wires player + galleries
    player-hls.js         # hls.js attach / detach
    sources.js            # live probe vs newest VOD
    side-gallery.js       # cross-fading left/right columns
    archive-page.js
    fetch-json.js
  data/
    config.json           # marquee text, optional logo
    stream.json           # live HLS URL (empty = VOD only)
    archive.json          # past streams (newest first)
    sides.json            # left/right media lists + per-item ms
  scripts/
    archive-vod.sh        # ffmpeg + rclone helper
  assets/
    imac-frame.png        # optional later — CSS bezel used until you add this
    side-left/  side-right/
    about/  contact/
  fonts/                  # drop .woff2 here, enable @font-face in base.css
  vercel.json             # static deploy (empty object = defaults)
  README.md
```

---

## Quick start (local)

From this directory:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`. The bundled sample `data/archive.json` entries use public test HLS URLs so the player works immediately. `data/stream.json` ships with **`liveHls` empty** so the lander stays in **VOD mode** until you paste a real Mux live playlist.

---

## Uploading your assets

Drop files in place, then edit JSON/HTML. No build step.

### iMac cutout (optional for v1)

- **Path:** `assets/imac-frame.png` (transparent center, opaque bezel).
- **Until it exists:** `css/lander.css` draws a CSS “iMac-ish” bezel around the screen. When your PNG is ready, add an `<img class="imac__frame">` layer in `index.html` and position the `<video>` underneath with absolute coordinates — tweak in CSS once the real asset dimensions are known.

### Logo

- **Screenshot / PNG:** save as e.g. `assets/logo.png`.
- In `data/config.json` add:

  ```json
  "logoImage": "assets/logo.png",
  "showLogoText": false
  ```

  Keep `showLogoText: true` if you want both image and “girl room” text.

### Custom font

1. Convert to **`.woff2`** (e.g. with [google/woff2](https://github.com/google/woff2) or any desktop converter).
2. Put `fonts/YourFont.woff2` in this repo.
3. Uncomment / edit the `@font-face` block at the bottom of `css/base.css`.

### Side galleries (images, GIFs, silent video)

1. Put files under `assets/side-left/` and `assets/side-right/`.
2. Edit `data/sides.json`:

   ```json
   {
     "leftCycleMs": 4000,
     "rightCycleMs": 5000,
     "left": [
       { "src": "assets/side-left/a.png" },
       { "src": "assets/side-left/b.gif", "ms": 8000 },
       { "src": "assets/side-left/loop.mp4", "type": "video", "ms": 12000 }
     ],
     "right": [
       { "src": "assets/side-right/c.jpg", "ms": 3000 }
     ]
   }
   ```

   - **`leftCycleMs` / `rightCycleMs`:** default hold time when an item has no `ms`.
   - **`ms` per item:** optional override in milliseconds.
   - **`type`:** omit for auto-detect from extension; use `"video"` for `.mp4` / `.webm` / `.mov`.
   - **Videos in the side columns must be silent** (`muted` is forced) or browsers block autoplay.

### Marquee text

Edit `data/config.json` → `marqueeText` (single long string; CSS scrolls it).

### About / Contact pages

- Put images in `assets/about/` and `assets/contact/`.
- Edit `about.html` / `contact.html` — add `<figure><img src="assets/about/…" alt=""></figure>` and your copy.

### Archive entries

`data/archive.json` is a JSON **array**, **newest first**:

```json
[
  {
    "id": "2026-05-07-set-name",
    "title": "DJ ATTENTION b2b …",
    "date": "2026-05-07",
    "poster": "assets/posters/that-night.jpg",
    "hls": "https://cdn.girlroom.com/vods/2026-05-07/index.m3u8"
  }
]
```

- **`hls`:** must be a full URL (R2 public bucket or custom `cdn.` subdomain).
- **`poster`:** optional; empty string shows a gray placeholder on `archive.html`.

Clicking a card on `archive.html` sends you to `index.html?vod=<encoded-url>` so the lander opens that VOD directly.

---

## OBS: dual RTMP (Twitch + Mux)

1. Install **[obs-multi-rtmp](https://github.com/sorayuki/obs-multi-rtmp)**.
2. **Output 1 — Twitch:** normal Twitch RTMP + stream key, ~1080p60 @ 6000 Kbps (or Twitch’s recommended settings).
3. **Output 2 — Mux:** in the Mux dashboard, create a **Live Stream**, copy **RTMPS URL + stream key** into the second OBS output. Match resolution/fps to output 1; same ~6000 Kbps is fine if your **upload** can sustain **both** (~12 Mbps + headroom). Use **Ethernet** from the streaming PC to your router.
4. Encoder: **NVENC / AMF / QuickSync** (hardware) so CPU/GPU effects do not starve encoding.

When you are **live**, paste the Mux **playback** `.m3u8` into `data/stream.json`:

```json
{
  "liveHls": "https://stream.mux.com/....m3u8",
  "probeTimeoutMs": 4000
}
```

The lander **GETs** that URL; if the response looks like a valid HLS manifest (`#EXTM3U`), it switches to **LIVE** mode (±10s buttons hidden). If the probe fails (offline, wrong URL, CORS), it falls back to the newest `archive.json` entry.

When you go **offline**, clear `liveHls` back to `""` or remove the key so visitors do not hammer a dead playlist.

---

## Post-stream: cheap archive on R2

1. **Download** the finished recording from Mux (MP4) to your machine.
2. Configure **rclone** for Cloudflare R2 (`rclone config` — S3-compatible endpoint, access key, secret).
3. Run:

   ```bash
   SLUG=2026-05-07-show-name \
   INPUT=./recording.mp4 \
   R2_REMOTE=r2:girlroom-vods \
   PUBLIC_BASE=https://cdn.girlroom.com \
   ./scripts/archive-vod.sh
   ```

   The script runs **ffmpeg** (single-rendition HLS for reliability) then **rclone copy**, then prints a JSON snippet to paste at the **top** of `data/archive.json`.

4. In the Mux dashboard, **delete** the asset you no longer need stored there.

### Multi-bitrate ladder (optional, better ABR)

The shipped script uses **one** quality for simplicity. For a 3-rung ladder, run a separate ffmpeg recipe (example pattern — tune bitrates/gops to taste):

```bash
ffmpeg -y -i input.mp4 \
  -filter_complex "[0:v]split=3[v1][v2][v3]; \
    [v1]scale=-2:1080[v1o]; [v2]scale=-2:720[v2o]; [v3]scale=-2:480[v3o]" \
  -map "[v1o]" -map a:0? -c:v:0 libx264 -b:v:0 5000k -maxrate:v:0 5500k -bufsize:v:0 11000k -g 120 \
  -map "[v2o]" -map a:0? -c:v:1 libx264 -b:v:1 2800k -maxrate:v:1 3100k -bufsize:v:1 6200k -g 120 \
  -map "[v3o]" -map a:0? -c:v:2 libx264 -b:v:2 1200k -maxrate:v:2 1400k -bufsize:v:2 2800k -g 120 \
  -c:a aac -b:a 128k \
  -f hls -hls_time 6 -hls_playlist_type vod -master_pl_name master.m3u8 \
  -var_stream_map "v:0,a:0 v:1,a:0 v:2,a:0" \
  -hls_segment_filename "out/seg_%v_%03d.ts" "out/v%v.m3u8"
```

Then upload the whole `out/` folder to R2 and point `hls` at `…/master.m3u8`.

### Side-column web video (optional helper)

```bash
ffmpeg -y -i heavy.mov -an -c:v libx264 -crf 24 -preset slow -movflags +faststart out/loop.mp4
```

`-an` strips audio so autoplay is allowed in the side galleries.

---

## R2 + CORS

On the R2 bucket serving `*.m3u8` / `*.ts`, set **CORS** to allow `GET` from your site origin (`https://girlroom.com` and your preview domain). If CORS is wrong, the browser will block `fetch` during the live probe and/or **hls.js** segment fetches.

---

## Deploy

1. `git init` (already done if you cloned this) → commit → push to GitHub.
2. **Vercel** or **Cloudflare Pages:** “Import Git repository”, root = this folder, framework = **Other** / static, no build command.
3. Point DNS (`girlroom.com`) at the host.

`vercel.json` is `{}` — Vercel serves static files as-is.

---

## Git

```bash
cd girlroom
git status
git add -A
git commit -m "Describe your change"
```

Create the GitHub repo separately, then:

```bash
git remote add origin git@github.com:YOURUSER/girlroom.git
git branch -M main
git push -u origin main
```

---

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Blank player / module errors | Opened `index.html` as `file://` — use `python3 -m http.server` |
| Live never engages | Bad `liveHls`, offline stream, or CORS blocking the manifest probe |
| Gray archive cards | Empty `poster` field — add a JPG path |
| Side videos do not autoplay | Audio track present — re-encode with `-an` |
| OBS “dropped frames (network)” | Wi-Fi jitter or upload saturated — use Ethernet, lower one bitrate |

## License / rights

Fonts, images, and recordings you add are yours — keep their licenses in mind. The scaffold HTML/CSS/JS is yours to modify with no attribution requirement from this repo.
