// Static file serving for the no-build client: / → client/, /shared/ → shared/.
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** URL prefix → directory. The longest prefix wins, so /shared/ is checked before /. */
const MOUNTS = [
  ['/shared/', join(ROOT, 'shared')],
  ['/', join(ROOT, 'client')],
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wgsl': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
};

/**
 * Map a request path to a file path inside one of the mounts, or null when it
 * would escape the mount (e.g. `..` segments) or is malformed.
 * @param {string} urlPath
 */
export function resolvePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  for (const [prefix, dir] of MOUNTS) {
    if (!decoded.startsWith(prefix)) continue;
    let rel = decoded.slice(prefix.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const full = normalize(join(dir, rel));
    if (full !== dir && !full.startsWith(dir + sep)) return null;
    return full;
  }
  return null;
}

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
export async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const file = resolvePath(pathname);
  if (!file) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      // No build step means no hashed filenames. Revalidate on every load in dev.
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      res.writeHead(404).end('Not found');
    } else {
      res.writeHead(500).end('Server error');
      console.error('static:', err);
    }
  }
}
