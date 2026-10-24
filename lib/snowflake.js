// Snowflake persistence for saved projects, over the SQL REST API (POST /api/v2/statements) with a programmatic access
// token (SNOWFLAKE_PAT, sent as is) or else a key-pair JWT signed by node:crypto per request; no driver. The PAT wins
// when both are set, and never appears in an error or log line. saveProject / listProjects / getProject never throw (false / [] / null);
// listProjectsResult / getProjectResult never throw either and add ok:false when Snowflake did not answer, so a caller
// can tell "configured but unreachable" from "empty". sql() is the raw primitive and throws an Error whose message
// carries only the HTTP status and Snowflake's code. Writes go with ?async=true (answered 202 at once, even while a
// cold warehouse resumes); reads stay synchronous, a read answered 202 is polled briefly.
import crypto from 'node:crypto';

const REQUIRED = ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_WAREHOUSE', 'SNOWFLAKE_DATABASE', 'SNOWFLAKE_SCHEMA'];
const KEY_PAIR = ['SNOWFLAKE_USER', 'SNOWFLAKE_PRIVATE_KEY']; // needed only without a PAT
const HTTP_MS = 8000;
const POLL_MS = [250, 500, 1000, 1500]; // a SELECT answered 202 is polled this many times, then given up
const JWT_S = 600; // Snowflake accepts at most an hour
const UA = 'LivingBlueprint/2.0';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/; // crypto.randomUUID ids, plus slug ids for bundled samples
const HANDLE = /^[0-9A-Za-z-]{1,80}$/;
const READS = /^\s*(select|with|show|desc|describe)\b/i;
const CLOUD = /^(aws|azure|gcp)$/;
const REGION = /^[a-z]+(-[a-z0-9]+)+$/; // us-east-1, east-us-2, europe-west2: every Snowflake region id has a hyphen

const INSERT = `INSERT INTO PROJECTS (ID, NAME, SOURCE, IMAGE_URL, SCENE_URL, SCENE, TITLE_GUESS, ARTIST_GUESS, CREDIT)
SELECT ?, ?, ?, ?, ?, PARSE_JSON(?), ?, ?, NULLIF(?, '')`;
const LIST_COLS = 'ID, NAME, SOURCE, IMAGE_URL, SCENE_URL, TITLE_GUESS, ARTIST_GUESS, CREATED_AT';
const GET = 'SELECT ID, NAME, SOURCE, IMAGE_URL, SCENE_URL, SCENE, TITLE_GUESS, ARTIST_GUESS, CREDIT, CREATED_AT FROM PROJECTS WHERE ID = ? LIMIT 1';

const has = (env, k) => String(env[k] ?? '').trim() !== '';
// Quotes stripped as pemOf does: Vercel's env editor can keep a pasted "…" around the value.
const patOf = (env) => String(env.SNOWFLAKE_PAT ?? '').trim().replace(/^["']|["']$/g, '').trim();
export const configured = (env = process.env) =>
  REQUIRED.every((k) => has(env, k)) && (patOf(env) !== '' || KEY_PAIR.every((k) => has(env, k)));

// The secret cut out of a message: undici quotes a malformed header value back in its TypeError.
const redact = (s, secret) => (secret ? String(s).split(secret).join('[token]') : String(s));

// Account as typed or pasted: 'myorg-myacct', 'myorg.myacct', 'xy12345.us-east-2.aws', or the full https URL.
function bare(account) {
  return String(account ?? '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    .replace(/\.snowflakecomputing\.com$/, '').replace(/\.privatelink$/, '');
}
const regionTail = (parts) => parts.length > 1 && parts.slice(1).every((s) => CLOUD.test(s) || REGION.test(s));

// The JWT's account: uppercase, a locator's region segments dropped, org.account periods turned into hyphens.
export function jwtAccount(account) {
  const parts = bare(account).split('.');
  return (regionTail(parts) ? parts[0] : parts.join('-')).toUpperCase();
}

// The URL's host label: a locator keeps its region (the URL needs it); underscores become hyphens as Snowflake advises.
export function accountHost(account) {
  const parts = bare(account).split('.');
  const host = (regionTail(parts) ? parts.join('.') : parts.join('-')).replace(/_/g, '-');
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(host)) throw new Error('snowflake: bad SNOWFLAKE_ACCOUNT');
  return host;
}

// Vercel's env editor may hand the PEM back with literal \n, spaces for newlines, quotes, or no header at all.
export function pemOf(raw) {
  const s = String(raw ?? '').trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
  const m = s.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  const label = m ? m[1] : 'PRIVATE KEY';
  const body = (m ? m[2] : s).replace(/\s+/g, '');
  return `-----BEGIN ${label}-----\n${(body.match(/.{1,64}/g) || []).join('\n')}\n-----END ${label}-----\n`;
}

// 'SHA256:' + base64(sha256(SPKI DER of the public key)), the RSA_PUBLIC_KEY_FP that DESCRIBE USER shows.
export function fingerprint(key) {
  const der = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  return 'SHA256:' + crypto.createHash('sha256').update(der).digest('base64');
}

const b64url = (s) => Buffer.from(s).toString('base64url');

export function mintJwt({ account, user, privateKeyPem, now = Date.now() }) {
  const key = crypto.createPrivateKey(pemOf(privateKeyPem));
  const who = `${jwtAccount(account)}.${String(user ?? '').trim().toUpperCase()}`;
  const iat = Math.floor(Number(now) / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: `${who}.${fingerprint(key)}`, sub: who, iat, exp: iat + JWT_S }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), key).toString('base64url');
  return `${head}.${claims}.${sig}`;
}

// The API wants every bind value as a string; numbers go as FIXED, everything else as TEXT (null as '').
export function bindings(binds) {
  return Object.fromEntries(binds.map((v, i) => [String(i + 1), typeof v === 'number'
    ? { type: 'FIXED', value: String(v) }
    : { type: 'TEXT', value: v == null ? '' : String(v) }]));
}

// Unquoted names resolve uppercase in SQL, but these body fields are case-sensitive, so match what SQL would use.
const ident = (v) => { const s = String(v).trim(); return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(s) ? s.toUpperCase() : s.replace(/^"(.*)"$/, '$1'); };

// Rows as objects keyed by lowercased column names from resultSetMetaData.rowType.
export function rowsOf(json) {
  const names = (json?.resultSetMetaData?.rowType || []).map((c) => String(c.name).toLowerCase());
  return (Array.isArray(json?.data) ? json.data : []).map((row) => Object.fromEntries(names.map((n, i) => [n, row?.[i] ?? null])));
}

// TIMESTAMP_LTZ comes back as epoch seconds with a fraction ('1729766400.123000000'); anything else passes through.
export function toIso(v) {
  const m = /^(-?\d+(?:\.\d+)?)(?: \d+)?$/.exec(String(v ?? ''));
  return m ? new Date(Number(m[1]) * 1000).toISOString() : v ?? null;
}

const ctx = (o = {}) => ({
  fetch: o.fetch || globalThis.fetch,
  env: o.env || process.env,
  sleep: o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
  now: o.now || Date.now,
});

async function call(c, method, path, body) {
  const e = c.env;
  // A PAT names its own user (no SNOWFLAKE_USER, no signing); the type header is optional for it but stated anyway.
  const pat = patOf(e);
  const token = pat || mintJwt({ account: e.SNOWFLAKE_ACCOUNT, user: e.SNOWFLAKE_USER, privateKeyPem: e.SNOWFLAKE_PRIVATE_KEY, now: c.now() });
  const res = await c.fetch(`https://${accountHost(e.SNOWFLAKE_ACCOUNT)}.snowflakecomputing.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Snowflake-Authorization-Token-Type': pat ? 'PROGRAMMATIC_ACCESS_TOKEN' : 'KEYPAIR_JWT',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': UA,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(HTTP_MS),
  });
  let json = null;
  try { json = await res.json(); } catch { /* an empty or HTML error body; the status still says enough */ }
  return { status: res.status, json };
}

function failure(r, secret) {
  const code = r.json?.code ? ` ${r.json.code}` : '';
  const msg = r.json?.message ? ` ${redact(r.json.message, secret).slice(0, 200)}` : ''; // redacted before the cut, so no prefix of it survives
  return new Error(`snowflake HTTP ${r.status}${code}${msg}`);
}

// Runs one statement; resolves { rows, accepted, handle }. A write is posted with ?async=true, so Snowflake answers 202
// with a statementHandle at once and finishes it server-side: accepted is then true and handle is that statementHandle
// (the Query ID in Snowsight's Query History), or null if the answer carried none that looks like one.
// Every error leaves through here, so a thrown message (a fetch error quoting the header) never carries the PAT.
async function execute(statement, binds, opts) {
  const c = ctx(opts);
  const pat = patOf(c.env);
  try {
    return await run(c, statement, binds, pat);
  } catch (err) {
    const msg = String(err?.message ?? err);
    throw pat && msg.includes(pat) ? new Error(redact(msg, pat)) : err;
  }
}

async function run(c, statement, binds, pat) {
  if (!configured(c.env)) throw new Error('snowflake: not configured');
  const e = c.env;
  const body = {
    statement,
    timeout: 30,
    warehouse: ident(e.SNOWFLAKE_WAREHOUSE),
    database: ident(e.SNOWFLAKE_DATABASE),
    schema: ident(e.SNOWFLAKE_SCHEMA),
    // unverified: what this API does with a PAT and a role other than its ROLE_RESTRICTION; the README says keep them equal.
    ...(String(e.SNOWFLAKE_ROLE ?? '').trim() ? { role: ident(e.SNOWFLAKE_ROLE) } : {}),
    ...(binds.length ? { bindings: bindings(binds) } : {}),
  };
  const reads = READS.test(statement);
  let r = await call(c, 'POST', reads ? '/api/v2/statements' : '/api/v2/statements?async=true', body);
  const handle = HANDLE.test(String(r.json?.statementHandle ?? '')) ? r.json.statementHandle : null;
  if (r.status === 202 && !reads) return { rows: [], accepted: true, handle };
  for (const wait of POLL_MS) {
    if (!(r.status === 202 || r.status === 429) || !handle) break;
    await c.sleep(wait);
    r = await call(c, 'GET', `/api/v2/statements/${handle}`);
  }
  if (r.status !== 200) throw failure(r, pat);
  return { rows: rowsOf(r.json), accepted: false, handle: null };
}

// Runs one statement and resolves to its rows ([] for a write accepted as 202).
export async function sql(statement, binds = [], opts = {}) {
  return (await execute(statement, binds, opts)).rows;
}

const text = (v, max) => (v == null ? '' : String(v).slice(0, max));

export async function saveProject(p, opts = {}) {
  if (!configured(ctx(opts).env)) return false;
  try {
    if (!p || !ID.test(String(p.id ?? '')) || !p.scene || typeof p.scene !== 'object') throw new Error('snowflake: bad project');
    const { accepted, handle } = await execute(INSERT, [
      p.id, text(p.name, 200), text(p.source, 16), text(p.image_url, 2048), text(p.scene_url, 2048),
      JSON.stringify(p.scene), text(p.title_guess, 200), text(p.artist_guess, 200), text(p.credit, 400),
    ], opts);
    // The insert finishes after this returns; its handle is the Query ID to look up in Query History if it then fails.
    if (accepted) console.log(`snowflake save: ${p.id} accepted, statementHandle ${handle ?? '(none)'}`);
    return true;
  } catch (err) {
    console.warn('snowflake save:', err.message);
    return false;
  }
}

// { ok, rows }: ok is false when Snowflake is not configured or did not answer, true for any answer, empty or not.
export async function listProjectsResult(limit = 24, opts = {}) {
  if (!configured(ctx(opts).env)) return { ok: false, rows: [] };
  try {
    // Clamped integer, so inlining it is safe and does not depend on LIMIT accepting a bind variable.
    const n = Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 24));
    const rows = await sql(`SELECT ${LIST_COLS} FROM PROJECTS ORDER BY CREATED_AT DESC LIMIT ${n}`, [], opts);
    return {
      ok: true,
      rows: rows.map((r) => ({
        id: r.id, name: r.name, source: r.source, image_url: r.image_url, scene_url: r.scene_url,
        title_guess: r.title_guess, artist_guess: r.artist_guess, created_at: toIso(r.created_at),
      })),
    };
  } catch (err) {
    console.warn('snowflake list:', err.message);
    return { ok: false, rows: [] };
  }
}

export async function listProjects(limit = 24, opts = {}) {
  return (await listProjectsResult(limit, opts)).rows;
}

// { ok, project }: ok false as above; { ok: true, project: null } is a real "not found" (or an id that cannot exist).
export async function getProjectResult(id, opts = {}) {
  if (!configured(ctx(opts).env)) return { ok: false, project: null };
  if (!ID.test(String(id ?? ''))) return { ok: true, project: null };
  try {
    const [r] = await sql(GET, [String(id)], opts);
    if (!r) return { ok: true, project: null };
    let scene = null;
    try { scene = r.scene == null ? null : JSON.parse(r.scene); } catch { console.warn('snowflake get: scene is not JSON for', r.id); }
    return {
      ok: true,
      project: {
        id: r.id, name: r.name, source: r.source, image_url: r.image_url, scene_url: r.scene_url,
        title_guess: r.title_guess, artist_guess: r.artist_guess, credit: r.credit || null,
        created_at: toIso(r.created_at), scene,
      },
    };
  } catch (err) {
    console.warn('snowflake get:', err.message);
    return { ok: false, project: null };
  }
}

export async function getProject(id, opts = {}) {
  return (await getProjectResult(id, opts)).project;
}

export const isProjectId = (id) => ID.test(String(id ?? ''));
