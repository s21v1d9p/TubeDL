/**
 * SABR/UMP media download, using googlevideo's `SabrStream` -- a purpose-built
 * "download this format from start to finish" client (NOT the live-playback
 * `SabrStreamingAdapter`/`SabrPlayerAdapter` pair, which is for driving an
 * actual <video> element and needs a player-time clock). `SabrStream` derives
 * its own internal progress from segments already downloaded, so it naturally
 * fetches as fast as the network/server allow with no pacing logic needed.
 *
 * Approach confirmed against LuanRT/kira's actual downloader
 * (src/composables/useSabrDownloader.ts), the one real reference app that
 * ships a "SABR-based downloader" feature analogous to what we need here.
 *
 * PoToken refresh strategy: YouTube's server validates the attestation
 * asynchronously (`StreamProtectionStatus` starts at 0/1 "ok", can move to 2
 * "pending", and only escalates to 3 "attestation required" -- fatal -- some
 * time after the stream has already been flowing). A single upfront token is
 * not sufficient for long/high-tier downloads in practice: this module (a)
 * proactively mints and attaches a *fresh* token as soon as status reaches 2,
 * before it has a chance to escalate to 3, and (b) if a session still dies
 * with "attestation required", retries once from scratch with a brand-new
 * BotGuard session (see `refreshVideoPoToken`/`getFreshPoToken`) -- a fresh
 * challenge/response is the only thing that can plausibly change the
 * server's verdict, since re-minting from the same cached session reuses the
 * same underlying integrity token and empirically makes no difference.
 */
import { SabrStream } from 'googlevideo/sabr-stream';
import { buildSabrFormat, EnabledTrackTypes } from 'googlevideo/utils';

import { createRelayFetch } from './relay.js';
import { getClientNameId, refreshVideoPoToken } from './innertube.js';
import { makeError } from './errors.js';

const PROACTIVE_REFRESH_INTERVAL_MS = 20_000;

/**
 * Attaches a `streamProtectionStatusUpdate` listener that proactively mints
 * and attaches a fresh PoToken as soon as the server signals "pending"
 * attestation, plus a belt-and-suspenders periodic refresh for very long
 * downloads. Returns a cleanup function to call once the download settles.
 * @param {import('googlevideo/sabr-stream').SabrStream} sabrStream
 * @param {import('youtubei.js').Innertube} yt
 * @param {string} videoId
 */
function attachPoTokenRefresh(sabrStream, yt, videoId) {
  let refreshing = false;
  const refresh = () => {
    if (refreshing) return;
    refreshing = true;
    refreshVideoPoToken(yt, videoId)
      .then((token) => {
        if (token) sabrStream.setPoToken(token);
      })
      .finally(() => {
        refreshing = false;
      });
  };

  sabrStream.on('streamProtectionStatusUpdate', (status) => {
    if (status?.status === 2) refresh();
  });

  const timer = setInterval(refresh, PROACTIVE_REFRESH_INTERVAL_MS);
  return () => clearInterval(timer);
}

/** Reads a whole ReadableStream<Uint8Array> into one ArrayBuffer, reporting byte progress. */
async function drainStream(stream, expectedBytes, onBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) {
      chunks.push(value);
      received += value.length;
      onBytes?.(received, expectedBytes);
    }
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

/**
 * Builds and configures a `SabrStream` for a given InnerTube session/video.
 * @param {object} args
 * @param {import('youtubei.js').Innertube} args.yt
 * @param {import('youtubei.js').Types.IStreamingData} args.streamingData
 * @param {import('youtubei.js').Types.IPlayerConfig} args.playerConfig
 * @param {string|undefined} args.poToken
 */
async function createSabrStream({ yt, streamingData, playerConfig, poToken }) {
  const ustreamerConfig = playerConfig?.media_common_config?.media_ustreamer_request_config?.video_playback_ustreamer_config;
  if (!ustreamerConfig) {
    throw makeError(
      'streaming_data/player_config missing video_playback_ustreamer_config; cannot start a SABR session.',
      'This video cannot be downloaded right now (missing streaming configuration).'
    );
  }
  if (!streamingData?.server_abr_streaming_url) {
    throw makeError(
      'streaming_data missing server_abr_streaming_url.',
      'This video cannot be downloaded right now (missing streaming URL).'
    );
  }

  const serverAbrStreamingUrl = await yt.session.player?.decipher(streamingData.server_abr_streaming_url);
  const formats = (streamingData.adaptive_formats || []).map(buildSabrFormat);

  return new SabrStream({
    formats,
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: ustreamerConfig,
    fetch: createRelayFetch(),
    poToken,
    clientInfo: {
      clientName: getClientNameId(yt),
      clientVersion: yt.session.context.client.clientVersion
    }
  });
}

/**
 * Downloads a video-only + audio-only adaptive pair in a single SABR session
 * (the server interleaves both tracks' segments in one request/response loop,
 * so this is one download pass, not two).
 * @param {object} args
 * @param {import('youtubei.js').Innertube} args.yt
 * @param {string} args.videoId
 * @param {import('youtubei.js').Types.IStreamingData} args.streamingData
 * @param {import('youtubei.js').Types.IPlayerConfig} args.playerConfig
 * @param {string|undefined} args.poToken
 * @param {import('youtubei.js').Types.Format} args.videoFormat
 * @param {import('youtubei.js').Types.Format} args.audioFormat
 * @param {(fraction: number, phase: 'video'|'audio') => void} [args.onProgress]
 */
export async function downloadAdaptivePair({ yt, videoId, streamingData, playerConfig, poToken, videoFormat, audioFormat, onProgress }) {
  const sabrStream = await createSabrStream({ yt, streamingData, playerConfig, poToken });
  const stopRefresh = attachPoTokenRefresh(sabrStream, yt, videoId);

  const videoSabrFormat = buildSabrFormat(videoFormat);
  const audioSabrFormat = buildSabrFormat(audioFormat);

  const { videoStream, audioStream } = await sabrStream.start({
    videoFormat: videoSabrFormat,
    audioFormat: audioSabrFormat,
    enabledTrackTypes: EnabledTrackTypes.VIDEO_AND_AUDIO
  });

  try {
    const [ videoBuffer, audioBuffer ] = await Promise.all([
      drainStream(videoStream, videoFormat.content_length, (received, total) => {
        if (onProgress && total) onProgress(Math.min(received / total, 1), 'video');
      }),
      drainStream(audioStream, audioFormat.content_length, (received, total) => {
        if (onProgress && total) onProgress(Math.min(received / total, 1), 'audio');
      })
    ]);

    return { videoBuffer, audioBuffer };
  } catch (err) {
    throw makeError(
      `SABR adaptive download failed: ${err.message}`,
      'Downloading this video failed partway through. Please try again.',
      err
    );
  } finally {
    stopRefresh();
  }
}

/**
 * Downloads a single audio-only adaptive format.
 * @param {object} args
 * @param {import('youtubei.js').Innertube} args.yt
 * @param {string} args.videoId
 * @param {import('youtubei.js').Types.IStreamingData} args.streamingData
 * @param {import('youtubei.js').Types.IPlayerConfig} args.playerConfig
 * @param {string|undefined} args.poToken
 * @param {import('youtubei.js').Types.Format} args.audioFormat
 * @param {(fraction: number, phase: 'video'|'audio') => void} [args.onProgress]
 */
export async function downloadAudioOnly({ yt, videoId, streamingData, playerConfig, poToken, audioFormat, onProgress }) {
  const sabrStream = await createSabrStream({ yt, streamingData, playerConfig, poToken });
  const stopRefresh = attachPoTokenRefresh(sabrStream, yt, videoId);
  const audioSabrFormat = buildSabrFormat(audioFormat);

  const { audioStream } = await sabrStream.start({
    audioFormat: audioSabrFormat,
    enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY
  });

  try {
    const audioBuffer = await drainStream(audioStream, audioFormat.content_length, (received, total) => {
      if (onProgress && total) onProgress(Math.min(received / total, 1), 'audio');
    });
    return { audioBuffer };
  } catch (err) {
    throw makeError(
      `SABR audio-only download failed: ${err.message}`,
      'Downloading this audio failed partway through. Please try again.',
      err
    );
  } finally {
    stopRefresh();
  }
}

/**
 * Downloads a progressive (already-muxed) format via a plain HTTP GET --
 * no SABR/UMP involved, since these older formats are still served as
 * ordinary byte streams.
 * @param {object} args
 * @param {import('youtubei.js').Innertube} args.yt
 * @param {import('youtubei.js').Types.Format} args.format
 * @param {string|undefined} args.poToken
 * @param {(fraction: number, phase: 'video'|'audio') => void} [args.onProgress]
 */
export async function downloadProgressive({ yt, format, poToken, onProgress }) {
  const deciphered = await format.decipher(yt.session.player);
  if (!deciphered) {
    throw makeError('Progressive format has no fetchable URL after deciphering.', 'This video format is not available right now.');
  }

  // Attach the PoToken if the deciphered URL doesn't already carry one --
  // YouTube's CDN increasingly gates plain progressive GETs on this too.
  const url = new URL(deciphered);
  if (poToken && !url.searchParams.has('pot')) {
    url.searchParams.set('pot', poToken);
  }

  const fetchFn = createRelayFetch();
  const response = await fetchFn(url);
  if (!response.ok) {
    throw makeError(`Progressive download failed with HTTP ${response.status}.`, 'Downloading this video failed. Please try again.');
  }

  const expected = format.content_length || Number(response.headers.get('content-length')) || undefined;

  try {
    const videoBuffer = await drainStream(response.body, expected, (received, total) => {
      if (onProgress && total) onProgress(Math.min(received / total, 1), 'video');
    });
    return { videoBuffer };
  } catch (err) {
    throw makeError(`Progressive download failed: ${err.message}`, 'Downloading this video failed partway through. Please try again.', err);
  }
}
