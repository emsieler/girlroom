/* Shared marquee builder used by the lander and inner pages.
 *
 * The template uses *...* to mark bold-italic emphasis (rendered as
 * <strong><em>). {artist} is substituted with the current artist name
 * (or empty on pages without a video). Chunks are built node-by-node
 * (no innerHTML) so unicode in the template can't be misread as markup. */

/** @param {string} text */
export function buildMarqueeChunk(text) {
  const chunk = document.createElement("span");
  chunk.className = "marquee__chunk";
  const re = /\*([^*]+)\*/g;
  let i = 0;
  /** @type {RegExpExecArray | null} */
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
}

/* Measure the first chunk and write its width as `--marquee-shift` so the
 * keyframe translates by an exact pixel amount instead of `-50%`. iOS
 * Safari occasionally caches percentage-based transforms against the
 * element's initial (zero) width and never re-evaluates them; pixel
 * shifts sidestep that entirely. We also restart the animation so the
 * new shift takes effect from the current frame. */
function applyShift(/** @type {HTMLElement} */ marqueeEl) {
  const chunk = marqueeEl.querySelector(".marquee__chunk");
  if (!(chunk instanceof HTMLElement)) return;
  const w = chunk.getBoundingClientRect().width;
  if (!(w > 0)) return;
  marqueeEl.style.setProperty("--marquee-shift", `-${w}px`);
  marqueeEl.style.animation = "none";
  void marqueeEl.offsetWidth;
  marqueeEl.style.animation = "";
}

/* Bind a single resize listener per element so re-renders don't pile
 * them up. Stored as a non-enumerable property to keep the DOM clean. */
function ensureResizeBinding(/** @type {HTMLElement} */ marqueeEl) {
  if (/** @type {any} */ (marqueeEl).__hasMarqueeResize) return;
  /** @type {any} */ (marqueeEl).__hasMarqueeResize = true;
  /** @type {number} */
  let raf = 0;
  window.addEventListener(
    "resize",
    () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => applyShift(marqueeEl));
    },
    { passive: true },
  );
}

/**
 * Render the marquee with two duplicate chunks and lock in a pixel-based
 * scroll distance.
 *
 * @param {HTMLElement} marqueeEl  The #marqueeText element to populate.
 * @param {string} template  Marquee template; {artist} is substituted.
 * @param {string} [artist]  Artist name to inject (defaults to empty string).
 */
export function setMarquee(marqueeEl, template, artist = "") {
  const text = String(template || "")
    .replace(/\{artist\}/g, String(artist || ""))
    .trim();
  marqueeEl.innerHTML = "";
  for (let i = 0; i < 2; i++) {
    const chunk = buildMarqueeChunk(text);
    if (i === 1) chunk.setAttribute("aria-hidden", "true");
    marqueeEl.appendChild(chunk);
  }

  /* Measure once now (synchronous), then again after layout has settled
   * (two RAFs covers the common case where mobile Safari hasn't laid the
   * inline-block out fully on first paint), then a final time after fonts
   * load — fonts can change the chunk width. Each call restarts the
   * animation so the most recent measurement wins. */
  applyShift(marqueeEl);
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => applyShift(marqueeEl));
  });
  if (document.fonts && typeof document.fonts.ready?.then === "function") {
    document.fonts.ready.then(() => applyShift(marqueeEl));
  }
  ensureResizeBinding(marqueeEl);
}
