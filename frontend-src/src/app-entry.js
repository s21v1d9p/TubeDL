/**
 * TubeDL production app entry point (bundled into frontend/js/app.bundle.js).
 *
 * Wires together: URL parsing/deep-links, the extractor module
 * (getVideoFormats/fetchFormat), and the ffmpeg.wasm muxer, against the
 * static DOM already defined in frontend/index.html.
 */
import { configureRelay, getVideoFormats, fetchFormat } from './extractor/index.js';
import { preloadMuxer, muxVideoAudio } from './mux.js';

// ---------------------------------------------------------------------------
// Configuration -- update RELAY_BASE_URL after deploying the Cloudflare
// Worker relay (see worker/README.md). Everything else needs no editing.
// ---------------------------------------------------------------------------
const RELAY_BASE_URL = 'https://tubedl-relay.s21v1d9p.workers.dev';
configureRelay(RELAY_BASE_URL);

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const form = document.getElementById('url-form');
const input = document.getElementById('url-input');
const fetchBtn = document.getElementById('fetch-btn');
const errorBox = document.getElementById('error-box');
const loading = document.getElementById('loading');
const loadingLabel = document.getElementById('loading-label');
const result = document.getElementById('result');
const thumb = document.getElementById('thumb');
const titleEl = document.getElementById('title');
const metaLine = document.getElementById('meta-line');
const videoFormatsEl = document.getElementById('video-formats');
const audioFormatsEl = document.getElementById('audio-formats');
const progress = document.getElementById('progress');
const progressFill = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');

let currentFormatButtons = [];

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
}

function setLoading(isLoading, label) {
  loading.hidden = !isLoading;
  if (label) loadingLabel.textContent = label;
  fetchBtn.disabled = isLoading;
}

function setButtonsDisabled(disabled) {
  currentFormatButtons.forEach((btn) => { btn.disabled = disabled; });
}

function showProgress(label) {
  progress.hidden = false;
  progressFill.style.width = '0%';
  progressLabel.textContent = label;
}

function updateProgress(fraction, label) {
  progressFill.style.width = `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%`;
  if (label) progressLabel.textContent = label;
}

function hideProgress() {
  progress.hidden = true;
}

function fmtBytes(n) {
  if (!n) return '';
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `~${(mb / 1024).toFixed(2)} GB` : `~${mb.toFixed(1)} MB`;
}

function fmtDuration(seconds) {
  if (!seconds && seconds !== 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Triggers a native browser "Save As" download for a Blob, then releases the object URL. */
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function sanitizeFilename(name) {
  return (name || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 150) || 'video';
}

/** Renders one format tier as a clickable button. */
function renderFormatButton(container, { label, approxBytes, formatKey, isVideo }, meta) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'format-btn';
  btn.innerHTML = `<span class="label">${label}</span><span class="size">${fmtBytes(approxBytes)}</span>`;
  btn.addEventListener('click', () => handleDownloadClick(btn, formatKey, isVideo, meta));
  container.appendChild(btn);
  currentFormatButtons.push(btn);
}

async function handleDownloadClick(btn, formatKey, isVideo, meta) {
  clearError();
  setButtonsDisabled(true);
  // Speculatively start the ~31MB ffmpeg.wasm core download in parallel with
  // the SABR fetch below -- most video tiers need muxing, and there's no
  // reason to wait for the download to finish before starting it.
  if (isVideo) preloadMuxer();

  try {
    showProgress('Starting download…');
    const { videoBuffer, audioBuffer, suggestedExt } = await fetchFormat(formatKey, (fraction, phase) => {
      updateProgress(fraction, phase === 'audio' ? 'Downloading audio…' : 'Downloading video…');
    });

    const baseName = sanitizeFilename(meta.title);
    let blob, filename;

    if (videoBuffer && audioBuffer) {
      updateProgress(0, 'Merging video + audio…');
      blob = await muxVideoAudio({
        videoBuffer,
        audioBuffer,
        container: 'mp4',
        onProgress: (fraction) => updateProgress(fraction, 'Merging video + audio…')
      });
      filename = `${baseName}.mp4`;
    } else if (videoBuffer) {
      blob = new Blob([ videoBuffer ], { type: suggestedExt === 'webm' ? 'video/webm' : 'video/mp4' });
      filename = `${baseName}.${suggestedExt}`;
    } else {
      blob = new Blob([ audioBuffer ], { type: suggestedExt === 'webm' ? 'audio/webm' : 'audio/mp4' });
      filename = `${baseName}.${suggestedExt === 'webm' ? 'webm' : 'm4a'}`;
    }

    updateProgress(1, 'Done!');
    triggerDownload(blob, filename);
    setTimeout(hideProgress, 1200);
  } catch (err) {
    console.error('[TubeDL] Download failed:', err);
    hideProgress();
    showError(err?.userMessage || 'Download failed. Please try again.');
  } finally {
    setButtonsDisabled(false);
  }
}

function renderResult(info) {
  currentFormatButtons = [];
  videoFormatsEl.innerHTML = '';
  audioFormatsEl.innerHTML = '';

  thumb.src = info.thumbnail || '';
  titleEl.textContent = info.title || 'Untitled';
  metaLine.textContent = [ info.author, fmtDuration(info.duration) ].filter(Boolean).join(' \u00b7 ');

  for (const v of info.formats.video) {
    renderFormatButton(videoFormatsEl, { ...v, formatKey: v.formatKey, isVideo: true }, info);
  }
  for (const a of info.formats.audio) {
    renderFormatButton(audioFormatsEl, { ...a, formatKey: a.formatKey, isVideo: false }, info);
  }

  if (!info.formats.video.length) {
    videoFormatsEl.innerHTML = '<p class="meta-line">No downloadable video formats found for this video.</p>';
  }
  if (!info.formats.audio.length) {
    audioFormatsEl.innerHTML = '<p class="meta-line">No downloadable audio-only format found for this video.</p>';
  }

  result.hidden = false;
}

async function handleSubmit(rawInput) {
  clearError();
  result.hidden = true;
  hideProgress();

  const trimmed = (rawInput || '').trim();
  if (!trimmed) {
    showError('Paste a YouTube link first.');
    return;
  }

  setLoading(true, 'Loading video info…');
  try {
    const info = await getVideoFormats(trimmed);
    renderResult(info);
  } catch (err) {
    console.error('[TubeDL] getVideoFormats failed:', err);
    showError(err?.userMessage || 'Could not load this video. Please check the link and try again.');
  } finally {
    setLoading(false);
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  handleSubmit(input.value);
});

// ---------------------------------------------------------------------------
// Deep-link support: yoursite.github.io/TubeDL/<pasted YouTube URL>,
// .../TubeDL/?url=<...>, or .../TubeDL/#<...> all auto-fill + auto-submit.
// See 404.html for how the path form gets here.
// ---------------------------------------------------------------------------
function extractDeepLink() {
  const stashed = sessionStorage.getItem('tubedl_deeplink');
  if (stashed) {
    sessionStorage.removeItem('tubedl_deeplink');
    if (stashed.trim()) return stashed;
  }
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('url');
  if (fromQuery) return fromQuery;
  const hash = window.location.hash.replace(/^#/, '');
  if (hash) return decodeURIComponent(hash);
  return null;
}

const deepLink = extractDeepLink();
if (deepLink) {
  input.value = deepLink;
  handleSubmit(deepLink);
}
