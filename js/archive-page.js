import { loadJson } from "./fetch-json.js";

function qs(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

async function main() {
  const list = await loadJson("data/archive.json");
  const grid = qs("archiveGrid");
  grid.innerHTML = "";

  if (!Array.isArray(list) || !list.length) {
    grid.textContent = "No entries in data/archive.json yet.";
    return;
  }

  for (const item of list) {
    if (!item.hls) continue;
    const card = document.createElement("article");
    card.className = "archive-card";

    const btn = document.createElement("button");
    btn.type = "button";

    if (item.poster) {
      const img = document.createElement("img");
      img.src = item.poster;
      img.alt = item.title || "";
      btn.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.style.cssText =
        "aspect-ratio:16/9;background:#eee;display:flex;align-items:center;justify-content:center;font-size:0.75rem;";
      ph.textContent = "no poster";
      btn.appendChild(ph);
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    const t = document.createElement("div");
    t.className = "title";
    t.textContent = item.title || item.id || "untitled";
    meta.appendChild(t);
    if (item.date) {
      const d = document.createElement("div");
      d.textContent = item.date;
      meta.appendChild(d);
    }
    btn.appendChild(meta);

    btn.addEventListener("click", () => {
      const u = new URL("index.html", window.location.href);
      u.searchParams.set("vod", item.hls);
      window.location.href = u.toString();
    });

    card.appendChild(btn);
    grid.appendChild(card);
  }
}

main().catch((err) => {
  console.error(err);
  qs("archiveGrid").textContent = String(err.message || err);
});
