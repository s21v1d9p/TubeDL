/**
 * Innertube (youtubei.js) session management.
 *
 * Uses a single cached WEB-client session with a real BotGuard PoToken.
 *
 * This is a deliberate pivot from an earlier IOS-preferred design (mirroring
 * cobalt.tools' documented "IOS avoids needing PoToken for <=1080p"
 * strategy): empirical testing against the real SABR/UMP endpoint showed the
 * IOS client gets stuck in a permanent "attestation pending" state and
 * stalls after ~5 segments, WITH OR WITHOUT a PoToken attached. A
 * bgutils-js-minted PoToken is a WEB-flavored BotGuard attestation -- it
 * doesn't satisfy whatever native-app attestation IOS's SABR endpoint
 * actually expects. cobalt.tools' IOS shortcut most likely relies on
 * directly fetching IOS's (SABR-free) CDN URLs -- the legacy approach this
 * project's own background research says is now outdated for anything above
 * 360p. WEB + a real PoToken is the only path that reliably completed a full
 * SABR download in testing, at every resolution tried (240p through 2160p),
 * so it's used unconditionally here rather than conditionally per-resolution.
 */
import { Innertube, UniversalCache, Constants, Platform } from 'youtubei.js';
import { createRelayFetch } from './relay.js';
import { getPoToken, getFreshPoToken } from './potoken.js';

// Deciphering streaming URLs (WEB's "n"/signature cipher) requires executing
// a snippet of YouTube's own JS. youtubei.js ships no interpreter itself --
// this is the documented hook (https://ytjs.dev/guide/getting-started,
// "Providing a custom JavaScript interpreter"). `Function` exists in both
// Node and every browser, so the same wiring works unmodified once bundled.
Platform.shim.eval = async (data) => new Function(data.output)();

/** @type {Promise<import('youtubei.js').Innertube>|null} */
let sessionPromise = null;

/**
 * Returns the cached Innertube (WEB client) session, creating it on first use.
 * @returns {Promise<import('youtubei.js').Innertube>}
 */
export function getInnertubeSession() {
  if (!sessionPromise) {
    sessionPromise = Innertube.create({
      fetch: createRelayFetch(),
      generate_session_locally: true,
      retrieve_player: true,
      cache: new UniversalCache(false)
    });
  }
  return sessionPromise;
}

/**
 * PoTokens must be *content-bound* to the video they're used for -- YouTube's
 * web client mints a fresh token per video ID, not one shared/reused across a
 * whole session (confirmed via bgutils-js's own README: the "session bound"
 * token keyed on visitor data is explicitly deprecated/no longer honored by
 * YouTube's web client; only the video-ID-bound "content bound" token is
 * actually checked by the streaming/SABR pipeline today). A visitor-data-bound
 * token is accepted as syntactically well-formed but is silently ignored --
 * empirically confirmed: it produced byte-for-byte identical stall timing to
 * having no token at all on a video long enough to exceed the ~1-2MB
 * grace window every client gets regardless of attestation state.
 * @type {Map<string, Promise<string|undefined>>}
 */
const poTokenPromiseByVideoId = new Map();

/**
 * Lazily mints (and caches, per video ID) a content-bound PoToken. Safe to
 * call repeatedly/concurrently for the same or different video IDs -- the
 * underlying BotGuard VM is only ever built once (see potoken.js); only the
 * cheap final minting step repeats per video.
 * Call this (without awaiting) as early as possible to hide BotGuard's
 * ~1-2s VM-startup latency behind other work; await the same cached promise
 * later, right before it's actually needed for a download.
 * @param {import('youtubei.js').Innertube} yt
 * @param {string} videoId
 * @returns {Promise<string|undefined>}
 */
export function getVideoPoToken(yt, videoId) {
  if (!poTokenPromiseByVideoId.has(videoId)) {
    const fetchFn = createRelayFetch();
    const promise = getPoToken(videoId, fetchFn)
      .then((token) => {
        yt.session.po_token = token;
        if (yt.session.player) yt.session.player.po_token = token;
        return token;
      })
      .catch((err) => {
        poTokenPromiseByVideoId.delete(videoId);
        console.warn(`[extractor] PoToken generation failed for video ${videoId}:`, err?.message || err);
        return undefined;
      });
    poTokenPromiseByVideoId.set(videoId, promise);
  }
  return poTokenPromiseByVideoId.get(videoId);
}

/**
 * Mints a token from a brand-new BotGuard session and replaces the cached
 * one for this video ID. Used for the mid-download proactive refresh and the
 * one-retry-with-a-fresh-session recovery path (see sabrDownload.js) -- both
 * exist to work around YouTube's server occasionally rejecting an
 * already-real token partway through a long SABR session
 * (`StreamProtectionStatus` 2 -> 3, "attestation required").
 * @param {import('youtubei.js').Innertube} yt
 * @param {string} videoId
 * @returns {Promise<string|undefined>}
 */
export function refreshVideoPoToken(yt, videoId) {
  const fetchFn = createRelayFetch();
  const promise = getFreshPoToken(videoId, fetchFn)
    .then((token) => {
      yt.session.po_token = token;
      if (yt.session.player) yt.session.player.po_token = token;
      return token;
    })
    .catch((err) => {
      console.warn(`[extractor] Fresh PoToken refresh failed for video ${videoId}:`, err?.message || err);
      return undefined;
    });
  poTokenPromiseByVideoId.set(videoId, promise);
  return promise;
}

/** Numeric InnerTube client name ID (see youtubei.js Constants.CLIENT_NAME_IDS), needed by SabrStream's clientInfo. */
export function getClientNameId(yt) {
  const clientName = yt.session.context.client.clientName;
  const id = Constants.CLIENT_NAME_IDS[clientName];
  if (!id) throw new Error(`No numeric client name ID known for InnerTube client "${clientName}".`);
  return parseInt(id, 10);
}
