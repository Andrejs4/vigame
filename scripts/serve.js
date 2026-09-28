/**
 * Minimal static file server for development. ES modules do not load from
 * file:// URLs, so index.html needs to be served over HTTP.
 *
 * No dependencies. Usage: node scripts/serve.js [port]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * Serve the repository root over HTTP.
 * @param {number} [port=0] 0 picks a free port.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startServer(port = 0) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (path !== ROOT && !path.startsWith(ROOT + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
      const body = await readFile(path);
      res.writeHead(200, {
        'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });

  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = /** @type {import('node:net').AddressInfo} */ (server.address());
      res({
        url: `http://127.0.0.1:${actual}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url } = await startServer(Number(process.argv[2] ?? process.env.PORT ?? 8080));
  console.log(`vigame dev server: ${url}`);
}
