// Vercel Function: GET /api/projects lists the newest saved projects from Snowflake; GET /api/projects?id=<id> returns
// one with its scene (the gallery reload and the host's "Saved to Snowflake" confirmation poll). Always JSON, never cached.
// Uses only core req/res methods, so the same handler also mounts on express or a bare http server.
//   list:  200 { ok: true, projects, configured: true }          Snowflake answered (projects may be [])
//          200 { ok: false, configured: true, error: 'unavailable', projects: [] }   configured but unreachable: 'local only'
//          200 { ok: true, projects: [], configured: false }    no Snowflake env at all
//   ?id=:  200 { ok: true, project } | 404 { ok: false } not found | 503 { ok: false, configured: true, error: 'unavailable' }
//          404 { ok: false, configured: false } with no Snowflake env; 400 for a malformed id.
import * as snowflake from '../lib/snowflake.js';

function send(res, status, body, extra = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

// The store is injectable so the tests run without Snowflake.
export function createHandler(store = snowflake) {
  return async function handler(req, res) {
    try {
      if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method not allowed' }, { Allow: 'GET' });
      const id = new URL(req.url || '/', 'http://localhost').searchParams.get('id');
      if (id !== null && !store.isProjectId(id)) return send(res, 400, { ok: false, error: 'bad id' });
      if (!store.configured()) {
        return id === null
          ? send(res, 200, { ok: true, projects: [], configured: false })
          : send(res, 404, { ok: false, configured: false });
      }
      if (id === null) {
        const list = await store.listProjectsResult(24);
        return list.ok
          ? send(res, 200, { ok: true, projects: list.rows, configured: true })
          : send(res, 200, { ok: false, configured: true, error: 'unavailable', projects: [] });
      }
      const one = await store.getProjectResult(id);
      if (!one.ok) return send(res, 503, { ok: false, configured: true, error: 'unavailable' });
      return one.project ? send(res, 200, { ok: true, project: one.project }) : send(res, 404, { ok: false });
    } catch (err) {
      console.warn('api/projects:', err?.message);
      if (!res.headersSent) send(res, 500, { ok: false, error: 'unavailable' });
    }
  };
}

export default createHandler();
