import { loadJson } from "./fetch-json.js";

const PUBLIC_ARCHIVE_ID = "2026-05-08-2026-05-06-stream";
const DEV_MODE_KEY = "gr.devMode";

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

function isArchiveDevMode() {
  if (!isLocalHost()) return false;
  try {
    return localStorage.getItem(DEV_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

function qs(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

async function main() {
  const raw = await loadJson("data/archive.json");
  const grid = qs("archiveGrid");
  grid.innerHTML = "";

  const list = Array.isArray(raw) ? raw : [];
  const visible = isArchiveDevMode()
    ? list
    : list.filter((e) => e && e.id === PUBLIC_ARCHIVE_ID);

  if (!visible.length) {
    grid.textContent = isArchiveDevMode()
      ? "No entries in data/archive.json yet."
      : "No public archive entries yet.";
    return;
  }

  for (const item of visible) {
    if (!item.hls) continue;
    const card = document.createElement("article");
    card.className = "archive-card";

    const btn = document.createElement("button");
    btn.type = "button";

    // Mini iMac thumbnail: same PNG frame as the home page, with the poster
    // image (or a white screen) sitting inside the screen cutout.
    const imac = document.createElement("div");
    imac.className = "archive-card__imac";

    const screen = document.createElement("div");
    screen.className = "archive-card__screen";
    if (item.poster) {
      const img = document.createElement("img");
      img.src = item.poster;
      img.alt = item.title || "";
      img.loading = "lazy";
      screen.appendChild(img);
    }
    imac.appendChild(screen);

    const frame = document.createElement("img");
    frame.className = "archive-card__frame";
    frame.src = "assets/imac-frame.png";
    frame.alt = "";
    frame.loading = "lazy";
    imac.appendChild(frame);

    btn.appendChild(imac);

    const meta = document.createElement("div");
    meta.className = "meta";
    if (item.artist) {
      const a = document.createElement("div");
      a.className = "name";
      a.textContent = item.artist;
      meta.appendChild(a);
    }
    if (item.date) {
      const d = document.createElement("div");
      d.className = "date";
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
