# TubeDL CORS relay (Cloudflare Worker)

A tiny, free, serverless relay. It does **zero** video processing, zero
`yt-dlp`, zero business logic -- it only forwards requests to YouTube's
InnerTube API / CDN and adds the CORS headers Google doesn't send to
third-party origins. All the actual extraction, format parsing, PoToken
generation, and video/audio merging happens in the visitor's own browser
(see `../frontend-src/`). This is the smallest possible server-side piece
that a fully client-side YouTube downloader can't avoid -- see the root
README's "Why a relay at all?" section for why.

Cost: **$0** on Cloudflare's Workers Free plan (100,000 requests/day, no
credit card required as of writing). No server to manage -- it's a
serverless function that only runs per-request.

## Deploy (one-time)

```bash
cd worker
npm install
npx wrangler login      # opens a browser to authorize your Cloudflare account
npx wrangler deploy
```

This prints your deployed URL, e.g. `https://tubedl-relay.<your-subdomain>.workers.dev`.

Copy that URL into `frontend-src/src/app-entry.js`'s `RELAY_BASE_URL`
constant (replacing the `YOUR-SUBDOMAIN` placeholder), then rebuild the
frontend (`cd ../frontend-src && npm run build`) or just push to `main` --
the GitHub Actions workflow rebuilds it automatically.

## Local development

```bash
npm install
npx wrangler dev --port 8787
```

Then point `RELAY_BASE_URL` at `http://localhost:8787` while developing.

## What it allows

Only requests to these host suffixes are forwarded (everything else gets a
403) -- this keeps the relay from becoming an open proxy for arbitrary
sites:

- `youtube.com`
- `youtubei.googleapis.com`
- `googlevideo.com`
- `ytimg.com`

## Security notes

- The visiting browser's own cookies are never forwarded upstream.
- No state, no storage, no logging of what's requested beyond Cloudflare's
  own standard platform request logs.
- `Access-Control-Allow-Origin` reflects whatever `Origin` sent the
  request (safe here since the relay holds no secrets/session state and
  performs no privileged action -- it's a public, stateless byte relay).
