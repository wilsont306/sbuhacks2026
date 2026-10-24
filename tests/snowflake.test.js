// Tests for lib/snowflake.js and api/projects.js with an injected fetch and a key pair made here; no network.
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  configured, jwtAccount, accountHost, pemOf, fingerprint, mintJwt, bindings, rowsOf, toIso,
  sql, saveProject, listProjects, getProject, listProjectsResult, getProjectResult, isProjectId,
} from '../lib/snowflake.js';
import defaultHandler, { createHandler } from '../api/projects.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const keyBody = privateKey.split('\n').filter((l) => l && !l.startsWith('-----')).join('');
const ENV = {
  SNOWFLAKE_ACCOUNT: 'myorg-myacct', SNOWFLAKE_USER: 'lb_service', SNOWFLAKE_PRIVATE_KEY: privateKey,
  SNOWFLAKE_WAREHOUSE: 'lb_wh', SNOWFLAKE_DATABASE: 'lb_db', SNOWFLAKE_SCHEMA: 'app', SNOWFLAKE_ROLE: 'lb_app',
};
const ID = '0b6f6c1e-1d7a-4c55-9f0e-5a8c3d2b1a00';
const SCENE = { id: ID, source: 'drop', objects: [{ label: 'sun', kind: 'celestial', mask: [[1, 2], [3, 4], [5, 6]] }], palette: ['#112233'] };

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

// A fetch that answers from a queue of {status, json} and records every call.
function fakeFetch(...answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    if (a instanceof Error) throw a;
    return { status: a.status, json: async () => { if (a.json === undefined) throw new SyntaxError('no body'); return a.json; } };
  };
  fn.calls = calls;
  return fn;
}
const result = (cols, data) => ({ status: 200, json: { code: '090001', resultSetMetaData: { numRows: data.length, rowType: cols.map((name) => ({ name })) }, data } });
const pending = (handle = '01b2c3d4-0000-1111-2222-333344445555') => ({ status: 202, json: { code: '333334', statementHandle: handle, statementStatusUrl: `/api/v2/statements/${handle}` } });
const quiet = (t) => t.mock.method(console, 'warn', () => {});
const logs = (t) => t.mock.method(console, 'log', () => {});
const BASE = 'https://myorg-myacct.snowflakecomputing.com/api/v2/statements';
const opts = (fetch, extra = {}) => ({ fetch, env: ENV, sleep: async () => {}, ...extra });

describe('jwt', () => {
  it('signs RS256 with the right header and claims, verifiable by the public key', () => {
    const now = Date.UTC(2026, 9, 24, 12, 0, 0);
    const jwt = mintJwt({ account: 'myorg-myacct', user: 'lb_service', privateKeyPem: privateKey, now });
    const [h, c, s] = jwt.split('.');
    assert.deepEqual(decode(h), { alg: 'RS256', typ: 'JWT' });
    const claims = decode(c);
    const fp = 'SHA256:' + crypto.createHash('sha256').update(crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' })).digest('base64');
    assert.equal(claims.iss, `MYORG-MYACCT.LB_SERVICE.${fp}`);
    assert.equal(claims.sub, 'MYORG-MYACCT.LB_SERVICE');
    assert.equal(claims.iat, now / 1000);
    assert.equal(claims.exp - claims.iat, 600);
    assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')));
  });

  it('fingerprint is SHA256: + base64 sha256 of the SPKI DER', () => {
    const der = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
    const want = 'SHA256:' + crypto.createHash('sha256').update(der).digest('base64');
    assert.equal(fingerprint(privateKey), want);
    assert.equal(fingerprint(publicKey), want);
  });

  it('normalises account identifiers', () => {
    assert.equal(jwtAccount('myorg-myacct'), 'MYORG-MYACCT');
    assert.equal(jwtAccount('MyOrg-MyAcct'), 'MYORG-MYACCT');
    assert.equal(jwtAccount('myorg.myacct'), 'MYORG-MYACCT');
    assert.equal(jwtAccount('xy12345.us-east-1'), 'XY12345');
    assert.equal(jwtAccount('xy12345.us-east-2.aws'), 'XY12345');
    assert.equal(jwtAccount('xy12345.east-us-2.azure'), 'XY12345');
    assert.equal(jwtAccount(' https://myorg-myacct.snowflakecomputing.com/ '), 'MYORG-MYACCT');
    assert.equal(jwtAccount('myorg-my_acct'), 'MYORG-MY_ACCT');
    assert.equal(accountHost('MyOrg-MyAcct'), 'myorg-myacct');
    assert.equal(accountHost('myorg.myacct'), 'myorg-myacct');
    assert.equal(accountHost('xy12345.us-east-2.aws'), 'xy12345.us-east-2.aws');
    assert.equal(accountHost('myorg-my_acct'), 'myorg-my-acct');
    assert.equal(accountHost('evil.com/x?'), 'evil-com'); // always a label under .snowflakecomputing.com
    assert.throws(() => accountHost('bad acct@x'), /SNOWFLAKE_ACCOUNT/);
    assert.throws(() => accountHost(''), /SNOWFLAKE_ACCOUNT/);
  });

  it('accepts the key with literal \\n, spaces for newlines, quotes, or no header', () => {
    const want = fingerprint(privateKey);
    for (const raw of [privateKey.replace(/\n/g, '\\n'), privateKey.replace(/\n/g, ' '), `"${privateKey.trim()}"`, keyBody]) {
      assert.equal(fingerprint(crypto.createPrivateKey(pemOf(raw))), want);
    }
  });
});

describe('sql', () => {
  it('posts the statement with key-pair headers, env context and string bindings', async () => {
    const f = fakeFetch(result(['N'], [['1']]));
    const rows = await sql('SELECT ? AS N, ?', ['1', 7, null], opts(f));
    assert.deepEqual(rows, [{ n: '1' }]);
    const [{ url, init, body }] = f.calls;
    assert.equal(url, 'https://myorg-myacct.snowflakecomputing.com/api/v2/statements');
    assert.equal(init.method, 'POST');
    assert.match(init.headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal(init.headers['X-Snowflake-Authorization-Token-Type'], 'KEYPAIR_JWT');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers.Accept, 'application/json');
    assert.ok(init.headers['User-Agent']);
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(body.statement, 'SELECT ? AS N, ?');
    assert.equal(typeof body.timeout, 'number');
    assert.deepEqual([body.warehouse, body.database, body.schema, body.role], ['LB_WH', 'LB_DB', 'APP', 'LB_APP']);
    assert.deepEqual(body.bindings, { 1: { type: 'TEXT', value: '1' }, 2: { type: 'FIXED', value: '7' }, 3: { type: 'TEXT', value: '' } });
    for (const b of Object.values(body.bindings)) assert.equal(typeof b.value, 'string');
  });

  it('mints a fresh JWT per request', async () => {
    let t = Date.UTC(2026, 9, 24);
    const f = fakeFetch(pending(), result(['N'], [['1']]));
    await sql('SELECT 1', [], opts(f, { now: () => (t += 5000) }));
    const iat = f.calls.map((c) => decode(c.init.headers.Authorization.split(' ')[1].split('.')[1]).iat);
    assert.equal(iat.length, 2);
    assert.notEqual(iat[0], iat[1]);
  });

  it('omits role and bindings when there are none', async () => {
    const f = fakeFetch(result(['N'], [['1']]));
    const { SNOWFLAKE_ROLE, ...env } = ENV;
    await sql('SELECT 1', [], { fetch: f, env });
    assert.equal('role' in f.calls[0].body, false);
    assert.equal('bindings' in f.calls[0].body, false);
  });

  it('throws a message without the token on an error status', async (t) => {
    const f = fakeFetch({ status: 401, json: { code: '390144', message: 'JWT token is invalid.' } });
    await assert.rejects(sql('SELECT 1', [], opts(f)), (err) => {
      assert.match(err.message, /401 390144 JWT token is invalid/);
      assert.ok(!err.message.includes(f.calls[0].init.headers.Authorization.slice(7)));
      return true;
    });
  });

  it('polls a 202 SELECT by handle until it is ready', async () => {
    const slept = [];
    const f = fakeFetch(pending(), pending(), result(['ID'], [['a']]));
    const rows = await sql('SELECT ID FROM PROJECTS', [], opts(f, { sleep: async (ms) => { slept.push(ms); } }));
    assert.deepEqual(rows, [{ id: 'a' }]);
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[1].init.method, 'GET');
    assert.equal(f.calls[1].url, 'https://myorg-myacct.snowflakecomputing.com/api/v2/statements/01b2c3d4-0000-1111-2222-333344445555');
    assert.equal(slept.length, 2);
    assert.ok(slept[1] >= slept[0]);
  });

  it('gives up on a SELECT still running after a few polls', async () => {
    const f = fakeFetch(pending());
    await assert.rejects(sql('SELECT 1', [], opts(f)), /HTTP 202/);
    assert.ok(f.calls.length > 2 && f.calls.length <= 6);
  });

  it('accepts a 202 INSERT without polling', async () => {
    const f = fakeFetch(pending());
    assert.deepEqual(await sql('INSERT INTO PROJECTS (ID) SELECT ?', ['x'], opts(f)), []);
    assert.equal(f.calls.length, 1);
  });

  it('sends writes with ?async=true and keeps reads synchronous', async () => {
    const f = fakeFetch(pending(), result(['N'], [['1']]), result(['N'], [['1']]));
    await sql('INSERT INTO PROJECTS (ID) SELECT ?', ['x'], opts(f));
    await sql('SELECT 1', [], opts(f));
    await sql('  with t as (select 1) select * from t', [], opts(f));
    assert.deepEqual(f.calls.map((c) => [c.init.method, c.url]), [['POST', `${BASE}?async=true`], ['POST', BASE], ['POST', BASE]]);
    assert.equal(f.calls[0].body.statement, 'INSERT INTO PROJECTS (ID) SELECT ?');
  });

  it('still throws when an async write is refused', async () => {
    const f = fakeFetch({ status: 422, json: { code: '002003', message: 'Table does not exist' } });
    await assert.rejects(sql('INSERT INTO PROJECTS (ID) SELECT ?', ['x'], opts(f)), /HTTP 422 002003/);
    assert.equal(f.calls.length, 1);
  });

  it('refuses to run unconfigured', async () => {
    await assert.rejects(sql('SELECT 1', [], { fetch: fakeFetch(result([], [])), env: {} }), /not configured/);
  });
});

describe('helpers', () => {
  it('configured needs every required var; role is optional', () => {
    assert.equal(configured(ENV), true);
    const { SNOWFLAKE_ROLE, ...noRole } = ENV;
    assert.equal(configured(noRole), true);
    assert.equal(configured({ ...ENV, SNOWFLAKE_PRIVATE_KEY: ' ' }), false);
    assert.equal(configured({}), false);
  });

  it('maps rows by rowType names and converts epoch timestamps', () => {
    assert.deepEqual(rowsOf({ resultSetMetaData: { rowType: [{ name: 'ID' }, { name: 'NAME' }] }, data: [['a', null]] }), [{ id: 'a', name: null }]);
    assert.deepEqual(rowsOf({}), []);
    assert.equal(toIso('1729771200.000000000'), '2024-10-24T12:00:00.000Z');
    assert.equal(toIso('1729771200.500000000 1440'), '2024-10-24T12:00:00.500Z');
    assert.equal(toIso('2026-10-24T09:00:00Z'), '2026-10-24T09:00:00Z');
    assert.equal(toIso(null), null);
  });

  it('bindings are 1-based and always strings', () => {
    assert.deepEqual(bindings(['a', 2, undefined]), { 1: { type: 'TEXT', value: 'a' }, 2: { type: 'FIXED', value: '2' }, 3: { type: 'TEXT', value: '' } });
  });

  it('project ids: uuids and slugs only', () => {
    assert.ok(isProjectId(ID));
    assert.ok(isProjectId('sample-starry-night'));
    for (const bad of ['', "x' OR 1=1", 'a/b', 'x'.repeat(65), null, '-lead']) assert.equal(isProjectId(bad), false);
  });
});

describe('saveProject', () => {
  const project = { id: ID, name: 'Starry Night', source: 'drop', image_url: 'https://blob/x.jpg', scene_url: 'https://blob/x.json', scene: SCENE, title_guess: 'The Starry Night', artist_guess: 'Vincent van Gogh', credit: null };

  it('inserts with SELECT ... PARSE_JSON(?) and string bindings', async () => {
    const f = fakeFetch(result(['number of rows inserted'], [['1']]));
    assert.equal(await saveProject(project, opts(f)), true);
    const { statement, bindings: b } = f.calls[0].body;
    assert.match(statement, /^INSERT INTO PROJECTS \(ID, NAME, SOURCE, IMAGE_URL, SCENE_URL, SCENE, TITLE_GUESS, ARTIST_GUESS, CREDIT\)\s+SELECT /);
    assert.match(statement, /PARSE_JSON\(\?\)/);
    assert.doesNotMatch(statement, /VALUES/i);
    assert.equal((statement.match(/\?/g) || []).length, 9);
    const values = Object.keys(b).sort((x, y) => x - y).map((k) => b[k].value);
    assert.deepEqual(values, [ID, 'Starry Night', 'drop', 'https://blob/x.jpg', 'https://blob/x.json', JSON.stringify(SCENE), 'The Starry Night', 'Vincent van Gogh', '']);
    for (const v of Object.values(b)) assert.equal(v.type, 'TEXT');
  });

  it('posts the insert with ?async=true, counts the 202 as accepted and logs its statementHandle, not the JWT', async (t) => {
    const log = logs(t);
    const handle = '01b7a0c2-0306-4d1e-0000-000a1b2c3d4e';
    const f = fakeFetch(pending(handle));
    assert.equal(await saveProject(project, opts(f)), true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, `${BASE}?async=true`);
    assert.equal(f.calls[0].init.method, 'POST');
    assert.equal(log.mock.calls.length, 1);
    const line = log.mock.calls[0].arguments.join(' ');
    assert.ok(line.includes(handle), line);
    assert.ok(line.includes(ID), line);
    const jwt = f.calls[0].init.headers.Authorization.slice('Bearer '.length);
    for (const part of jwt.split('.')) assert.ok(!line.includes(part), 'the log line carries part of the JWT');
    assert.ok(!line.includes(keyBody.slice(0, 40)));
  });

  it('a 202 without a usable handle is still accepted; the log says so', async (t) => {
    const log = logs(t);
    const f = fakeFetch({ status: 202, json: { code: '333334', statementHandle: 'not a handle/../x' } });
    assert.equal(await saveProject(project, opts(f)), true);
    const line = log.mock.calls[0].arguments.join(' ');
    assert.match(line, /statementHandle \(none\)/);
    assert.ok(!line.includes('not a handle'));
  });

  it('a 200 answer (finished at once) is saved without an accepted log line', async (t) => {
    const log = logs(t);
    assert.equal(await saveProject(project, opts(fakeFetch(result(['number of rows inserted'], [['1']])))), true);
    assert.equal(log.mock.calls.length, 0);
  });

  it('returns false without throwing on errors, bad input or no config', async (t) => {
    const warn = quiet(t);
    assert.equal(await saveProject(project, opts(fakeFetch(new TypeError('fetch failed')))), false);
    assert.equal(await saveProject(project, opts(fakeFetch({ status: 500, json: undefined }))), false);
    assert.equal(await saveProject(project, { ...opts(fakeFetch(result([], []))), env: { ...ENV, SNOWFLAKE_PRIVATE_KEY: 'not a key' } }), false);
    const none = fakeFetch(result([], []));
    assert.equal(await saveProject({ ...project, id: "x'; DROP TABLE PROJECTS; --" }, opts(none)), false);
    assert.equal(await saveProject({ ...project, scene: 'nope' }, opts(none)), false);
    assert.equal(await saveProject(null, opts(none)), false);
    assert.equal(await saveProject(project, { fetch: none, env: {} }), false);
    assert.equal(none.calls.length, 0);
    for (const call of warn.mock.calls) assert.ok(!String(call.arguments.join(' ')).includes(keyBody.slice(0, 40)));
  });
});

describe('listProjects and getProject', () => {
  const cols = ['ID', 'NAME', 'SOURCE', 'IMAGE_URL', 'SCENE_URL', 'TITLE_GUESS', 'ARTIST_GUESS', 'CREATED_AT'];

  it('lists newest first with a clamped limit, polling a 202', async () => {
    const f = fakeFetch(pending(), result(cols, [[ID, 'Starry', 'drop', 'i', 's', 't', 'a', '1729771200.000000000']]));
    const list = await listProjects(24, opts(f));
    assert.deepEqual(list, [{ id: ID, name: 'Starry', source: 'drop', image_url: 'i', scene_url: 's', title_guess: 't', artist_guess: 'a', created_at: '2024-10-24T12:00:00.000Z' }]);
    assert.match(f.calls[0].body.statement, /FROM PROJECTS ORDER BY CREATED_AT DESC LIMIT 24$/);
    assert.equal(f.calls[0].url, BASE); // a SELECT is never sent async
    assert.equal(f.calls[1].init.method, 'GET');
    const g = fakeFetch(result(cols, []));
    await listProjects('9999; DROP', opts(g));
    assert.match(g.calls[0].body.statement, /LIMIT 24$/);
    await listProjects(5000, opts(g));
    assert.match(g.calls[1].body.statement, /LIMIT 100$/);
  });

  it('gets one by bound id with the scene parsed', async () => {
    const f = fakeFetch(result(['ID', 'NAME', 'SOURCE', 'IMAGE_URL', 'SCENE_URL', 'SCENE', 'TITLE_GUESS', 'ARTIST_GUESS', 'CREDIT', 'CREATED_AT'],
      [[ID, 'Starry', 'drop', 'i', 's', JSON.stringify(SCENE, null, 2), 't', 'a', null, '1729771200.000000000']]));
    const p = await getProject(ID, opts(f));
    assert.deepEqual(p.scene, SCENE);
    assert.equal(p.credit, null);
    assert.equal(p.created_at, '2024-10-24T12:00:00.000Z');
    assert.match(f.calls[0].body.statement, /WHERE ID = \? LIMIT 1$/);
    assert.deepEqual(f.calls[0].body.bindings, { 1: { type: 'TEXT', value: ID } });
  });

  it('returns null when missing, malformed or failing; [] when the list fails', async (t) => {
    quiet(t);
    assert.equal(await getProject(ID, opts(fakeFetch(result(['ID'], [])))), null);
    const none = fakeFetch(result([], []));
    assert.equal(await getProject('../etc', opts(none)), null);
    assert.equal(none.calls.length, 0);
    assert.equal(await getProject(ID, opts(fakeFetch(new Error('network down')))), null);
    assert.equal(await getProject(ID, opts(fakeFetch({ status: 422, json: { code: '002003', message: 'Object does not exist' } }))), null);
    assert.deepEqual(await listProjects(24, opts(fakeFetch(new Error('network down')))), []);
    assert.deepEqual(await listProjects(24, opts(fakeFetch({ status: 503, json: undefined }))), []);
    assert.deepEqual(await listProjects(24, { fetch: none, env: {} }), []);
    assert.equal(await getProject(ID, { fetch: none, env: {} }), null);
    assert.equal(none.calls.length, 0);
  });

  it('the Result forms tell an empty answer from a failed call, without throwing', async (t) => {
    quiet(t);
    assert.deepEqual(await listProjectsResult(24, opts(fakeFetch(result(cols, [])))), { ok: true, rows: [] });
    const one = await listProjectsResult(24, opts(fakeFetch(result(cols, [[ID, 'Starry', 'drop', 'i', 's', 't', 'a', null]]))));
    assert.equal(one.ok, true);
    assert.equal(one.rows[0].id, ID);
    for (const answer of [new TypeError('fetch failed'), { status: 503, json: undefined }, { status: 401, json: { code: '390144' } }, pending()]) {
      assert.deepEqual(await listProjectsResult(24, opts(fakeFetch(answer))), { ok: false, rows: [] });
      assert.deepEqual(await getProjectResult(ID, opts(fakeFetch(answer))), { ok: false, project: null });
    }
    assert.deepEqual(await getProjectResult(ID, opts(fakeFetch(result(['ID'], [])))), { ok: true, project: null });
    const none = fakeFetch(result([], []));
    assert.deepEqual(await getProjectResult('../etc', opts(none)), { ok: true, project: null });
    assert.deepEqual(await listProjectsResult(24, { fetch: none, env: {} }), { ok: false, rows: [] });
    assert.deepEqual(await getProjectResult(ID, { fetch: none, env: {} }), { ok: false, project: null });
    assert.equal(none.calls.length, 0);
    const got = await getProjectResult(ID, opts(fakeFetch(result(['ID', 'SCENE'], [[ID, JSON.stringify(SCENE)]]))));
    assert.equal(got.ok, true);
    assert.deepEqual(got.project.scene, SCENE);
  });
});

describe('api/projects', () => {
  const run = (handler, method, url) => new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {}, headersSent: false,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(b) { this.headersSent = true; resolve({ status: this.statusCode, headers: this.headers, body: JSON.parse(b) }); },
    };
    handler({ method, url, headers: {} }, res);
  });
  const store = (over = {}) => ({
    configured: () => true, isProjectId,
    listProjectsResult: async () => ({ ok: true, rows: [{ id: ID, name: 'Starry' }] }),
    getProjectResult: async (id) => ({ ok: true, project: id === ID ? { id: ID, scene: SCENE } : null }),
    ...over,
  });
  // The real lib functions over a fake fetch, as the handler would call them.
  const realStore = (fetch) => ({
    configured: () => true, isProjectId,
    listProjectsResult: (n) => listProjectsResult(n, opts(fetch)),
    getProjectResult: (id) => getProjectResult(id, opts(fetch)),
  });

  it('GET lists projects, uncached', async () => {
    const r = await run(createHandler(store()), 'GET', '/api/projects');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, projects: [{ id: ID, name: 'Starry' }], configured: true });
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(r.headers['content-type'], /application\/json/);
  });

  it('GET ?id= returns the project, 404 when missing, 400 when malformed', async () => {
    const h = createHandler(store());
    assert.deepEqual((await run(h, 'GET', `/api/projects?id=${ID}`)).body, { ok: true, project: { id: ID, scene: SCENE } });
    const miss = await run(h, 'GET', '/api/projects?id=0b6f6c1e-1d7a-4c55-9f0e-000000000000');
    assert.deepEqual([miss.status, miss.body], [404, { ok: false }]);
    const bad = await run(h, 'GET', `/api/projects?id=${encodeURIComponent("x' OR '1'='1")}`);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.ok, false);
  });

  it('other methods get 405', async () => {
    const r = await run(createHandler(store()), 'POST', '/api/projects');
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, 'GET');
    assert.equal(r.body.ok, false);
  });

  it('unconfigured: empty list, and 404 for an id', async () => {
    const h = createHandler(store({ configured: () => false }));
    assert.deepEqual((await run(h, 'GET', '/api/projects')).body, { ok: true, projects: [], configured: false });
    const one = await run(h, 'GET', `/api/projects?id=${ID}`);
    assert.deepEqual([one.status, one.body], [404, { ok: false, configured: false }]);
  });

  it('configured but empty is ok:true with no projects', async () => {
    const r = await run(createHandler(store({ listProjectsResult: async () => ({ ok: true, rows: [] }) })), 'GET', '/api/projects');
    assert.deepEqual([r.status, r.body], [200, { ok: true, projects: [], configured: true }]);
  });

  it('configured but unreachable: the list answers 200 ok:false unavailable, an id answers 503', async () => {
    const h = createHandler(store({
      listProjectsResult: async () => ({ ok: false, rows: [] }),
      getProjectResult: async () => ({ ok: false, project: null }),
    }));
    const list = await run(h, 'GET', '/api/projects');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body, { ok: false, configured: true, error: 'unavailable', projects: [] });
    assert.equal(list.headers['cache-control'], 'no-store');
    const one = await run(h, 'GET', `/api/projects?id=${ID}`);
    assert.equal(one.status, 503);
    assert.deepEqual(one.body, { ok: false, configured: true, error: 'unavailable' });
  });

  it('end to end over the real lib: Snowflake down vs empty vs not found', async (t) => {
    quiet(t);
    const down = createHandler(realStore(fakeFetch(new TypeError('fetch failed'))));
    assert.deepEqual((await run(down, 'GET', '/api/projects')).body, { ok: false, configured: true, error: 'unavailable', projects: [] });
    assert.equal((await run(down, 'GET', `/api/projects?id=${ID}`)).status, 503);
    const empty = createHandler(realStore(fakeFetch(result(['ID'], []))));
    assert.deepEqual((await run(empty, 'GET', '/api/projects')).body, { ok: true, projects: [], configured: true });
    const miss = await run(empty, 'GET', `/api/projects?id=${ID}`);
    assert.deepEqual([miss.status, miss.body], [404, { ok: false }]);
  });

  it('a throwing store answers JSON without a stack', async (t) => {
    quiet(t);
    const r = await run(createHandler(store({ listProjectsResult: async () => { throw new Error('boom'); } })), 'GET', '/api/projects');
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { ok: false, error: 'unavailable' });
  });

  it('the default export reads the real env', async () => {
    const saved = {};
    for (const k of Object.keys(ENV)) { saved[k] = process.env[k]; delete process.env[k]; }
    try {
      assert.deepEqual((await run(defaultHandler, 'GET', '/api/projects')).body, { ok: true, projects: [], configured: false });
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  });
});

describe('sql/projects.sql', () => {
  const file = readFileSync(new URL('../sql/projects.sql', import.meta.url), 'utf8');
  // Statements, commented or not: lines that start (after any "-- ") with an uppercase SQL keyword.
  const statements = file.split(/\r?\n/).map((l) => l.replace(/^--\s?/, '').trim())
    .filter((l) => /^(CREATE|GRANT|INSERT|SELECT|DELETE|UPDATE|USE|DESCRIBE|SHOW|ALTER|DROP)\b/.test(l));
  const TABLE_REF = /\b(?:TABLE|INTO|FROM|UPDATE)\s+(?:IF NOT EXISTS\s+)?([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)/g;
  const SCHEMA_REF = /\bSCHEMA\s+(?:IF NOT EXISTS\s+)?([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)/g;

  it('names every table and schema in full, so it runs in any worksheet context', () => {
    const tables = [];
    const schemas = [];
    for (const s of statements) {
      for (const m of s.matchAll(TABLE_REF)) tables.push([m[1], s]);
      for (const m of s.matchAll(SCHEMA_REF)) schemas.push([m[1], s]);
    }
    for (const [name, s] of tables) assert.match(name, /^LB_DB\.APP\.[A-Z_]+$/, `unqualified table in: ${s}`);
    for (const [name, s] of schemas) assert.match(name, /^LB_DB\.APP$/, `unqualified schema in: ${s}`);
    // Not vacuous: the CREATE, the direct GRANT, SHOW GRANTS and the INSERT / SELECT / DELETE checks were all seen.
    assert.ok(tables.length >= 6, `only ${tables.length} table references found`);
    assert.ok(schemas.length >= 3, `only ${schemas.length} schema references found`);
  });

  it('the one statement that runs as is creates LB_DB.APP.PROJECTS, and no USE is relied on', () => {
    const live = file.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('--'));
    assert.match(live[0], /^CREATE TABLE IF NOT EXISTS LB_DB\.APP\.PROJECTS \($/);
    assert.ok(!statements.some((s) => /^USE (SCHEMA|DATABASE)\b/.test(s)), 'a USE SCHEMA/DATABASE step crept back in');
    assert.match(file, /^-- GRANT SELECT, INSERT ON TABLE LB_DB\.APP\.PROJECTS TO ROLE LB_APP;$/m);
  });

  it('keeps the table the app writes in sync with the INSERT columns', () => {
    const cols = [...file.matchAll(/^ {2}([A-Z_]+) [A-Z_]+/gm)].map((m) => m[1]);
    for (const c of ['ID', 'NAME', 'SOURCE', 'IMAGE_URL', 'SCENE_URL', 'SCENE', 'TITLE_GUESS', 'ARTIST_GUESS', 'CREDIT', 'CREATED_AT']) {
      assert.ok(cols.includes(c), `PROJECTS is missing ${c}`);
    }
  });
});
