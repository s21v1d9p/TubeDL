// Minimal static file server for the browser test page + esbuild bundle.
// Test-only, never shipped. Network calls from the bundle itself go straight
// to the real Cloudflare Worker relay's local `wrangler dev` instance
// (port 8787, started separately) via configureRelay() in entry.js -- this
// server only needs to serve index.html/bundle.js on a different port.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8790;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const filePath = path.join(__dirname, url.pathname === '/' ? '/index.html' : url.pathname);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`[static-server] listening on http://localhost:${PORT}`);
});
