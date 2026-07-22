// Real-browser (Playwright/Chromium) validation entry point -- bundled with
// esbuild for this test only. Exercises the actual shipped module exactly as
// a real integrator would: configureRelay() then getVideoFormats()/fetchFormat().
// This is the definitive test of whether BotGuard/PoToken attestation
// actually satisfies YouTube's server in a genuine browser JS engine (as
// opposed to Node+jsdom, which may be detected as non-genuine and thus isn't
// conclusive on its own).
import { configureRelay, getVideoFormats, fetchFormat } from '../../src/extractor/index.js';

// Points at the REAL Cloudflare Worker relay's local `wrangler dev` instance
// (already running separately in this environment, port 8787) -- a much
// stronger end-to-end proof than a fake test-only stand-in relay, and
// validates the actual production relay contract, not just an assumption
// about it.
configureRelay('http://localhost:8787');

window.runTest = async function runTest(videoIdOrUrl, tierHeight) {
  const result = { videoIdOrUrl, tierHeight, stage: 'start' };
  try {
    result.stage = 'getVideoFormats';
    const meta = await getVideoFormats(videoIdOrUrl);
    result.meta = {
      videoId: meta.videoId,
      title: meta.title,
      duration: meta.duration,
      videoTiers: meta.formats.video.map((v) => ({ height: v.height, fps: v.fps, label: v.label, approxBytes: v.approxBytes })),
      audioTiers: meta.formats.audio.map((a) => ({ label: a.label, approxBytes: a.approxBytes }))
    };

    const tier = tierHeight
      ? meta.formats.video.find((v) => v.height === tierHeight)
      : meta.formats.video[meta.formats.video.length - 1];
    if (!tier) throw new Error(`No tier found for height=${tierHeight}`);
    result.chosenTier = { height: tier.height, label: tier.label };

    result.stage = 'fetchFormat';
    const progress = [];
    const t0 = performance.now();
    const { videoBuffer, audioBuffer, suggestedExt } = await fetchFormat(tier.formatKey, (frac, phase) => {
      progress.push({ frac: Math.round(frac * 100) / 100, phase });
    });
    result.elapsedMs = Math.round(performance.now() - t0);
    result.videoBytes = videoBuffer ? videoBuffer.byteLength : null;
    result.audioBytes = audioBuffer ? audioBuffer.byteLength : null;
    result.suggestedExt = suggestedExt;
    result.progressSamples = progress.length;
    result.stage = 'done';
    result.ok = true;

    // Stash raw bytes as base64 on window for retrieval by the driver.
    window.__lastVideoBuffer = videoBuffer;
    window.__lastAudioBuffer = audioBuffer;
  } catch (err) {
    result.ok = false;
    result.error = err?.message || String(err);
    result.userMessage = err?.userMessage || null;
    result.stack = err?.stack || null;
  }
  window.__testResult = result;
  console.log('TEST_RESULT_JSON:' + JSON.stringify(result));
  return result;
};
