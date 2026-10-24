// Vercel Function: POST /api/depth {id, png} -> {depth_url}. The TV estimates a saved scene's depth in its own browser
// (Depth Anything V2 Small, src/host/depthAI.js) and stores the result here at depth/<id>.png (public, fixed name,
// overwritten), so the next replay of that project loads the image instead of running the model again.
// Host page only: with HOST_TOKEN set, x-host-token must match it (401), checked before the body is read; an empty
// HOST_TOKEN means no check, local only, as in api/sfx.js. Every error is {error}: 400, 401, 405, 413 or 500.
import { put as blobPut } from '@vercel/blob';
import { readBody, sniff } from './interpret.js';
import { tokenMatches } from './sfx.js';

export const MAX_PNG = 1024 * 1024; // decoded bytes; a 512 px grayscale depth PNG is a few hundred KB at most
const MAX_B64 = Math.ceil(MAX_PNG / 3) * 4;
const MAX_BODY = MAX_B64 + 1024;
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const blobPath = (id) => `depth/${id}.png`;

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

// -> {id, bytes} or {status, error}.
export function parseRequest(body) {
  const id = body.id, png = body.png;
  if (typeof id !== 'string' || !ID_RE.test(id)) return { status: 400, error: 'bad id' };
  if (typeof png !== 'string' || !png) return { status: 400, error: 'no png' };
  if (png.length > MAX_B64) return { status: 413, error: 'too large' };
  if (png.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(png)) return { status: 400, error: 'not base64' };
  const bytes = Buffer.from(png, 'base64');
  if (bytes.length > MAX_PNG) return { status: 413, error: 'too large' };
  if (!sniff(bytes) || sniff(bytes).mime !== 'image/png') return { status: 400, error: 'not a png' };
  return { id, bytes };
}

export function createHandler(deps = {}) {
  const env = deps.env || process.env;
  const put = deps.put || blobPut;
  return async function handler(req, res) {
    try {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, { Allow: 'POST' });
      const hostToken = env.HOST_TOKEN || '';
      if (hostToken && !tokenMatches(req.headers && req.headers['x-host-token'], hostToken)) return send(res, 401, { error: 'host token' });
      const got = await readBody(req, MAX_BODY);
      if (got.status) return send(res, got.status, { error: got.status === 413 ? 'too large' : 'bad body' });
      const r = parseRequest(got.body);
      if (r.error) return send(res, r.status, { error: r.error });
      let blob;
      try {
        blob = await put(blobPath(r.id), r.bytes, { access: 'public', contentType: 'image/png', addRandomSuffix: false, allowOverwrite: true });
      } catch (err) {
        console.warn('depth: put', r.id, '-', err && err.message);
        return send(res, 500, { error: 'storage' });
      }
      return send(res, 200, { depth_url: blob.url });
    } catch (err) {
      console.warn('depth: handler', err && err.message);
      if (!res.headersSent) send(res, 500, { error: 'internal' });
    }
  };
}

export default createHandler();
