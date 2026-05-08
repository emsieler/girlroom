/**
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export async function probeHlsManifest(url, timeoutMs) {
  if (!url) return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      method: "GET",
      cache: "no-store",
    });
    const text = await res.text();
    return res.ok && text.includes("#EXTM3U");
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {{ liveHls?: string, probeTimeoutMs?: number }} streamCfg
 * @param {Array<{ hls: string }>} archiveList
 */
export async function resolvePlayback(streamCfg, archiveList) {
  const liveUrl = (streamCfg?.liveHls || "").trim();
  const timeout = streamCfg?.probeTimeoutMs ?? 4000;

  if (liveUrl) {
    const ok = await probeHlsManifest(liveUrl, timeout);
    if (ok) {
      return { mode: "live", src: liveUrl, list: archiveList };
    }
  }

  const vods = Array.isArray(archiveList) ? archiveList : [];
  const newest = vods.find((v) => v?.hls);
  if (!newest) {
    throw new Error("No VOD with an `hls` URL in data/archive.json");
  }
  return { mode: "vod", src: newest.hls, newest, list: vods };
}
