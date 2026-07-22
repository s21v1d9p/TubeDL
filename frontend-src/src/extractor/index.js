/**
 * TubeDL in-browser YouTube extraction module.
 *
 * Public contract consumed by the rest of the app: `configureRelay`,
 * `getVideoFormats`, `fetchFormat`. See each function's docstring below for
 * the exact shape.
 *
 * Internals:
 *  - relay.js         CORS-relay-aware fetch() wrapper (or plain fetch in Node).
 *  - innertube.js      youtubei.js session management (single WEB client + PoToken).
 *  - potoken.js        BotGuard PoToken generation (bgutils-js).
 *  - formats.js        Pure data shaping: tier list building, formatKey codec.
 *  - sabrDownload.js   googlevideo SabrStream orchestration + progressive GET.
 */
import {
  encodeFormatKey,
  decodeFormatKey,
  collectVideoCandidates,
  mergeVideoTiersByHeight,
  pickBestAudio,
  videoExtOf,
  audioExtOf
} from './formats.js';
import { YT } from 'youtubei.js';
import { getInnertubeSession, getVideoPoToken, refreshVideoPoToken, getClientNameId } from './innertube.js';
import { createRelayFetch } from './relay.js';
import { downloadAdaptivePair, downloadAudioOnly, downloadProgressive } from './sabrDownload.js';
import { makeError, wrapError } from './errors.js';

export { configureRelay } from './relay.js';

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/** Extracts an 11-char video ID from a bare ID or a youtube.com/youtu.be URL. */
function extractVideoId(input) {
  const trimmed = (input || '').trim();
  if (VIDEO_ID_RE.test(trimmed)) return trimmed;

  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withProtocol);
    const host = url.hostname.toLowerCase();

    let videoId = null;
    if (host.endsWith('youtu.be')) {
      videoId = url.pathname.split('/').filter(Boolean)[0] || null;
    } else if (url.pathname === '/watch') {
      videoId = url.searchParams.get('v');
    } else {
      const m = url.pathname.match(/^\/(shorts|live|embed)\/([^/?]+)/);
      if (m) videoId = m[2];
    }

    if (videoId && VIDEO_ID_RE.test(videoId)) return videoId;
  } catch {
    // fall through to the error below
  }

  throw makeError(`Could not extract a video ID from input: ${trimmed}`, 'That does not look like a valid YouTube video link.');
}

/** Translates youtubei.js's playability_status into a user-facing error, or returns null if playable. */
function playabilityError(info) {
  const status = info.playability_status;
  if (!status) return null;

  if (info.basic_info?.is_live || info.basic_info?.is_post_live_dvr) {
    return makeError('Live or post-live videos are not supported.', 'Live videos cannot be downloaded. Please try again after the stream has fully ended and been processed as a regular video.');
  }

  if (status.status === 'OK') return null;

  if (status.status === 'LOGIN_REQUIRED') {
    return makeError(`playability_status: LOGIN_REQUIRED - ${status.reason}`, 'This video is private, age-restricted, or otherwise requires sign-in, so it can\u2019t be downloaded.');
  }
  if (status.status === 'UNPLAYABLE') {
    return makeError(`playability_status: UNPLAYABLE - ${status.reason}`, status.reason || 'This video is unavailable.');
  }
  if (status.status === 'ERROR') {
    return makeError(`playability_status: ERROR - ${status.reason}`, status.reason || 'This video is private or unavailable.');
  }
  return makeError(`playability_status: ${status.status} - ${status.reason}`, status.reason || 'This video cannot be played or downloaded right now.');
}

/**
 * `LOGIN_REQUIRED - Sign in to confirm you're not a bot` is a distinct,
 * pattern-matchable case from LOGIN_REQUIRED's other meanings (a genuinely
 * private/age-restricted video) -- confirmed to be an *intermittent*
 * YouTube-side bot-detection check against the relay's IP (retrying with a
 * completely fresh PoToken/BotGuard session reliably clears it; the same
 * video succeeds outright on a plain retry most of the time). Worth one
 * automatic retry before surfacing an error to the user.
 */
function isTransientBotCheck(err) {
  return /sign in to confirm you.{0,5}re not a bot/i.test(err?.message || '');
}

/**
 * Resolves a canonical YouTube video URL (or bare video ID) into metadata and
 * a list of downloadable format tiers.
 * @param {string} canonicalUrlOrVideoId
 */
export async function getVideoFormats(canonicalUrlOrVideoId) {
  const videoId = extractVideoId(canonicalUrlOrVideoId);
  const yt = await getInnertubeSession().catch((err) => {
    throw wrapError(err, 'Could not start a YouTube session. Please try again.');
  });

  async function fetchInfo(poToken) {
    const info = await yt.getBasicInfo(videoId, poToken ? { po_token: poToken } : undefined);
    const err = playabilityError(info);
    if (err) throw err;
    return info;
  }

  let info;
  try {
    // Historically fire-and-forget here (hiding BotGuard's ~1-2s VM-startup
    // latency), since a token wasn't needed just to list formats when
    // requests came from a normal residential IP. Once the CORS relay is a
    // Cloudflare Worker, though, YouTube treats Workers' shared egress IPs
    // with much more suspicion -- confirmed empirically: without awaiting a
    // real token first, basic info requests can get rejected with
    // `playability_status: LOGIN_REQUIRED - Sign in to confirm you're not a
    // bot` from a deployed Worker relay (this did not happen when testing
    // against `wrangler dev` on a local machine's own IP). Awaiting it here
    // costs the same ~1-2s either way, just earlier.
    const poToken = await getVideoPoToken(yt, videoId);
    try {
      info = await fetchInfo(poToken);
    } catch (err) {
      if (!isTransientBotCheck(err)) throw err;
      const freshToken = await refreshVideoPoToken(yt, videoId);
      info = await fetchInfo(freshToken);
    }
  } catch (err) {
    throw wrapError(err, 'Could not load this video. It may be private, deleted, or region-restricted.');
  }

  const streamingData = info.streaming_data || {};
  const videoCandidates = collectVideoCandidates(streamingData);
  const videoTiers = mergeVideoTiersByHeight(videoCandidates);
  const bestAudio = pickBestAudio(streamingData.adaptive_formats || []);

  const video = videoTiers.map((tier) => ({
    height: tier.height,
    fps: tier.fps || null,
    label: tier.qualityLabel || `${tier.height}p`,
    approxBytes: tier.approxBytes ?? null,
    formatKey: encodeFormatKey({
      videoId,
      kind: tier.kind,
      itag: tier.itag,
      xtags: tier.xtags
    })
  }));

  const audio = bestAudio ? [ {
    label: bestAudio.audio_quality?.replace('AUDIO_QUALITY_', '') || 'Audio',
    approxBytes: bestAudio.content_length ?? null,
    formatKey: encodeFormatKey({
      videoId,
      kind: 'audio',
      itag: bestAudio.itag,
      xtags: bestAudio.xtags
    })
  } ] : [];

  const thumbnails = info.basic_info?.thumbnail || [];
  const thumbnail = thumbnails.length ? thumbnails.reduce((a, b) => (b.width > a.width ? b : a)).url : null;

  return {
    videoId,
    title: info.basic_info?.title || null,
    thumbnail,
    duration: info.basic_info?.duration ?? null,
    author: info.basic_info?.author || null,
    formats: { video, audio }
  };
}

/**
 * Fetches and fully assembles the chosen format into memory.
 * @param {string} formatKey - opaque value from getVideoFormats()'s video[]/audio[] entries
 * @param {(fraction: number, phase: 'video'|'audio') => void} [onProgress]
 */
export async function fetchFormat(formatKey, onProgress) {
  const payload = decodeFormatKey(formatKey);
  const { videoId, kind, itag, xtags } = payload;

  let yt, info, poToken;
  try {
    yt = await getInnertubeSession();
    // PoToken is minted BEFORE (not concurrently with) the /player request so
    // the request that establishes the SABR session actually carries it --
    // see innertube.js's doc-comment and this project's verification notes
    // for why: a content-bound PoToken supplied only to later SABR segment
    // requests (after /player already ran without one) was empirically no
    // better than no token at all.
    poToken = await getVideoPoToken(yt, videoId);
    info = await yt.getBasicInfo(videoId, poToken ? { po_token: poToken } : undefined);
  } catch (err) {
    throw wrapError(err, 'Could not load this video. It may be private, deleted, or region-restricted.');
  }

  const playabilityErr = playabilityError(info);
  if (playabilityErr) throw playabilityErr;

  const streamingData = info.streaming_data;
  const findByItag = (list) => (list || []).find((f) => f.itag === itag && (!xtags || f.xtags === xtags));

  // SABR sessions can die partway through with "attestation required" if
  // YouTube's server-side validation of our token comes back negative after
  // the stream has already been flowing for a while (see sabrDownload.js's
  // top-of-file comment). A completely fresh BotGuard session is the only
  // thing that can plausibly change that verdict, so on that specific
  // failure -- and only that one, not e.g. network errors -- retry exactly
  // once with a brand new token before giving up and surfacing the error.
  async function withAttestationRetry(run) {
    try {
      return await run(poToken);
    } catch (err) {
      if (!/attestation required/i.test(err?.message || '')) throw err;
      const freshToken = await refreshVideoPoToken(yt, videoId);
      return run(freshToken);
    }
  }

  try {
    if (kind === 'progressive') {
      const format = findByItag(streamingData.formats);
      if (!format) throw makeError(`Progressive format itag=${itag} no longer available.`, 'This format is no longer available for this video. Please refresh and pick another quality.');

      const { videoBuffer } = await downloadProgressive({ yt, format, poToken, onProgress });
      return { videoBuffer, audioBuffer: null, suggestedExt: videoExtOf(format.mime_type) };
    }

    if (kind === 'adaptive-video') {
      const videoFormat = findByItag(streamingData.adaptive_formats);
      if (!videoFormat) throw makeError(`Adaptive video format itag=${itag} no longer available.`, 'This format is no longer available for this video. Please refresh and pick another quality.');

      const audioFormat = pickBestAudio(streamingData.adaptive_formats);
      if (!audioFormat) throw makeError('No adaptive audio format available to pair with this video tier.', 'This video is missing an audio track and cannot be downloaded right now.');

      const { videoBuffer, audioBuffer } = await withAttestationRetry((tok) => downloadAdaptivePair({
        yt, videoId, streamingData, playerConfig: info.player_config, poToken: tok, videoFormat, audioFormat, onProgress
      }));
      return { videoBuffer, audioBuffer, suggestedExt: videoExtOf(videoFormat.mime_type) };
    }

    if (kind === 'audio') {
      const audioFormat = findByItag(streamingData.adaptive_formats);
      if (!audioFormat) throw makeError(`Adaptive audio format itag=${itag} no longer available.`, 'This format is no longer available for this video. Please refresh and try again.');

      const { audioBuffer } = await withAttestationRetry((tok) => downloadAudioOnly({
        yt, videoId, streamingData, playerConfig: info.player_config, poToken: tok, audioFormat, onProgress
      }));
      return { videoBuffer: null, audioBuffer, suggestedExt: audioExtOf(audioFormat.mime_type) };
    }

    throw makeError(`Unknown formatKey kind: ${kind}`, 'This format is not recognized.');
  } catch (err) {
    throw wrapError(err, 'Downloading this format failed. Please try again.');
  }
}
