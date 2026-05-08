/** @type {any} */
let hlsRef = null;

/**
 * @param {HTMLVideoElement} video
 */
function destroyHls(video) {
  if (hlsRef) {
    hlsRef.destroy();
    hlsRef = null;
  }
  video.removeAttribute("src");
  video.load();
}

/**
 * Attach HLS or native playback to a video element.
 * @param {HTMLVideoElement} video
 * @param {string} src
 * @param {{ live?: boolean }} opts
 */
export async function attachHls(video, src, opts = {}) {
  const { live = false } = opts;
  destroyHls(video);

  const canNative =
    video.canPlayType("application/vnd.apple.mpegurl") ||
    video.canPlayType("application/x-mpegURL");

  if (canNative) {
    video.src = src;
    return { destroy: () => destroyHls(video) };
  }

  const { default: Hls } = await import(
    "https://cdn.jsdelivr.net/npm/hls.js@1.5.20/+esm"
  );

  if (!Hls.isSupported()) {
    throw new Error("HLS is not supported in this browser");
  }

  const hls = new Hls({
    lowLatencyMode: !!live,
    enableWorker: true,
  });
  hls.loadSource(src);
  hls.attachMedia(video);
  hlsRef = hls;

  return {
    destroy: () => destroyHls(video),
  };
}

export function detachPlayer(video) {
  destroyHls(video);
}
