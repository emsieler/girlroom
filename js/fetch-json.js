/**
 * Fetch JSON from a path relative to the site root.
 * @param {string} path
 */
export async function loadJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}
