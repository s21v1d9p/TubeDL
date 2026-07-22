/**
 * Pure data-shaping helpers: turning youtubei.js `Format` lists into the
 * public tier list this module exposes, and encoding/decoding the opaque
 * `formatKey` handed back to callers.
 *
 * No network calls happen in this file.
 */

const FORMAT_KEY_VERSION = 1;

/**
 * @typedef {Object} FormatKeyPayload
 * @property {number} v
 * @property {string} videoId
 * @property {'progressive'|'adaptive-video'|'audio'} kind
 * @property {number} itag
 * @property {string} [xtags]
 */

// Browser-safe base64url helpers (no Buffer/node:* dependency, so this works
// unmodified once bundled for the browser).
function utf8ToBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToUtf8(b64url) {
  const base64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(b64url.length + (4 - b64url.length % 4) % 4, '=');
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Encodes a format key payload into an opaque, URL-safe string. */
export function encodeFormatKey(payload) {
  const json = JSON.stringify({ v: FORMAT_KEY_VERSION, ...payload });
  return utf8ToBase64Url(json);
}

/** Decodes an opaque formatKey string back into its payload. Throws if malformed. */
export function decodeFormatKey(formatKey) {
  try {
    const json = base64UrlToUtf8(formatKey);
    const payload = JSON.parse(json);
    if (payload.v !== FORMAT_KEY_VERSION || !payload.videoId || !payload.kind || !payload.itag) {
      throw new Error('missing required fields');
    }
    return payload;
  } catch (err) {
    throw new Error(`Invalid or corrupt formatKey: ${err.message}`);
  }
}

const CODEC_RANK = [
  [ /avc1|h264/i, 3 ],
  [ /vp9|vp09/i, 2 ],
  [ /av01/i, 1 ]
];

function codecRank(mimeType) {
  for (const [ re, rank ] of CODEC_RANK) {
    if (re.test(mimeType || '')) return rank;
  }
  return 0;
}

function isMp4(mimeType) {
  return /mp4/i.test(mimeType || '');
}

/** Estimates byte size when content_length isn't reported by YouTube. */
function approxBytesOf(format) {
  if (format.content_length) return format.content_length;
  if (format.bitrate && format.approx_duration_ms) {
    return Math.round((format.bitrate / 8) * (format.approx_duration_ms / 1000));
  }
  return undefined;
}

/** Video container/codec extension, used both for internal ranking and suggestedExt. */
export function videoExtOf(mimeType) {
  return isMp4(mimeType) ? 'mp4' : 'webm';
}

/** Audio container/codec extension. */
export function audioExtOf(mimeType) {
  return isMp4(mimeType) ? 'm4a' : 'webm';
}

/**
 * Picks the single "best audio" format from an adaptive_formats list: prefers
 * mp4/aac (itag 140) for maximum compatibility with mp4 muxing, falling back
 * to the highest-bitrate audio track available.
 * @param {import('youtubei.js').Types.Format[]} adaptiveFormats
 */
export function pickBestAudio(adaptiveFormats) {
  const audioFormats = adaptiveFormats.filter((f) => f.has_audio && !f.has_video);
  if (!audioFormats.length) return undefined;

  const mp4Audio = audioFormats.filter((f) => isMp4(f.mime_type));
  const pool = mp4Audio.length ? mp4Audio : audioFormats;

  return pool.slice().sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
}

/**
 * Builds internal per-height "video candidate" entries from the session's
 * streaming_data.
 * @param {import('youtubei.js').Types.IStreamingData} streamingData
 */
export function collectVideoCandidates(streamingData) {
  const candidates = [];

  for (const f of streamingData.formats || []) {
    if (!f.has_video) continue;
    candidates.push({
      kind: 'progressive',
      itag: f.itag,
      xtags: f.xtags,
      height: f.height,
      fps: f.fps,
      qualityLabel: f.quality_label,
      mimeType: f.mime_type,
      approxBytes: approxBytesOf(f)
    });
  }

  for (const f of streamingData.adaptive_formats || []) {
    if (!f.has_video || f.has_audio) continue;
    candidates.push({
      kind: 'adaptive-video',
      itag: f.itag,
      xtags: f.xtags,
      height: f.height,
      fps: f.fps,
      qualityLabel: f.quality_label,
      mimeType: f.mime_type,
      approxBytes: approxBytesOf(f)
    });
  }

  return candidates;
}

/**
 * Merges video candidates into one tier per resolution height, sorted
 * descending. Within a height, prefers: progressive over adaptive (simpler/
 * no merge step needed), then higher fps, then a more broadly-compatible
 * codec, then higher bitrate/size.
 * @param {ReturnType<typeof collectVideoCandidates>} candidates
 */
export function mergeVideoTiersByHeight(candidates) {
  const byHeight = new Map();

  for (const c of candidates) {
    if (!c.height) continue;
    const existing = byHeight.get(c.height);
    if (!existing || better(c, existing)) {
      byHeight.set(c.height, c);
    }
  }

  return Array.from(byHeight.values()).sort((a, b) => b.height - a.height);

  function better(a, b) {
    const aProgressive = a.kind === 'progressive' ? 1 : 0;
    const bProgressive = b.kind === 'progressive' ? 1 : 0;
    if (aProgressive !== bProgressive) return aProgressive > bProgressive;

    const aFps = a.fps || 0;
    const bFps = b.fps || 0;
    if (aFps !== bFps) return aFps > bFps;

    const aCodec = codecRank(a.mimeType);
    const bCodec = codecRank(b.mimeType);
    if (aCodec !== bCodec) return aCodec > bCodec;

    return (a.approxBytes || 0) > (b.approxBytes || 0);
  }
}
