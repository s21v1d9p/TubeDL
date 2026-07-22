/**
 * Client-side video+audio muxing via ffmpeg.wasm.
 *
 * We only ever need a stream-copy remux here (both buffers are already
 * encoded exactly as YouTube serves them) -- never a re-encode -- so the
 * single-threaded core is deliberately used instead of the multithreaded
 * `@ffmpeg/core-mt` build: `-mt` needs SharedArrayBuffer, which needs
 * COOP/COEP response headers that GitHub Pages cannot set (would require a
 * service-worker header-injection workaround). Stream-copy is not
 * CPU-bound, so the single-thread core's only real cost is that it can't
 * parallelize -- irrelevant for a remux.
 *
 * The ~31MB core is intentionally NOT bundled into this app; it's fetched
 * once at runtime from jsdelivr's CDN (the pattern documented by the
 * ffmpeg.wasm project itself) and cached by the browser across visits.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

// ESM build, not UMD: `FFmpeg.load()` always spins up its worker with
// `{ type: 'module' }` (see @ffmpeg/ffmpeg/dist/esm/classes.js), so
// `importScripts()` inside that worker throws immediately and it falls back
// to a dynamic `import(coreURL)`, which requires a real `export default`
// (present in the esm build, absent from umd -- confirmed empirically: umd
// produced "Error: failed to import ffmpeg-core.js" every time).
const CORE_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

/** @type {Promise<FFmpeg>|null} */
let ffmpegPromise = null;

/**
 * Loads (once) and returns the shared FFmpeg instance.
 *
 * Deliberately NOT using @ffmpeg/util's `toBlobURL(..., progress=true)` path:
 * its `downloadWithProgress` helper compares bytes-received against the
 * `Content-Length` response header and throws `ERROR_INCOMPLETED_DOWNLOAD` if
 * they don't match -- which they legitimately won't whenever the CDN serves
 * the (text) core JS gzip/brotli-compressed, since `Content-Length` reflects
 * the compressed size while `fetch()`'s reader yields the browser's already
 *-decompressed byte count. Confirmed empirically against jsdelivr's actual
 * CDN response. Losing the one-time ~31MB progress bar is a fair trade for
 * not having a real download intermittently reported as "failed".
 */
function getFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      const [ coreURL, wasmURL ] = await Promise.all([
        toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
        toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm')
      ]);
      // @ffmpeg/ffmpeg's default `classWorkerURL` is `new URL("./worker.js",
      // import.meta.url)` relative to the *unbundled* package's own file --
      // meaningless once esbuild inlines everything into one app.bundle.js.
      // We separately bundle the library's worker.js (see package.json's
      // `build`/`build:dev` scripts) to frontend/js/ffmpeg-worker.js and
      // point at it explicitly here, resolved the same way (relative to
      // *this* module's own URL, which after bundling is app.bundle.js's
      // real served location) so it works regardless of the site's base path.
      const classWorkerURL = new URL('./ffmpeg-worker.js', import.meta.url).toString();
      await ffmpeg.load({ coreURL, wasmURL, classWorkerURL });
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

/**
 * Pre-warms the FFmpeg core download. Safe to call speculatively (e.g. as
 * soon as the user picks an adaptive tier that will need muxing) -- calling
 * `getFFmpeg()` again later just reuses the same in-flight/loaded instance.
 */
export function preloadMuxer() {
  getFFmpeg().catch(() => {
    // Swallow here; the real error (if any) surfaces properly when muxVideoAudio() is actually awaited.
  });
}

/**
 * Remuxes a separately-fetched video-only + audio-only buffer pair into a
 * single playable file, without re-encoding either stream.
 * @param {object} args
 * @param {ArrayBuffer} args.videoBuffer
 * @param {ArrayBuffer} args.audioBuffer
 * @param {'mp4'|'webm'} args.container - output container; must be compatible with both input codecs
 * @param {(fraction: number) => void} [args.onProgress]
 * @returns {Promise<Blob>}
 */
export async function muxVideoAudio({ videoBuffer, audioBuffer, container, onProgress }) {
  const ffmpeg = await getFFmpeg();

  const inVideo = `input_video.${container === 'webm' ? 'webm' : 'mp4'}`;
  const inAudio = `input_audio.${container === 'webm' ? 'webm' : 'm4a'}`;
  const outFile = `output.${container}`;

  const progressHandler = ({ progress }) => {
    if (onProgress && typeof progress === 'number') onProgress(Math.min(Math.max(progress, 0), 1));
  };
  ffmpeg.on('progress', progressHandler);

  try {
    await ffmpeg.writeFile(inVideo, new Uint8Array(videoBuffer));
    await ffmpeg.writeFile(inAudio, new Uint8Array(audioBuffer));

    const args = [
      '-i', inVideo,
      '-i', inAudio,
      '-c', 'copy',
      ...(container === 'mp4' ? [ '-movflags', '+faststart' ] : []),
      outFile
    ];

    const code = await ffmpeg.exec(args);
    if (code !== 0) {
      throw new Error(`ffmpeg exited with code ${code}`);
    }

    const data = await ffmpeg.readFile(outFile);
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
    return new Blob([ bytes.buffer ], { type: container === 'webm' ? 'video/webm' : 'video/mp4' });
  } finally {
    ffmpeg.off('progress', progressHandler);
    await Promise.all([
      ffmpeg.deleteFile(inVideo).catch(() => {}),
      ffmpeg.deleteFile(inAudio).catch(() => {}),
      ffmpeg.deleteFile(outFile).catch(() => {})
    ]);
  }
}
