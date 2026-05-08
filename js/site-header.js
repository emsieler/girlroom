/* Inner-page header: populates the shared marquee + logo on
 * about / archive / contact. The lander runs its own initialisation in
 * lander.js (with live artist substitution), so it does NOT load this. */

import { loadJson } from "./fetch-json.js";
import { setMarquee } from "./marquee.js";

async function main() {
  const config = await loadJson("data/config.json");

  const marqueeEl = document.getElementById("marqueeText");
  if (marqueeEl) {
    /* Inner pages have no video, so {artist} substitutes to empty —
     * the bold-italic span renders nothing visible while the rest of
     * the unicode track keeps scrolling. */
    setMarquee(marqueeEl, config.marqueeText || "", "");
  }

  const logoImg = /** @type {HTMLImageElement | null} */ (
    document.getElementById("logoImg")
  );
  const logoText = document.getElementById("logoText");
  if (logoImg && config.logoImage) {
    logoImg.src = config.logoImage;
    logoImg.hidden = false;
    if (logoText) logoText.hidden = !config.showLogoText;
  } else if (logoImg) {
    logoImg.hidden = true;
    if (logoText) logoText.hidden = false;
  }
}

main().catch((err) => {
  console.error(err);
});
