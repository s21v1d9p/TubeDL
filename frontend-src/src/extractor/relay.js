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
 */

let relayBaseUrl = null;

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

  return function relayFetch(input, init) {
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
    return fetch(request, { ...init, headers, credentials: 'omit' });
  };
}
