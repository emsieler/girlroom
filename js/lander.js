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
  const playerWrap = /** @type {HTMLElement} */ (qs("playerWrap"));
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
  video.setAttribute("webkit-playsinline", "");
  const initialStartAt = Number(resolved?.newest?.startAt) || 0;
  const initialArtist =
    resolved.mode === "live"
      ? streamCfg?.artist || ""
      : resolved?.newest?.artist || "";
  setMarquee(initialArtist);
  await switchSource(video, resolved.src, resolved.mode, initialStartAt);

  /* Robust autoplay: Safari sometimes rejects the first play() call until
   * the source is loadedmetadata-ready, and may revoke autoplay in low-power
   * mode. Retry on canplay/loadedmetadata and on first user gesture. */
  const tryPlay = () => {
    video.muted = true;
    return video.play().catch(() => {
      /* still blocked; will retry on next event */
    });
  };
  await tryPlay();
  let autoplayRetryHandlers = [];
  const armAutoplayRetry = () => {
    if (autoplayRetryHandlers.length) return;
    const onceRetry = async () => {
      await tryPlay();
      if (!video.paused) cleanupAutoplayRetry();
    };
    autoplayRetryHandlers = [
      ["loadedmetadata", onceRetry],
      ["canplay", onceRetry],
    ];
    for (const [name, fn] of autoplayRetryHandlers) {
      video.addEventListener(name, fn);
    }
    const gestureRetry = async () => {
      await tryPlay();
      cleanupAutoplayRetry();
    };
    document.addEventListener("pointerdown", gestureRetry, { once: true });
    document.addEventListener("touchstart", gestureRetry, {
      once: true,
      passive: true,
    });
    document.addEventListener("keydown", gestureRetry, { once: true });
    autoplayRetryHandlers.push(["pointerdown", gestureRetry, true]);
  };
  const cleanupAutoplayRetry = () => {
    for (const entry of autoplayRetryHandlers) {
      const [name, fn, isDoc] = entry;
      if (isDoc) document.removeEventListener(name, fn);
      else video.removeEventListener(name, fn);
    }
    autoplayRetryHandlers = [];
  };
  if (video.paused) armAutoplayRetry();

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

  /* iMac chrome (bottom bar + white "mute" corner): shown on pointer activity,
   * auto-hides after idle like cinema mode — :hover alone kept overlays stuck
   * on when the cursor rested on the video. Pink "unmute" is CSS-only, always on. */
  const IMAC_CHROME_HIDE_MS = 1000;
  /** @type {number | null} */
  let imacChromeTimer = null;
  let imacChromeScrubbing = false;

  function clearImacChromeTimer() {
    if (imacChromeTimer != null) {
      window.clearTimeout(imacChromeTimer);
      imacChromeTimer = null;
    }
  }

  function hidePlayerChrome() {
    playerWrap.classList.remove("show-chrome");
    clearImacChromeTimer();
  }

  function showPlayerChrome(autoHide = true) {
    playerWrap.classList.add("show-chrome");
    clearImacChromeTimer();
    if (!autoHide || imacChromeScrubbing) return;
    imacChromeTimer = window.setTimeout(() => {
      imacChromeTimer = null;
      if (imacChromeScrubbing) return;
      const ae = document.activeElement;
      if (
        ae instanceof Node &&
        (controlsEl?.contains(ae) || ae === muteBtn)
      ) {
        return;
      }
      playerWrap.classList.remove("show-chrome");
    }, IMAC_CHROME_HIDE_MS);
  }

  const onPlayerChromeActivity = () => showPlayerChrome(true);
  playerWrap.addEventListener("mouseenter", onPlayerChromeActivity);
  playerWrap.addEventListener("mousemove", onPlayerChromeActivity);
  playerWrap.addEventListener("pointerdown", onPlayerChromeActivity);
  playerWrap.addEventListener("touchstart", onPlayerChromeActivity, {
    passive: true,
  });
  playerWrap.addEventListener("wheel", onPlayerChromeActivity, { passive: true });
  playerWrap.addEventListener("keydown", onPlayerChromeActivity);
  playerWrap.addEventListener("mouseleave", () => hidePlayerChrome());
  playerWrap.addEventListener("focusin", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    if (
      controlsEl?.contains(t) ||
      t === muteBtn ||
      t.id === "scrubber"
    ) {
      showPlayerChrome(false);
    }
  });
  playerWrap.addEventListener("focusout", () => {
    requestAnimationFrame(() => {
      const ae = document.activeElement;
      const stillInChrome =
        ae instanceof HTMLElement &&
        (controlsEl?.contains(ae) ||
          ae === muteBtn ||
          ae.id === "scrubber");
      /* Do not call showPlayerChrome(true) here — e.g. after unmute we blur
       * the mute button; focus moves to <body> and reopening chrome made the
       * overlays stick. User can show chrome again with pointer activity. */
      if (!stillInChrome) hidePlayerChrome();
    });
  });

  const refreshMute = () => {
    const muted = video.muted;
    muteBtn.textContent = muted ? "unmute" : "mute";
    muteBtn.classList.toggle("is-muted", muted);
    muteBtn.setAttribute("aria-label", muted ? "unmute" : "mute");
  };
  muteBtn.addEventListener("click", (ev) => {
    const wasMuted = video.muted;
    video.muted = !video.muted;
    refreshMute();
    if (wasMuted && !video.muted) {
      muteBtn.blur();
      // Small offset so the click doesn't snap-hide before the user sees
      // the state flip; long enough to feel deliberate, short enough to
      // not linger.
      window.setTimeout(hidePlayerChrome, 100);
    } else if (ev.detail > 0) {
      muteBtn.blur();
    }
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
      "immersive-dive--go",
      "immersive-dive--zooming",
      "immersive-dive--exiting"
    );
    if (imacRoot) {
      imacRoot.style.removeProperty("--dive-scale");
      imacRoot.style.removeProperty("--dive-origin-x");
      imacRoot.style.removeProperty("--dive-origin-y");
      imacRoot.style.removeProperty("--dive-tx");
      imacRoot.style.removeProperty("--dive-ty");
      imacRoot.style.removeProperty("--chin-exit-delay");
    }
  }

  // Zoom-in duration (matches CSS on `html.immersive-dive .imac`).
  const DIVE_MS = 3500;
  // Zoom-out is a bit faster so exiting fullscreen doesn’t drag.
  const DIVE_EXIT_MS = 2700;
  /** @type {number | null} */
  let diveFinishTimer = null;
  /** @type {number | null} */
  let diveExitTimer = null;

  function clearDiveTimers() {
    if (diveFinishTimer != null) {
      window.clearTimeout(diveFinishTimer);
      diveFinishTimer = null;
    }
    if (diveExitTimer != null) {
      window.clearTimeout(diveExitTimer);
      diveExitTimer = null;
    }
  }

  function isImmersive() {
    return document.documentElement.classList.contains("immersive-dive");
  }

  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement) return;
    if (isImmersive()) {
      // Native FS just exited (Esc); reverse the dive.
      startDiveExit();
    } else {
      restorePlayerToImac();
      clearImmersive();
      diveBusy = false;
    }
  });

  // Esc also triggers an exit when we ran the dive without native FS (e.g.
  // Safari refused the requestFullscreen call).
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!isImmersive()) return;
    if (document.fullscreenElement) return;
    startDiveExit();
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

  function isMobileViewport() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 720px)").matches
    );
  }

  async function enterFullscreenSimple() {
    /* Mobile / unsupported browsers: skip the cinematic dive entirely.
     * Use native element fullscreen on the player, falling back to the
     * <video> element's own fullscreen API for iOS Safari. */
    const wrap = qs("playerWrap");
    try {
      await requestFs(wrap);
      return;
    } catch {
      /* fall through */
    }
    const v = /** @type {HTMLVideoElement & { webkitEnterFullscreen?: () => void }} */ (
      video
    );
    if (typeof v.webkitEnterFullscreen === "function") {
      v.webkitEnterFullscreen();
    }
  }

  async function enterFullscreenWithDive() {
    const wrap = qs("playerWrap");

    if (document.fullscreenElement) return;
    if (diveBusy || isImmersive()) return;

    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const frame = imacRoot?.querySelector(".imac__frame");

    // Mobile or missing pieces: skip the dive and use plain native fullscreen.
    if (isMobileViewport() || !cinemaHost || !imacRoot || !frame) {
      await enterFullscreenSimple();
      return;
    }

    diveBusy = true;
    clearDiveTimers();

    /* Try to enter native FS on the document so browser chrome hides while
     * the dive plays out. The user gesture is consumed here. If the browser
     * refuses, we keep going with a CSS-only fullscreen — Esc still works
     * via the keydown handler above.
     *
     * Critically, we measure AFTER FS, because requesting FS changes the
     * viewport size and the iMac re-flows. Measuring before would compute
     * a translate that's wrong by the FS offset, biasing the zoom landing
     * point off-center. */
    let fsAcquired = false;
    try {
      await requestFs(document.documentElement);
      fsAcquired = true;
    } catch {
      /* fall through, CSS-only dive */
    }

    /* Chrome can resolve the requestFullscreen promise before window inner
     * sizes have settled. Wait for whichever comes first: a resize event,
     * a fullscreenchange that confirms FS, or a short timeout. Then take
     * two more frames so layout + paint are fully committed. */
    if (fsAcquired) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          window.removeEventListener("resize", finish);
          document.removeEventListener("fullscreenchange", onFsChange);
          window.clearTimeout(t);
          resolve();
        };
        const onFsChange = () => {
          if (document.fullscreenElement) finish();
        };
        window.addEventListener("resize", finish, { once: true });
        document.addEventListener("fullscreenchange", onFsChange);
        const t = window.setTimeout(finish, 250);
      });
    }
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));

    /* Measure the iMac and screen cutout in (now FS) viewport coords.
     * Compute a transform that scales the iMac around the screen cutout's
     * center until the screen fills the viewport, and translates so the
     * cutout center lands at the viewport center. */
    const imacRect = imacRoot.getBoundingClientRect();
    const screenRect = wrap.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    /* "Contain" the screen cutout in the viewport — the first edge that
     * touches the viewport edge stops the zoom, so the video preserves its
     * aspect ratio with black bars on the other axis (matches the
     * cinema-host's object-fit: contain). */
    const scale = Math.min(vw / screenRect.width, vh / screenRect.height);
    const screenCx = screenRect.left + screenRect.width / 2;
    const screenCy = screenRect.top + screenRect.height / 2;
    const originX = screenCx - imacRect.left;
    const originY = screenCy - imacRect.top;
    const tx = vw / 2 - screenCx;
    const ty = vh / 2 - screenCy;

    imacRoot.style.setProperty("--dive-origin-x", `${originX}px`);
    imacRoot.style.setProperty("--dive-origin-y", `${originY}px`);
    imacRoot.style.setProperty("--dive-tx", `${tx}px`);
    imacRoot.style.setProperty("--dive-ty", `${ty}px`);
    imacRoot.style.setProperty("--dive-scale", String(scale));

    /* Compute when the chin bottom crosses the viewport's bottom edge so
     * .imac__chin-cover only starts fading at that moment (not before).
     *
     * During the transition, BOTH scale and translate interpolate together
     * via the bezier curve. Let p ∈ [0,1] be the bezier output (the
     * interpolation factor for `transform`). At progress p:
     *   scale_p   = 1 + p*(s-1)
     *   ty_p      = p*(vh/2 - screenCy)
     *   chin_y(p) = screenCy + chinDist*scale_p + ty_p
     * Solving chin_y(p) = vh yields:
     *   p_exit = (vh - imacRect.bottom) / [chinDist*(s-1) + (vh/2 - screenCy)]
     */
    const chinDist = imacRect.bottom - screenCy;
    const numerExit = vh - imacRect.bottom;
    const denomExit = chinDist * (scale - 1) + (vh / 2 - screenCy);
    const pChinExit = denomExit > 0
      ? Math.max(0, Math.min(1, numerExit / denomExit))
      : 0;

    /* Invert cubic-bezier(0.16, 0.62, 0.2, 1) at p_exit to get the linear
     * time fraction (since p is the bezier OUTPUT at exit, we need the
     * INPUT time fraction whose output equals p). */
    const cbPoint = (t, p1, p2) =>
      3 * p1 * t * (1 - t) ** 2 + 3 * p2 * t ** 2 * (1 - t) + t ** 3;
    const invertCb = (output, x1, y1, x2, y2) => {
      let lo = 0, hi = 1;
      for (let i = 0; i < 28; i++) {
        const mid = (lo + hi) / 2;
        if (cbPoint(mid, y1, y2) < output) lo = mid;
        else hi = mid;
      }
      return cbPoint((lo + hi) / 2, x1, x2);
    };
    const timeFrac = invertCb(pChinExit, 0.16, 0.62, 0.2, 1);
    /* Geometric chin-exit time + extra "let it linger" offset so the silver
     * chin stays visible past the moment it crosses the viewport edge.
     * Capped to leave room for the 0.6s fade to finish before the dive ends. */
    const CHIN_LINGER_SEC = .4;
    const fadeSec = 0.6;
    const maxDelaySec = (DIVE_MS / 1000) - fadeSec;
    const rawDelaySec = (timeFrac * DIVE_MS) / 1000 + CHIN_LINGER_SEC;
    const chinDelay = Math.min(maxDelaySec, rawDelaySec).toFixed(2);
    imacRoot.style.setProperty("--chin-exit-delay", `${chinDelay}s`);

    document.documentElement.classList.add(
      "immersive-dive",
      "immersive-dive--zooming"
    );

    if (reduced) {
      document.documentElement.classList.add("immersive-dive--go");
      finishDive();
    } else {
      // Two RAFs so the initial style commits before the transition runs.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document.documentElement.classList.add("immersive-dive--go");
        });
      });
      diveFinishTimer = window.setTimeout(finishDive, DIVE_MS);
    }
  }

  function finishDive() {
    /* The dive lands in its own steady state: backdrop fully black, iMac
     * zoomed to fill the viewport, frame faded out, video still parented
     * inside the iMac and playing. We deliberately do NOT hand the player
     * off to the cinema-host overlay — that swap caused a visible jump,
     * because the iMac screen cutout aspect (~1.837) doesn't match a 16:9
     * viewport, while the cinema-host video uses object-fit: contain. The
     * dove iMac already covers the screen, so we just hold here until exit. */
    diveFinishTimer = null;
    document.documentElement.classList.remove("immersive-dive--zooming");
    diveBusy = false;
  }

  function startDiveExit() {
    if (!isImmersive()) return;
    clearDiveTimers();

    /* Backdrop and iMac transform animate back to their resting state.
     * Nothing was reparented during the dive (see finishDive), so there's
     * no DOM cleanup to undo here. */
    document.documentElement.classList.add(
      "immersive-dive--zooming",
      "immersive-dive--exiting"
    );
    document.documentElement.classList.remove("immersive-dive--go");
    diveBusy = true;

    diveExitTimer = window.setTimeout(() => {
      diveExitTimer = null;
      clearImmersive();
      diveBusy = false;
    }, DIVE_EXIT_MS);
  }

  qs("btnFs").addEventListener("click", () => {
    if (isImmersive()) {
      if (document.fullscreenElement) {
        const d = document;
        if (d.exitFullscreen) void d.exitFullscreen();
        else if (d.webkitExitFullscreen) d.webkitExitFullscreen();
      } else {
        startDiveExit();
      }
      return;
    }
    if (document.fullscreenElement) {
      const d = document;
      if (d.exitFullscreen) void d.exitFullscreen();
      else if (d.webkitExitFullscreen) d.webkitExitFullscreen();
      return;
    }
    void enterFullscreenWithDive();
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
    imacChromeScrubbing = true;
    cinemaScrubbing = true;
    if (isInCinemaFullscreen()) showCinemaControls(false);
    showPlayerChrome(false);
  });
  const endScrub = () => {
    scrubbing = false;
    imacChromeScrubbing = false;
    cinemaScrubbing = false;
    if (isInCinemaFullscreen()) showCinemaControls(true);
    showPlayerChrome(true);
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
