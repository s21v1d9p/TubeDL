/**
 * Node-based fast inner-loop sanity check for the extractor module.
 *
 * Bypasses the CORS relay entirely (configureRelay() is never called, so
 * relay.js's createRelayFetch() falls back to plain global fetch) -- Node has
 * no CORS restrictions, so this isolates whether the SABR extraction logic
 * itself works before worrying about relay integration.
 *
 * Run with: node test/sanity.mjs
 */
import './nodeDomPolyfill.mjs'; // Node-only: lets bgutils-js's BotGuard VM run (real browsers already have window/document).
import { writeFileSync, mkdirSync } from 'node:fs';
import { getVideoFormats, fetchFormat } from '../src/extractor/index.js';
import { decodeFormatKey } from '../src/extractor/formats.js';

const OUT_DIR = new URL('./output/', import.meta.url);
mkdirSync(OUT_DIR, { recursive: true });

function outPath(name) {
  return new URL(name, OUT_DIR).pathname;
}

function fmtBytes(n) {
  if (n === null || n === undefined) return 'unknown';
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function testVideo(label, videoId, { downloadLowest, downloadTierHeight }) {
  console.log(`\n=== [${label}] getVideoFormats(${videoId}) ===`);
  const t0 = Date.now();
  const info = await getVideoFormats(videoId);
  console.log(`  resolved in ${Date.now() - t0}ms`);
  console.log(`  title: ${info.title}`);
  console.log(`  author: ${info.author}`);
  console.log(`  duration: ${info.duration}s`);
  console.log(`  thumbnail: ${info.thumbnail}`);
  console.log(`  video tiers (${info.formats.video.length}):`);
  for (const v of info.formats.video) {
    console.log(`    - ${v.label.padEnd(8)} height=${String(v.height).padEnd(5)} fps=${String(v.fps).padEnd(4)} approxBytes=${fmtBytes(v.approxBytes)}`);
  }
  console.log(`  audio tiers (${info.formats.audio.length}):`);
  for (const a of info.formats.audio) {
    console.log(`    - ${a.label.padEnd(8)} approxBytes=${fmtBytes(a.approxBytes)}`);
  }

  if (!info.formats.video.length) {
    throw new Error(`[${label}] No video formats returned at all -- cannot continue.`);
  }

  const results = { info };

  if (downloadLowest) {
    const lowest = info.formats.video[info.formats.video.length - 1];
    console.log(`\n  -- fetchFormat() lowest tier: ${lowest.label} --`);
    const t1 = Date.now();
    let lastLogged = -1;
    const res = await fetchFormat(lowest.formatKey, (frac, phase) => {
      const pct = Math.round(frac * 100);
      if (pct !== lastLogged) { lastLogged = pct; process.stdout.write(`\r    [${phase}] ${pct}%   `); }
    });
    console.log(`\n  fetched in ${Date.now() - t1}ms`);
    console.log(`  videoBuffer: ${res.videoBuffer ? res.videoBuffer.byteLength + ' bytes' : 'null'}`);
    console.log(`  audioBuffer: ${res.audioBuffer ? res.audioBuffer.byteLength + ' bytes' : 'null'}`);
    console.log(`  suggestedExt: ${res.suggestedExt}`);

    if (res.videoBuffer) writeFileSync(outPath(`${label}_lowest_video.${res.suggestedExt}`), Buffer.from(res.videoBuffer));
    if (res.audioBuffer) writeFileSync(outPath(`${label}_lowest_audio.${res.suggestedExt === 'webm' ? 'webm' : 'm4a'}`), Buffer.from(res.audioBuffer));
    results.lowest = { tier: lowest, res };
  }

  if (downloadTierHeight) {
    const highest = info.formats.video.find((v) => v.height === downloadTierHeight) || info.formats.video[0];
    console.log(`\n  -- fetchFormat() tier: ${highest.label} --`);
    const t2 = Date.now();
    let lastLogged = -1;
    const res = await fetchFormat(highest.formatKey, (frac, phase) => {
      const pct = Math.round(frac * 100);
      if (pct !== lastLogged) { lastLogged = pct; process.stdout.write(`\r    [${phase}] ${pct}%   `); }
    });
    console.log(`\n  fetched in ${Date.now() - t2}ms`);
    console.log(`  videoBuffer: ${res.videoBuffer ? res.videoBuffer.byteLength + ' bytes' : 'null'}`);
    console.log(`  audioBuffer: ${res.audioBuffer ? res.audioBuffer.byteLength + ' bytes' : 'null'}`);
    console.log(`  suggestedExt: ${res.suggestedExt}`);

    const videoExt = res.suggestedExt;
    if (res.videoBuffer) writeFileSync(outPath(`${label}_highest_video.${videoExt}`), Buffer.from(res.videoBuffer));
    if (res.audioBuffer) writeFileSync(outPath(`${label}_highest_audio.${videoExt === 'webm' ? 'webm' : 'm4a'}`), Buffer.from(res.audioBuffer));
    results.highest = { tier: highest, res };
  }

  return results;
}

/**
 * Neither of the two mandated test videos (zoo, bbb4k) has a progressive
 * (single-buffer, pre-muxed) format any more -- reflects YouTube's ongoing
 * phase-out of progressive delivery, not a bug. This exercises that code
 * path explicitly against a video confirmed to still have one (itag 18,
 * 360p), so the full formatKey `kind` matrix ('progressive', 'adaptive-video',
 * 'audio') gets covered by this suite.
 */
async function testProgressive(label, videoId) {
  console.log(`\n=== [${label}] progressive-path check (${videoId}) ===`);
  const info = await getVideoFormats(videoId);
  const tier = info.formats.video.find((v) => decodeFormatKey(v.formatKey).kind === 'progressive');
  if (!tier) throw new Error(`[${label}] No progressive tier found -- video may have changed since this test was written.`);

  console.log(`  progressive tier: ${tier.label} (itag ${decodeFormatKey(tier.formatKey).itag})`);
  const res = await fetchFormat(tier.formatKey, (frac, phase) => process.stdout.write(`\r    [${phase}] ${Math.round(frac * 100)}%   `));
  console.log(`\n  videoBuffer: ${res.videoBuffer ? res.videoBuffer.byteLength + ' bytes' : 'null'}`);
  console.log(`  audioBuffer: ${res.audioBuffer} (must be null -- progressive is already muxed)`);
  if (!res.videoBuffer) throw new Error(`[${label}] progressive fetchFormat() returned no videoBuffer.`);
  if (res.audioBuffer !== null) throw new Error(`[${label}] progressive fetchFormat() unexpectedly returned a non-null audioBuffer.`);

  writeFileSync(outPath(`${label}_progressive.${res.suggestedExt}`), Buffer.from(res.videoBuffer));
  return { tier, res };
}

async function main() {
  const failures = [];

  try {
    await testVideo('zoo', 'jNQXAC9IVRw', { downloadLowest: true, downloadTierHeight: null });
  } catch (err) {
    console.error('\n[zoo] FAILED:', err.message, err.userMessage ? `(userMessage: ${err.userMessage})` : '');
    console.error(err.stack);
    failures.push([ 'zoo', err ]);
  }

  try {
    await testVideo('bbb4k', 'aqz-KE-bpKQ', { downloadLowest: true, downloadTierHeight: 1080 });
  } catch (err) {
    console.error('\n[bbb4k] FAILED:', err.message, err.userMessage ? `(userMessage: ${err.userMessage})` : '');
    console.error(err.stack);
    failures.push([ 'bbb4k', err ]);
  }

  try {
    await testProgressive('rickroll', 'dQw4w9WgXcQ');
  } catch (err) {
    console.error('\n[rickroll progressive] FAILED:', err.message, err.userMessage ? `(userMessage: ${err.userMessage})` : '');
    console.error(err.stack);
    failures.push([ 'rickroll progressive', err ]);
  }

  console.log('\n\n=== SUMMARY ===');
  if (failures.length) {
    console.log(`${failures.length} test(s) failed:`, failures.map(([ label ]) => label).join(', '));
    process.exitCode = 1;
  } else {
    console.log('All sanity checks completed without throwing.');
  }
}

main();
