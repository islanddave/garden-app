// I34 / I35 (BUG-AUTHZLAMBDA-001) — a caller-named S3 key carries no owner, so the photos Lambda now
// refuses a key another household already registered: 403 on upload-url, thumb-upload-url and
// relay-upload (before any presign or PUT), 400 on POST /api/photos, which also accepts only the
// upload grammar or the caller's OWN inbox key (isAllowedStoragePath).
//
// Three layers, per this directory's convention:
//   1. the pure policy (isAllowedStoragePath) is executed for real;
//   2. foreignStorageKey and each signing route's block are EXTRACTED VERBATIM from index.js and
//      executed against fakes (index.js is not importable from the repo root — its @aws-sdk/@clerk/
//      @neondatabase imports are per-Lambda deps; household-mode.test.js autoPromoteFeatured pattern),
//      so "sql returns a foreign row -> 403 and nothing is signed or PUT" is behaviour, not text;
//   3. POST ordering and response bodies are pinned on decommented source.
// The real-Postgres arms are tests/integration/photos-authz.int.test.js.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedUploadKey, isAllowedStoragePath } from './uploadKeyPolicy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const SRC = decomment(RAW);

const ME = 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI';
const UUID = 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ID = '11111111-1111-4111-8111-111111111111';
const KEY = `plants/${ID}/${UUID}.jpg`;

// ── 1. policy ────────────────────────────────────────────────────────────────────────────────────
describe('isAllowedStoragePath — what POST /api/photos may register (I34a)', () => {
  it('accepts every caller-nameable upload key', () => {
    for (const k of [KEY, `standalone/${UUID}.webp`, `events/${ID}/${UUID}.png`]) {
      expect(isAllowedUploadKey(k)).toBe(true);
      expect(isAllowedStoragePath(k, ME), k).toBe(true);
    }
  });
  it('accepts the caller OWN inbox key in the exact /batch shape', () => {
    expect(isAllowedStoragePath(`inbox/${ME}/${UUID}.jpg`, ME)).toBe(true);
    expect(isAllowedStoragePath(`inbox/${ME}/meta-int-test-1-abcde.heic`, ME)).toBe(true);
  });
  const rejected = [
    ['traversal out of the inbox', `inbox/${ME}/../../plants/${ID}/${UUID}.jpg`],
    ['nested tail', `inbox/${ME}/x/y/${UUID}.jpg`],
    ['empty tail', `inbox/${ME}/`],
    ['another user sub', `inbox/user_someoneelse/${UUID}.jpg`],
    ['prefix collision on the sub', `inbox/${ME}x/${UUID}.jpg`],
    ['thumbs/ of an own key', `thumbs/${KEY}`],
    ['thumbs/ of an own inbox key', `thumbs/inbox/${ME}/${UUID}.jpg`],
    ['uppercase ext', `inbox/${ME}/${UUID}.JPG`],
    ['multi-extension', `inbox/${ME}/${UUID}.php.jpg`],
    ['dot-segment file', `inbox/${ME}/..jpg`],
    ['no extension', `inbox/${ME}/${UUID}`],
    ['foreign prefix', `spaces/run/${UUID}.jpg`],
  ];
  for (const [why, sp] of rejected) {
    it(`rejects: ${why}`, () => expect(isAllowedStoragePath(sp, ME)).toBe(false));
  }
  it('rejects a non-string path or a missing / unsafe sub', () => {
    expect(isAllowedStoragePath(null, ME)).toBe(false);
    expect(isAllowedStoragePath(42, ME)).toBe(false);
    expect(isAllowedStoragePath(`inbox//${UUID}.jpg`, '')).toBe(false);
    expect(isAllowedStoragePath(`inbox/a b/${UUID}.jpg`, 'a b')).toBe(false);
    expect(isAllowedStoragePath(`inbox/undefined/${UUID}.jpg`, undefined)).toBe(false);
  });
});

// ── 2. executed extraction ───────────────────────────────────────────────────────────────────────
function balancedFrom(src, start) {
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
const AsyncFunction = (async () => {}).constructor;
const constant = (name) => {
  const m = RAW.match(new RegExp(`const ${name} = ([^;]+);`));
  if (!m) throw new Error(`constant not found: ${name}`);
  return new Function(`return (${m[1]});`)();
};

const probeSrc = balancedFrom(RAW, RAW.indexOf('async function foreignStorageKey'));
const foreignStorageKey = new AsyncFunction('sql', 'key', 'householdIds',
  probeSrc.slice(probeSrc.indexOf('{') + 1, -1));

// A recording fake of the Neon tagged template. `probeRows` is what the probe SELECT returns.
function makeSql(probeRows) {
  const calls = [];
  const sql = (strings, ...values) => {
    calls.push({ text: strings.join('¶'), values });
    return Promise.resolve(probeRows);
  };
  sql.calls = calls;
  return sql;
}

describe('foreignStorageKey — the probe itself (I34b / I35)', () => {
  it('extracted', () => expect(probeSrc).toMatch(/SELECT 1 FROM photos WHERE storage_path = /));
  it('a foreign row -> true; none -> false', async () => {
    expect(await foreignStorageKey(makeSql([{ '?column?': 1 }]), KEY, ['a'])).toBe(true);
    expect(await foreignStorageKey(makeSql([]), KEY, ['a'])).toBe(false);
  });
  it('binds the key and the household ids, negates the household, no deleted_at', async () => {
    const sql = makeSql([]);
    await foreignStorageKey(sql, KEY, ['user_a', 'user_b']);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].values).toEqual([KEY, ['user_a', 'user_b']]);
    expect(sql.calls[0].text).toMatch(/AND NOT \(created_by = ANY\(¶\)\) LIMIT 1/);
    expect(sql.calls[0].text).not.toMatch(/deleted_at/);
  });
  it('does not swallow a DB error (fails closed through the outer catch)', async () => {
    const sql = () => Promise.reject(new Error('db down'));
    await expect(foreignStorageKey(sql, KEY, ['a'])).rejects.toThrow('db down');
  });
});

// Runs one route's `if (rawPath === …) { … }` block verbatim with fakes for everything it closes over.
function routeRunner(marker) {
  const start = RAW.indexOf(`if (rawPath === '${marker}'`);
  if (start === -1) throw new Error(`route not found: ${marker}`);
  const block = balancedFrom(RAW, start);
  const names = ['rawPath', 'method', 'event', 'sql', 'householdIds', 'userId', 'isAllowedUploadKey',
    'SAFE_CONTENT_TYPE', 'RELAY_MAX_B64_CHARS', 'RELAY_THUMB_MAX_B64_CHARS', 'resp', 'warnRejectedFk',
    'foreignStorageKey', 'PutObjectCommand', 'BUCKET', 'getSignedUrl', 's3'];
  const fn = new AsyncFunction(...names, `${block}\nreturn undefined;`);
  return async ({ method, event, probeRows }) => {
    const deps = {
      rawPath: marker, method, event,
      sql: makeSql(probeRows), householdIds: [ME], userId: ME, isAllowedUploadKey,
      SAFE_CONTENT_TYPE: constant('SAFE_CONTENT_TYPE'),
      RELAY_MAX_B64_CHARS: constant('RELAY_MAX_B64_CHARS'),
      RELAY_THUMB_MAX_B64_CHARS: constant('RELAY_THUMB_MAX_B64_CHARS'),
      resp: (statusCode, body) => ({ statusCode, body }),
      warnRejectedFk: vi.fn(), foreignStorageKey,
      PutObjectCommand: class { constructor(input) { this.input = input; } },
      BUCKET: 'bucket',
      getSignedUrl: vi.fn(async () => 'https://signed.example/put'),
      s3: { send: vi.fn(async () => ({})) },
    };
    const res = await fn(...names.map((n) => deps[n]));
    return { res, deps };
  };
}

const ROUTES = [
  {
    name: 'upload-url', marker: '/api/photos/upload-url', method: 'GET',
    event: { queryStringParameters: { key: KEY, content_type: 'image/jpeg' } },
    effect: (d) => d.getSignedUrl,
  },
  {
    name: 'thumb-upload-url', marker: '/api/photos/thumb-upload-url', method: 'GET',
    event: { queryStringParameters: { key: KEY } },
    effect: (d) => d.getSignedUrl,
  },
  {
    name: 'relay-upload', marker: '/api/photos/relay-upload', method: 'POST',
    event: { body: JSON.stringify({ key: KEY, data_b64: Buffer.from('jpegbytes').toString('base64') }) },
    effect: (d) => d.s3.send,
  },
];

for (const r of ROUTES) {
  describe(`${r.name} — foreign-registered key is refused before signing / PUT (I35)`, () => {
    const run = routeRunner(r.marker);
    // MUTATION: delete the probe block from this route -> the first `it` goes RED.
    it('sql returns a foreign row -> 403 Forbidden, logged, nothing signed or PUT', async () => {
      const { res, deps } = await run({ method: r.method, event: r.event, probeRows: [{ x: 1 }] });
      expect(res).toEqual({ statusCode: 403, body: { error: 'Forbidden' } });
      expect(r.effect(deps)).not.toHaveBeenCalled();
      expect(deps.warnRejectedFk).toHaveBeenCalledWith(ME, 'photos', 'storage_path', KEY);
    });
    // The control: an over-blocking probe (inverted, or 403 on every key) fails here.
    it('no foreign row -> reaches the presign / PUT and answers 200', async () => {
      const { res, deps } = await run({ method: r.method, event: r.event, probeRows: [] });
      expect(res.statusCode).toBe(200);
      expect(r.effect(deps)).toHaveBeenCalled();
      expect(deps.warnRejectedFk).not.toHaveBeenCalled();
    });
    it('a grammar reject still 403s without spending the probe', async () => {
      const bad = r.method === 'GET'
        ? { queryStringParameters: { key: `thumbs/${KEY}` } }
        : { body: JSON.stringify({ key: `thumbs/${KEY}`, data_b64: 'eA==' }) };
      const { res, deps } = await run({ method: r.method, event: bad, probeRows: [] });
      expect(res.statusCode).toBe(403);
      expect(deps.sql.calls).toHaveLength(0);
    });
  });
}

// ── 3. POST /api/photos ordering + bodies ───────────────────────────────────────────────────────
describe('POST /api/photos — storage_path gate (I34)', () => {
  const i = SRC.indexOf("rawPath === '/api/photos' && method === 'POST'");
  const post = SRC.slice(i, SRC.indexOf('buildPhotoInsert(', i));
  const BODY = "resp(400, { error: 'storage_path is not a valid upload key' })";
  it('the window is real', () => {
    expect(i).toBeGreaterThan(-1);
    expect(post).toMatch(/storage_path is required/);
  });
  // MUTATION: delete the isAllowedStoragePath gate -> RED.
  it('grammar / own-inbox gate -> the generic 400', () => {
    expect(post).toMatch(/if \(!isAllowedStoragePath\(body\.storage_path, userId\)\) \{\s*return resp\(400, \{ error: 'storage_path is not a valid upload key' \}\);/);
  });
  // MUTATION: delete the foreignStorageKey gate -> RED.
  it('foreign-row probe -> logged, then the SAME 400 body (no second oracle)', () => {
    expect(post).toMatch(/if \(await foreignStorageKey\(sql, body\.storage_path, householdIds\)\) \{\s*warnRejectedFk\(userId, 'photos', 'storage_path', body\.storage_path\);\s*return resp\(400, \{ error: 'storage_path is not a valid upload key' \}\);/);
    expect(post.split(BODY).length - 1).toBe(2);
  });
  it('both gates run before the INSERT is built', () => {
    expect(post.indexOf('isAllowedStoragePath(')).toBeGreaterThan(post.indexOf('storage_path is required'));
    expect(post.indexOf('foreignStorageKey(')).toBeGreaterThan(post.indexOf('isAllowedStoragePath('));
  });
  it('imports the policy from the per-dir module', () => {
    expect(SRC).toMatch(/import \{ isAllowedStoragePath \} from '\.\/uploadKeyPolicy\.js';/);
  });
});
