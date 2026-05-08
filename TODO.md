# girl room — TODO

Loose, low-pressure list. Edit freely.

## Infra / production switches

- [ ] **Buy domain `girlroom.com`** (Cloudflare Registrar / Namecheap / Porkbun).
- [ ] **Switch R2 from dev URL → custom domain.**
  - R2 → bucket `girl-room` → Settings → Custom Domains → add e.g. `media.girlroom.com`.
  - Cloudflare creates the DNS + certificate automatically when the domain is in your CF account.
  - Update `R2_PUBLIC_BASE` in `.dotenv` to the new HTTPS URL.
  - Decide whether to **rewrite existing `archive.json` URLs** or only use the new domain for future uploads (rewriting is one find/replace).
- [ ] **Pick a site host:** Vercel or Cloudflare Pages.
  - Cloudflare Pages keeps everything in one vendor with R2/DNS.
  - Vercel is also free and very fast to set up.
- [ ] **Push repo to GitHub** (`gh repo create girlroom --private --source=. --remote=origin --push`).
- [ ] **Connect GitHub → host** so `git push` redeploys.
- [ ] Point `girlroom.com` (or subdomain) at the host.
- [ ] **CORS on R2 bucket** — allow `https://girlroom.com` (and any `*.vercel.app` previews).

## Streaming

- [ ] Sign up for **Mux**; create a **Live Stream**.
- [ ] In **OBS**, install [obs-multi-rtmp](https://github.com/sorayuki/obs-multi-rtmp). Two outputs:
  - Twitch (existing key, ~6000 Kbps)
  - Mux RTMPS (new URL + key, ~6000 Kbps)
- [ ] Test on ethernet → confirm **OBS Stats** shows zero dropped frames at 12 Mbps total.
- [ ] When live, paste Mux **playback URL** into `data/stream.json` → `liveHls`.
- [ ] When offline, clear `liveHls`.

## Archive workflow

- [ ] First real upload: run `scripts/archive-to-r2.sh` against `2026-05-06 20-10-34.mkv`.
- [ ] Optional: run `MODE=ladder` later to test multi-rendition HLS.
- [ ] After Mux records, **delete VOD on Mux** to stop their storage bill (we only keep on R2).
- [ ] Add **posters** to archive entries (16:9 JPG paths in `data/archive.json`).

## Site polish

- [ ] Replace placeholder text on `about.html` and `contact.html`.
- [ ] Drop a `.woff2` into `fonts/` and uncomment `@font-face` in [`css/base.css`](css/base.css). Logo currently falls back to Georgia.
- [ ] Tune iMac screen-cutout vars (`--screen-top/left/width/height`) in [`css/lander.css`](css/lander.css) once the video is real, not a sample.
- [ ] Optional: side-gallery videos — add muted MP4s, `archive-to-r2.sh` style helper, or just compress with `ffmpeg -an -c:v libx264 -crf 24 -preset slow -movflags +faststart`.

## Nice-to-have

- [ ] Tiny scheduled-show banner under marquee.
- [ ] Auto-poster generation in `archive-to-r2.sh` (`ffmpeg -ss 5 -i in -frames:v 1 poster.jpg`).
- [ ] Save player state (mute, last-played VOD) in `localStorage`.
- [ ] Mobile layout pass once design is final.
