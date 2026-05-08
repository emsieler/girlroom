import { loadJson } from "./fetch-json.js";

function setLineEl(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  if (typeof text !== "string" || text.trim().length === 0) {
    el.hidden = true;
    return;
  }
  el.innerHTML = "";
  text.split("\n").forEach((line, i) => {
    if (i > 0) el.appendChild(document.createElement("br"));
    el.appendChild(document.createTextNode(line));
  });
  el.hidden = false;
}

async function main() {
  const config = await loadJson("data/config.json");
  setLineEl("presentsText", config.presentsText);
  setLineEl("tagline", config.tagline);
}

main().catch((err) => {
  console.error(err);
});
