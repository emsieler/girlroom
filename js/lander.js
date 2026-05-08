import { loadJson } from "./fetch-json.js";
import { resolvePlayback } from "./sources.js";
import { attachHls, detachPlayer } from "./player-hls.js";
import { initSideGallery } from "./side-gallery.js";

/** @type {{ destroy?: () => void } | null} */
let playerHandle = null;

function qs(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

function setVodControlsVisible(isVod) {
  document.querySelectorAll("[data-vod-only]").forEach((btn) => {
    btn.toggleAttribute("hidden", !isVod);
  });
}

function renderVodStrip(list, currentSrc, onPick) {
  const strip = qs("vodStrip");
  strip.innerHTML = "";
  if (!list || list.length <= 1) return;

  for (const item of list) {
    if (!item.hls) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = item.title || item.id || "untitled";
    b.title = item.title || "";
    if (item.hls === currentSrc) {
      b.style.borderColor = "#ff00ff";
    }
    b.addEventListener("click", () => onPick(item));
    strip.appendChild(b);
  }
}

async function switchSource(video, src, mode) {
  if (playerHandle?.destroy) playerHandle.destroy();
  detachPlayer(video);
  playerHandle = await attachHls(video, src, { live: mode === "live" });
  setVodControlsVisible(mode === "vod");
}

async function main() {
  const [config, streamCfg, archive, sides] = await Promise.all([
    loadJson("data/config.json"),
    loadJson("data/stream.json"),
    loadJson("data/archive.json"),
    loadJson("data/sides.json"),
  ]);

  const marqueeEl = qs("marqueeText");
  marqueeEl.textContent = config.marqueeText || "";

  const logoImg = document.getElementById("logoImg");
  const logoText = qs("logoText");
  if (logoImg && config.logoImage) {
    logoImg.src = config.logoImage;
    logoImg.hidden = false;
    logoText.hidden = !config.showLogoText;
  } else if (logoImg) {
    logoImg.hidden = true;
    logoText.hidden = false;
  }

  const setLineEl = (id, text) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (typeof text === "string" && text.trim().length > 0) {
      // Allow "\n" in JSON to render as line breaks.
      el.innerHTML = "";
      const parts = text.split("\n");
      parts.forEach((line, i) => {
        if (i > 0) el.appendChild(document.createElement("br"));
        el.appendChild(document.createTextNode(line));
      });
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  };
  setLineEl("presentsText", config.presentsText);
  setLineEl("tagline", config.tagline);

  const video = /** @type {HTMLVideoElement} */ (qs("mainVideo"));
  const liveBadge = qs("liveBadge");

  const params = new URLSearchParams(window.location.search);
  const forcedVod = params.get("vod");

  /** @type {{ mode: string, src: string, list: unknown[], newest?: unknown }} */
  let resolved;
  if (forcedVod) {
    const src = decodeURIComponent(forcedVod);
    resolved = { mode: "vod", src, list: archive, newest: null };
    liveBadge.hidden = true;
  } else {
    resolved = await resolvePlayback(streamCfg, archive);
    liveBadge.hidden = resolved.mode !== "live";
  }

  video.muted = true;
  video.autoplay = true;
  video.setAttribute("playsinline", "");
  await switchSource(video, resolved.src, resolved.mode);
  try {
    await video.play();
  } catch {
    // Some browsers refuse autoplay until first interaction; user can click play.
  }

  const onPick = async (item) => {
    liveBadge.hidden = true;
    await switchSource(video, item.hls, "vod");
    try {
      await video.play();
    } catch {
      /* user can manually click play */
    }
    renderVodStrip(resolved.list, item.hls, onPick);
  };
  renderVodStrip(resolved.list, resolved.src, onPick);

  qs("btnPlay").addEventListener("click", () => video.play());
  qs("btnPause").addEventListener("click", () => video.pause());

  const muteBtn = qs("btnMute");
  const refreshMute = () => {
    muteBtn.textContent = video.muted ? "unmute" : "mute";
  };
  muteBtn.addEventListener("click", () => {
    video.muted = !video.muted;
    refreshMute();
  });
  video.addEventListener("volumechange", refreshMute);
  refreshMute();
  qs("btnFs").addEventListener("click", () => {
    const wrap = qs("playerWrap");
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      wrap.requestFullscreen?.();
    }
  });
  qs("btnBack10").addEventListener("click", () => {
    video.currentTime = Math.max(0, video.currentTime - 10);
  });
  qs("btnFwd10").addEventListener("click", () => {
    video.currentTime = Math.min(
      video.duration || Infinity,
      video.currentTime + 10
    );
  });

  const leftRoot = qs("sideLeft");
  const rightRoot = qs("sideRight");
  const leftItems = Array.isArray(sides.left) ? sides.left : [];
  const rightItems = Array.isArray(sides.right) ? sides.right : [];

  const stopLeft = initSideGallery(
    leftRoot,
    leftItems,
    sides.leftCycleMs ?? 4000
  );
  const stopRight = initSideGallery(
    rightRoot,
    rightItems,
    sides.rightCycleMs ?? 4000
  );

  window.addEventListener("beforeunload", () => {
    stopLeft();
    stopRight();
    playerHandle?.destroy?.();
  });
}

main().catch((err) => {
  console.error(err);
  const banner = document.createElement("div");
  banner.style.cssText =
    "position:fixed;inset:auto 0 0 0;padding:1rem;background:#ff00ff;color:#fff;font-family:monospace;z-index:9999;";
  banner.textContent = String(err.message || err);
  document.body.appendChild(banner);
});
