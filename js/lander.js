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
      b.classList.add("is-active");
    }
    b.addEventListener("click", () => onPick(item));
    strip.appendChild(b);
  }
}

async function switchSource(video, src, mode, startAt = 0) {
  if (playerHandle?.destroy) playerHandle.destroy();
  detachPlayer(video);
  playerHandle = await attachHls(video, src, { live: mode === "live" });
  setVodControlsVisible(mode === "vod");

  // Seek to the requested offset on first metadata load. Live mode never seeks.
  if (mode === "vod" && Number.isFinite(startAt) && startAt > 0) {
    const seekOnce = () => {
      const dur = video.duration;
      const target = Number.isFinite(dur) && dur > 0 ? Math.min(startAt, dur - 0.25) : startAt;
      try {
        video.currentTime = target;
      } catch {
        /* some readyStates reject seeks; ignore */
      }
    };
    video.addEventListener("loadedmetadata", seekOnce, { once: true });
  }
}

function isLocalHost() {
  try {
    const h = window.location.hostname;
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "::1" ||
      h === "0.0.0.0" ||
      h.endsWith(".local") ||
      window.location.protocol === "file:"
    );
  } catch {
    return false;
  }
}

function setupDevMode() {
  if (!isLocalHost()) return;

  const KEY = "gr.devMode";
  let on = false;
  try {
    on = localStorage.getItem(KEY) === "1";
  } catch {
    /* private mode etc. */
  }

  const apply = (val) => {
    document.documentElement.classList.toggle("dev-mode", !!val);
  };
  apply(on);

  const wrap = document.createElement("label");
  wrap.className = "dev-toggle";
  wrap.title = "Dev mode (localhost only): show the VOD strip";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = on;
  cb.setAttribute("aria-label", "dev mode");

  const text = document.createElement("span");
  text.textContent = "dev";

  cb.addEventListener("change", () => {
    apply(cb.checked);
    try {
      localStorage.setItem(KEY, cb.checked ? "1" : "0");
    } catch {
      /* ignore */
    }
  });

  wrap.appendChild(cb);
  wrap.appendChild(text);
  document.body.appendChild(wrap);
}

async function main() {
  setupDevMode();

  const [config, streamCfg, archive, sides] = await Promise.all([
    loadJson("data/config.json"),
    loadJson("data/stream.json"),
    loadJson("data/archive.json"),
    loadJson("data/sides.json"),
  ]);

  const marqueeEl = qs("marqueeText");
  const marqueeTemplate = config.marqueeText || "";
  const setMarquee = (artist) => {
    const text = marqueeTemplate
      .replace(/\{artist\}/g, (artist || "").toString())
      .trim();
    marqueeEl.innerHTML = "";
    for (let i = 0; i < 2; i++) {
      const chunk = document.createElement("span");
      chunk.className = "marquee__chunk";
      if (i === 1) chunk.setAttribute("aria-hidden", "true");
      chunk.textContent = text;
      marqueeEl.appendChild(chunk);
    }
  };
  setMarquee("");

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
  const initialStartAt = Number(resolved?.newest?.startAt) || 0;
  const initialArtist =
    resolved.mode === "live"
      ? streamCfg?.artist || ""
      : resolved?.newest?.artist || "";
  setMarquee(initialArtist);
  await switchSource(video, resolved.src, resolved.mode, initialStartAt);
  try {
    await video.play();
  } catch {
    // Some browsers refuse autoplay until first interaction; user can click play.
  }

  const onPick = async (item) => {
    const isLive = item?.live === true;
    liveBadge.hidden = !isLive;
    const pickStartAt = isLive ? 0 : Number(item?.startAt) || 0;
    setMarquee(item?.artist || "");
    await switchSource(video, item.hls, isLive ? "live" : "vod", pickStartAt);
    try {
      await video.play();
    } catch {
      /* user can manually click play */
    }
    renderVodStrip(resolved.list, item.hls, onPick);
  };
  renderVodStrip(resolved.list, resolved.src, onPick);

  const playPauseBtn = qs("btnPlayPause");
  const refreshPlayPause = () => {
    const playing = !video.paused && !video.ended;
    playPauseBtn.textContent = playing ? "pause" : "play";
    playPauseBtn.setAttribute("aria-label", playing ? "pause" : "play");
  };
  playPauseBtn.addEventListener("click", () => {
    if (video.paused || video.ended) {
      video.play().catch(() => {
        /* user may need a second click after autoplay block */
      });
    } else {
      video.pause();
    }
  });
  video.addEventListener("play", refreshPlayPause);
  video.addEventListener("pause", refreshPlayPause);
  video.addEventListener("ended", refreshPlayPause);
  video.addEventListener("playing", refreshPlayPause);
  refreshPlayPause();

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

  const imacRoot = document.getElementById("imacRoot");
  let diveBusy = false;

  function clearImmersive() {
    document.documentElement.classList.remove(
      "immersive-dive",
      "immersive-dive--go"
    );
    if (imacRoot) {
      imacRoot.style.removeProperty("--dive-scale");
      imacRoot.style.removeProperty("--dive-origin-x");
      imacRoot.style.removeProperty("--dive-origin-y");
    }
  }

  document.addEventListener("fullscreenchange", () => {
    // Only act on EXIT here; entry is orchestrated by enterFullscreenWithDive.
    if (!document.fullscreenElement) {
      clearImmersive();
      diveBusy = false;
    }
  });

  /** @param {Element} el */
  async function requestFs(el) {
    const anyEl = /** @type {Element & { webkitRequestFullscreen?: () => void }} */ (
      el
    );
    if (el.requestFullscreen) return el.requestFullscreen();
    if (typeof anyEl.webkitRequestFullscreen === "function") {
      anyEl.webkitRequestFullscreen();
      return;
    }
    throw new Error("fullscreen not supported");
  }

  async function enterFullscreenWithDive() {
    const wrap = qs("playerWrap");

    if (document.fullscreenElement) return;
    if (diveBusy) return;

    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Fast / fallback path: no imac, reduced motion, or non-supporting browser.
    // Just enter native fullscreen on document, then on player, then on video.
    if (!imacRoot || reduced) {
      try {
        await requestFs(document.documentElement);
      } catch {
        try {
          await requestFs(wrap);
        } catch {
          const v = /** @type {HTMLVideoElement & { webkitEnterFullscreen?: () => void }} */ (
            video
          );
          if (typeof v.webkitEnterFullscreen === "function") v.webkitEnterFullscreen();
        }
      }
      return;
    }

    diveBusy = true;

    // 1) Start fading surrounding chrome BEFORE we go fullscreen, so by the
    //    time the browser transitions to fullscreen the page UI is already
    //    on its way out.
    document.documentElement.classList.add("immersive-dive");

    // 2) Go fullscreen on the WHOLE PAGE so the BROWSER chrome (tabs, URL
    //    bar) disappears. Without this the dive renders under the toolbar
    //    and looks weird.
    try {
      await requestFs(document.documentElement);
    } catch {
      // Element-level fullscreen on root not supported — fall back without
      // the dive (iOS Safari etc.).
      document.documentElement.classList.remove("immersive-dive");
      try {
        await requestFs(wrap);
      } catch {
        const v = /** @type {HTMLVideoElement & { webkitEnterFullscreen?: () => void }} */ (
          video
        );
        if (typeof v.webkitEnterFullscreen === "function") v.webkitEnterFullscreen();
      }
      diveBusy = false;
      return;
    }

    // 3) Wait for fullscreen layout to settle, then measure rects in the
    //    NEW (chrome-less) viewport so origin + scale are correct.
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r))
    );

    const ir = imacRoot.getBoundingClientRect();
    const sr = wrap.getBoundingClientRect();
    const ox = ((sr.left + sr.width / 2 - ir.left) / ir.width) * 100;
    const oy = ((sr.top + sr.height / 2 - ir.top) / ir.height) * 100;
    imacRoot.style.setProperty("--dive-origin-x", `${ox}%`);
    imacRoot.style.setProperty("--dive-origin-y", `${oy}%`);
    const scale =
      Math.max(window.innerWidth / sr.width, window.innerHeight / sr.height) *
      1.06;
    imacRoot.style.setProperty("--dive-scale", String(scale));

    // 4) Kick off the scale transition inside fullscreen.
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r))
    );
    document.documentElement.classList.add("immersive-dive--go");

    diveBusy = false;
  }

  qs("btnFs").addEventListener("click", () => {
    if (document.fullscreenElement) {
      const d = document;
      if (d.exitFullscreen) void d.exitFullscreen();
      else if (d.webkitExitFullscreen) d.webkitExitFullscreen();
    } else {
      void enterFullscreenWithDive();
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

  const scrubber = /** @type {HTMLInputElement} */ (qs("scrubber"));
  const timeDisplay = qs("timeDisplay");
  let scrubbing = false;

  const fmtTime = (s) => {
    if (!isFinite(s) || s < 0) return "0:00";
    const total = Math.floor(s);
    const m = Math.floor(total / 60);
    const sec = total % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      const mm = m % 60;
      return `${h}:${String(mm).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    }
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  const setScrubFill = () => {
    const pct = Number(scrubber.value) / 10;
    scrubber.style.setProperty("--scrub-fill", `${pct}%`);
  };

  const refreshScrubber = () => {
    if (!isFinite(video.duration) || video.duration <= 0) return;
    if (!scrubbing) {
      scrubber.value = String(
        Math.round((video.currentTime / video.duration) * 1000)
      );
      setScrubFill();
    }
    timeDisplay.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
  };

  video.addEventListener("loadedmetadata", refreshScrubber);
  video.addEventListener("durationchange", refreshScrubber);
  video.addEventListener("timeupdate", refreshScrubber);

  scrubber.addEventListener("input", () => {
    setScrubFill();
    if (!isFinite(video.duration) || video.duration <= 0) return;
    scrubbing = true;
    const t = (Number(scrubber.value) / 1000) * video.duration;
    timeDisplay.textContent = `${fmtTime(t)} / ${fmtTime(video.duration)}`;
  });
  scrubber.addEventListener("change", () => {
    if (isFinite(video.duration) && video.duration > 0) {
      video.currentTime = (Number(scrubber.value) / 1000) * video.duration;
    }
    scrubbing = false;
  });
  scrubber.addEventListener("pointerdown", () => {
    scrubbing = true;
  });
  scrubber.addEventListener("pointerup", () => {
    scrubbing = false;
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
  banner.className = "fatal-banner";
  banner.textContent = String(err.message || err);
  document.body.appendChild(banner);
});
