/**
 * CORS relay integration.
 *
 * YouTube's InnerTube API and googlevideo.com CDN do not send permissive CORS
 * headers to third-party origins, so in a browser every request must be
 * rewritten to go through TubeDL's dumb CORS-relay Cloudflare Worker, using the
 * `__host` / `__headers` query-param contract established by LuanRT's
 * reference proxy (examples/browser/proxy/deno.ts in YouTube.js).
 *
 * In Node (used for this module's fast inner-loop sanity tests) there's no CORS
 * to work around, so when no relay is configured this falls back to plain
 * `fetch` unmodified.
 *
 * Root-caused via direct response-body capture (a raw `403` with
 * `content-type: text/html`, not the InnerTube API's normal JSON): Google's
 * front-end intermittently serves its generic "unusual traffic" block page
 * (the same one regular Google Search shows) to the relay's outbound
 * requests -- this is an IP-reputation signal against Cloudflare Workers'
 * large *shared* egress IP pool (heavily used across many unrelated
 * Workers/accounts for scraping), not anything specific to this relay, this
 * app, or a real YouTube API error. It happens before the request ever
 * reaches YouTube's actual backend, so no amount of PoToken/session-level
 * fixes can prevent it -- but it's tied to *which* Cloudflare edge/egress IP
 * handled that specific request, so a retry frequently lands on a
 * currently-clean one and succeeds.
 */

let relayBaseUrl = null;

const MAX_RELAY_ATTEMPTS = 4;
const RELAY_RETRY_BASE_DELAY_MS = 600;

/**
 * Call once at startup to point all subsequent network calls through the relay.
 * @param {string} baseUrl - e.g. "https://tubedl-relay.<subdomain>.workers.dev"
 */
export function configureRelay(baseUrl) {
  relayBaseUrl = baseUrl ? baseUrl.replace(/\/+$/, '') : null;
}

/** Returns the currently configured relay base URL, or null if unset. */
export function getRelayBaseUrl() {
  return relayBaseUrl;
}

/**
 * True if `response` looks like Google's generic infrastructure-level
 * "unusual traffic" block page rather than a real InnerTube/googlevideo
 * response. Cheap to check -- reads only status + headers, never the body,
 * so it's safe to call even for large media/SABR responses.
 * @param {Response} response
 */
function looksLikeInfraBlock(response) {
  if (response.ok) return false;
  const contentType = response.headers.get('content-type') || '';
  return contentType.includes('text/html');
}

/**
 * Builds a fetch-compatible function that transparently rewrites requests to
 * go through the configured relay. If no relay is configured, returns the
 * platform's native fetch unmodified.
 * @returns {typeof fetch}
 */
export function createRelayFetch() {
  const base = relayBaseUrl;

  if (!base) {
    return (input, init) => fetch(input, init);
  }

  const relay = new URL(base);

  return async function relayFetch(input, init) {
    const url = typeof input === 'string'
      ? new URL(input)
      : input instanceof URL
        ? new URL(input.toString())
        : new URL(input.url);

    const headers = init?.headers
      ? new Headers(init.headers)
      : (typeof Request !== 'undefined' && input instanceof Request ? input.headers : new Headers());

    // Stash the real target + original headers as query params, then point the
    // request at the relay's origin. The relay reads `__host`/`__headers` to
    // reconstruct and forward the real request (see worker contract in README).
    url.searchParams.set('__host', url.host);
    url.searchParams.set('__headers', JSON.stringify([ ...headers ]));
    url.protocol = relay.protocol;
    url.host = relay.host;

    const request = new Request(url, typeof Request !== 'undefined' && input instanceof Request ? input : undefined);
    // The browser sets its own user-agent; forwarding a spoofed one just trips CORS preflight rules.
    headers.delete('user-agent');

    // youtubei.js's internal HTTPClient sets `credentials: 'include'` on every
    // InnerTube API call by default (so cookie-based sign-in features work),
    // unless `Platform.shim.runtime === 'cf-worker'`. A third-party CORS relay
    // has no business receiving browser cookies for a public video-download
    // flow -- and the relay strips any `cookie` header server-side regardless
    // -- so this is forced off unconditionally. This also happens to be
    // required for the request to succeed at all: a browser CORS request with
    // `credentials: 'include'` requires the server to echo back an explicit
    // `Access-Control-Allow-Credentials: true`, which a generic passthrough
    // relay correctly does not send, so leaving 'include' set produces a hard
    // CORS failure (empirically confirmed against the real relay).
    const fetchInit = { ...init, headers, credentials: 'omit' };

    let lastResponse;
    for (let attempt = 1; attempt <= MAX_RELAY_ATTEMPTS; attempt++) {
      // `request` is kept purely as a clone template and never fetched
      // directly -- a Request's body stream can only be consumed once, so
      // reusing it for the first attempt left nothing left to clone from on
      // retry ("Request body is already used"). Every attempt, including
      // the first, fetches its own fresh clone instead.
      lastResponse = await fetch(request.clone(), fetchInit);

      if (!looksLikeInfraBlock(lastResponse)) return lastResponse;
      if (attempt === MAX_RELAY_ATTEMPTS) return lastResponse;

      lastResponse.body?.cancel().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, RELAY_RETRY_BASE_DELAY_MS * attempt));
    }
    return lastResponse;
  };
}
