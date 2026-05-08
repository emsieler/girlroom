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

/**
 * Render the marquee with two duplicate chunks. The CSS animation translates
 * the parent by -50% which equals one chunk's width, producing a seamless loop.
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
  /* Restart the CSS animation so Safari recomputes translateX(-50%) against
   * the current content width. Otherwise Safari "sticks" at whatever width
   * the element had when the animation was first applied — usually 0 (since
   * #marqueeText starts empty before this script runs), which makes the
   * marquee look frozen. The void-offsetWidth pair forces reflow between
   * the unset and reset so the engine treats it as a fresh animation. */
  marqueeEl.style.animation = "none";
  void marqueeEl.offsetWidth;
  marqueeEl.style.animation = "";
}
