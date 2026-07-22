/**
 * TubeDL CORS relay.
 *
 * This is intentionally "dumb": it does zero video processing, zero yt-dlp,
 * zero ffmpeg, zero business logic. It only does two things:
 *   1. Forwards a request to an allow-listed YouTube-family host.
 *   2. Adds permissive CORS headers to the response so the browser (running
 *      the actual extraction/merging logic from a GitHub Pages static site)
 *      is allowed to read the bytes.
 *
 * Contract (matches LuanRT/YouTube.js's own reference browser proxy so the
 * youtubei.js `fetch` override needs no special-casing for this relay):
 *   - Client rewrites a target URL by moving its real host into a `__host`
 *     query param and pointing `host` at this worker instead.
 *   - Client stashes the original request headers (as JSON) in `__headers`.
 *   - We restore the real host + headers, forward the request, strip our
 *     control params, and stream the upstream response straight back.
 */

const ALLOWED_HOST_SUFFIXES = [
  'youtube.com',
  'youtubei.googleapis.com',
  'googlevideo.com',
  'ytimg.com',
];

function isAllowedHost(host) {
  const h = host.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-goog-visitor-id, x-goog-api-key, x-origin, x-youtube-client-version, x-youtube-client-name, x-goog-api-format-version, x-user-agent, Accept-Language, Range, Referer',
    'Access-Control-Expose-Headers':
      'Content-Length, Content-Type, Content-Disposition, Accept-Ranges, Content-Range',
    'Access-Control-Max-Age': '86400',
  };
}

function copyHeader(name, to, from) {
  const v = from.get(name);
  if (v) to.set(name, v);
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    const targetHost = url.searchParams.get('__host');
    if (!targetHost) {
      return new Response('TubeDL CORS relay is running. Missing __host parameter for proxied requests.', {
        status: 200,
        headers: corsHeaders(origin),
      });
    }

    if (!isAllowedHost(targetHost)) {
      return new Response('Host not allowed.', { status: 403, headers: corsHeaders(origin) });
    }

    url.host = targetHost;
    url.protocol = 'https:';
    url.port = '';
    url.searchParams.delete('__host');

    let forwardedHeaders;
    try {
      forwardedHeaders = new Headers(JSON.parse(url.searchParams.get('__headers') || '[]'));
    } catch {
      forwardedHeaders = new Headers();
    }
    url.searchParams.delete('__headers');

    copyHeader('range', forwardedHeaders, request.headers);
    if (!forwardedHeaders.has('user-agent')) {
      forwardedHeaders.set('user-agent', DEFAULT_USER_AGENT);
    }
    forwardedHeaders.delete('origin');
    forwardedHeaders.delete('cookie');
    forwardedHeaders.delete('host');

    const isBodylessMethod = request.method === 'GET' || request.method === 'HEAD';
    const requestBody = isBodylessMethod ? undefined : await request.arrayBuffer();

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(url.toString(), {
        method: request.method,
        headers: forwardedHeaders,
        body: requestBody,
        redirect: 'follow',
      });
    } catch (err) {
      return new Response(`Upstream fetch failed: ${err.message}`, {
        status: 502,
        headers: corsHeaders(origin),
      });
    }

    const responseHeaders = new Headers(corsHeaders(origin));
    copyHeader('content-length', responseHeaders, upstreamResponse.headers);
    copyHeader('content-type', responseHeaders, upstreamResponse.headers);
    copyHeader('content-disposition', responseHeaders, upstreamResponse.headers);
    copyHeader('accept-ranges', responseHeaders, upstreamResponse.headers);
    copyHeader('content-range', responseHeaders, upstreamResponse.headers);

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  },
};
