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

  // Build a chunk node from the template. Anything wrapped in *...* becomes
  // a <strong><em>...</em></strong> for visual emphasis inside the ASCII art.
  // Built node-by-node (no innerHTML) so unicode in the template can't be
  // misinterpreted as markup.
  const buildMarqueeChunk = (text) => {
    const chunk = document.createElement("span");
    chunk.className = "marquee__chunk";
    const re = /\*([^*]+)\*/g;
    let i = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > i) {
        chunk.appendChild(document.createTextNode(text.slice(i, m.index)));
      }
      const strong = document.createElement("strong");
      const em = document.createElement("em");
      em.textContent = m[1];
      strong.appendChild(em);
      chunk.appendChild(strong);
      i = m.index + m[0].length;
    }
    if (i < text.length) {
      chunk.appendChild(document.createTextNode(text.slice(i)));
    }
    return chunk;
  };

  const setMarquee = (artist) => {
    const text = marqueeTemplate
      .replace(/\{artist\}/g, (artist || "").toString())
      .trim();
    marqueeEl.innerHTML = "";
    for (let i = 0; i < 2; i++) {
      const chunk = buildMarqueeChunk(text);
      if (i === 1) chunk.setAttribute("aria-hidden", "true");
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
    const matched =
      Array.isArray(archive) &&
      archive.find(
        (e) =>
          e &&
          typeof e.hls === "string" &&
          e.hls === src
      );
    // Match archive row so `startAt` / `artist` apply (e.g. archive → ?vod=…).
    resolved = { mode: "vod", src, list: archive, newest: matched || null };
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
  const togglePlay = () => {
    if (video.paused || video.ended) {
      video.play().catch(() => {
        /* user may need a second click after autoplay block */
      });
    } else {
      video.pause();
    }
  };
  playPauseBtn.addEventListener("click", togglePlay);

  // Click anywhere on the video itself toggles play/pause. The control bar
  // sits at z-index 3 above the video, so clicks on its buttons / scrubber
  // hit those elements first and never reach this listener.
  video.addEventListener("click", togglePlay);
  video.addEventListener("play", refreshPlayPause);
  video.addEventListener("pause", refreshPlayPause);
  video.addEventListener("ended", refreshPlayPause);
  video.addEventListener("playing", refreshPlayPause);
  refreshPlayPause();

  // Resume on bfcache restore. When the user navigates away (e.g. to /archive)
  // and then hits Back, the browser may restore the page from memory with the
  // video paused at the same playhead. We re-trigger play() on `pageshow` if
  // the page was persisted, so playback continues without a manual click.
  window.addEventListener("pageshow", (ev) => {
    if (!ev.persisted) return;
    if (video.paused && !video.ended) {
      video.play().catch(() => {
        /* autoplay still possible after gesture; user can click play */
      });
    }
    refreshPlayPause();
  });

  // Drop focus from control buttons after a mouse click so :focus-within
  // doesn't keep the toolbar visible after the cursor leaves the player.
  // Keyboard activation (e.detail === 0) keeps focus for accessibility.
  const controlsEl = document.querySelector(".imac__controls");
  if (controlsEl) {
    controlsEl.addEventListener("click", (ev) => {
      const t = ev.target;
      if (
        ev.detail > 0 &&
        t instanceof HTMLElement &&
        t.tagName === "BUTTON"
      ) {
        t.blur();
      }
    });
  }

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
  const cinemaHost = /** @type {HTMLElement | null} */ (
    document.getElementById("cinemaHost")
  );
  let diveBusy = false;

  /* ─── Cinema controls auto-hide ───────────────────────────────────────
   * In fullscreen, the control bar fades out after 2s of mouse inactivity
   * and reappears on the next mousemove / touch / keypress. Auto-hide is
   * paused while the user is dragging the scrubber. */
  const CINEMA_HIDE_DELAY_MS = 2000;
  /** @type {number | null} */
  let cinemaHideTimer = null;
  let cinemaScrubbing = false;

  function clearCinemaHideTimer() {
    if (cinemaHideTimer != null) {
      window.clearTimeout(cinemaHideTimer);
      cinemaHideTimer = null;
    }
  }

  function isInCinemaFullscreen() {
    return !!cinemaHost && cinemaHost.classList.contains("is-open");
  }

  function showCinemaControls(autoHide = true) {
    if (!cinemaHost) return;
    cinemaHost.classList.add("show-controls");
    clearCinemaHideTimer();
    if (autoHide && !cinemaScrubbing) {
      cinemaHideTimer = window.setTimeout(() => {
        if (!cinemaHost) return;
        cinemaHost.classList.remove("show-controls");
        cinemaHideTimer = null;
      }, CINEMA_HIDE_DELAY_MS);
    }
  }

  function hideCinemaControls() {
    if (!cinemaHost) return;
    cinemaHost.classList.remove("show-controls");
    clearCinemaHideTimer();
  }

  if (cinemaHost) {
    const onActivity = () => {
      if (!isInCinemaFullscreen()) return;
      showCinemaControls(true);
    };
    cinemaHost.addEventListener("mousemove", onActivity);
    cinemaHost.addEventListener("pointermove", onActivity);
    cinemaHost.addEventListener("pointerdown", onActivity);
    cinemaHost.addEventListener("touchstart", onActivity, { passive: true });
    cinemaHost.addEventListener("keydown", onActivity);
    cinemaHost.addEventListener("focusin", () => {
      if (!isInCinemaFullscreen()) return;
      showCinemaControls(false);
    });
    cinemaHost.addEventListener("focusout", () => {
      if (!isInCinemaFullscreen()) return;
      showCinemaControls(true);
    });
    cinemaHost.addEventListener("mouseleave", () => {
      if (!isInCinemaFullscreen()) return;
      if (cinemaScrubbing) return;
      hideCinemaControls();
    });
  }

  function restorePlayerToImac() {
    const wrap = document.getElementById("playerWrap");
    const frame = imacRoot?.querySelector(".imac__frame");
    if (!wrap || !imacRoot || !frame || !cinemaHost) return;
    if (wrap.parentElement !== cinemaHost) return;
    imacRoot.insertBefore(wrap, frame);
    cinemaHost.classList.remove("is-open", "is-entering", "show-controls");
    cinemaHost.setAttribute("hidden", "");
    clearCinemaHideTimer();
  }

  function clearImmersive() {
    document.documentElement.classList.remove(
      "immersive-dive",
      "immersive-dive--go"
    );
    if (imacRoot) {
      imacRoot.style.removeProperty("--dive-scale");
      imacRoot.style.removeProperty("--dive-origin-x");
      imacRoot.style.removeProperty("--dive-origin-y");
      imacRoot.style.removeProperty("--dive-tx");
      imacRoot.style.removeProperty("--dive-ty");
    }
  }

  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) {
      restorePlayerToImac();
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

    const frame = imacRoot?.querySelector(".imac__frame");

    // No cinema shell / frame — fall back to element fullscreen.
    if (!cinemaHost || !imacRoot || !frame) {
      try {
        await requestFs(wrap);
      } catch {
        const v = /** @type {HTMLVideoElement & { webkitEnterFullscreen?: () => void }} */ (
          video
        );
        if (typeof v.webkitEnterFullscreen === "function") v.webkitEnterFullscreen();
      }
      return;
    }

    diveBusy = true;

    cinemaHost.removeAttribute("hidden");
    cinemaHost.classList.add("is-open");
    if (!reduced) cinemaHost.classList.add("is-entering");
    cinemaHost.appendChild(wrap);

    try {
      await requestFs(cinemaHost);
    } catch {
      imacRoot.insertBefore(wrap, frame);
      cinemaHost.classList.remove("is-open", "is-entering");
      cinemaHost.setAttribute("hidden", "");
      diveBusy = false;
      const v = /** @type {HTMLVideoElement & { webkitEnterFullscreen?: () => void }} */ (
        video
      );
      if (typeof v.webkitEnterFullscreen === "function") {
        v.webkitEnterFullscreen();
      }
      return;
    }

    if (!reduced) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          cinemaHost.classList.remove("is-entering");
        });
      });
    }

    // Reveal controls on entry, then start the auto-hide countdown.
    showCinemaControls(true);

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
    try {
      video.currentTime = t;
    } catch {
      /* ignore seek errors during rapid scrub */
    }
    timeDisplay.textContent = `${fmtTime(t)} / ${fmtTime(video.duration)}`;
  });
  scrubber.addEventListener("change", () => {
    if (isFinite(video.duration) && video.duration > 0) {
      const t = (Number(scrubber.value) / 1000) * video.duration;
      try {
        video.currentTime = t;
      } catch {
        /* ignore */
      }
    }
    scrubbing = false;
  });
  scrubber.addEventListener("pointerdown", () => {
    scrubbing = true;
    cinemaScrubbing = true;
    if (isInCinemaFullscreen()) showCinemaControls(false);
  });
  const endScrub = () => {
    scrubbing = false;
    cinemaScrubbing = false;
    if (isInCinemaFullscreen()) showCinemaControls(true);
  };
  scrubber.addEventListener("pointerup", endScrub);
  scrubber.addEventListener("pointercancel", endScrub);
  window.addEventListener("pointerup", endScrub);

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
