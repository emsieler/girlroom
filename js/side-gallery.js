/**
 * Cross-fading cycle gallery for left/right columns.
 * Supports per-item `ms` override; falls back to `defaultMs`.
 *
 * Item shape: `{ src: string, ms?: number, type?: "image" | "video" }`
 * If `type` omitted, inferred from file extension.
 *
 * @param {HTMLElement} root
 * @param {Array<{ src?: string, ms?: number, type?: string }>} items
 * @param {number} defaultMs
 */
export function initSideGallery(root, items, defaultMs) {
  const stack = document.createElement("div");
  stack.className = "side__stack";
  root.innerHTML = "";
  root.appendChild(stack);

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "side__empty";
    empty.textContent =
      "Drop images, GIFs, or silent .mp4/.webm into assets/side-left/ or assets/side-right/, then list them in data/sides.json.";
    stack.appendChild(empty);
    return () => {};
  }

  const layerA = document.createElement("div");
  const layerB = document.createElement("div");
  layerA.className = "side__layer";
  layerB.className = "side__layer";
  stack.appendChild(layerA);
  stack.appendChild(layerB);

  let active = 0;
  let idx = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  const layers = [layerA, layerB];

  function inferType(src) {
    const s = (src || "").toLowerCase();
    if (/\.(mp4|webm|mov|m4v)(\?|$)/.test(s)) return "video";
    return "image";
  }

  function clearLayer(el) {
    el.innerHTML = "";
    el.querySelectorAll("video").forEach((v) => {
      v.pause();
      v.removeAttribute("src");
      v.load();
    });
  }

  function fillLayer(el, item) {
    clearLayer(el);
    const src = item.src;
    if (!src) return;
    const type = item.type || inferType(src);
    if (type === "video") {
      const v = document.createElement("video");
      v.src = src;
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.autoplay = true;
      v.setAttribute("playsinline", "");
      el.appendChild(v);
      v.play().catch(() => {});
    } else {
      const img = document.createElement("img");
      img.src = src;
      img.alt = "";
      img.loading = "lazy";
      el.appendChild(img);
    }
  }

  function tick() {
    const item = items[idx];
    const inactive = 1 - active;
    fillLayer(layers[inactive], item);
    layers[active].classList.remove("is-active");
    layers[inactive].classList.add("is-active");
    active = inactive;
    const ms = typeof item.ms === "number" ? item.ms : defaultMs;
    idx = (idx + 1) % items.length;
    timer = setTimeout(tick, Math.max(800, ms));
  }

  layerA.classList.add("is-active");
  fillLayer(layerA, items[0]);
  idx = 1 % items.length;
  const firstMs =
    typeof items[0].ms === "number" ? items[0].ms : defaultMs;
  timer = setTimeout(tick, Math.max(800, firstMs));

  return () => {
    if (timer) clearTimeout(timer);
    clearLayer(layerA);
    clearLayer(layerB);
  };
}
