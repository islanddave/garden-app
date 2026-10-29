// new-file: new subject, lambda/rate-limit.js
// SEC-13b (OPS-SECREVIEW-001): the checkRateLimit master, and the request limits that call it in one it.each table.
// Trap: the stub never evaluates SQL, so the atomic count is proven on real Postgres in
// tests/integration/app-events.int.test.js (parallel boundary) and photos-intake.int.test.js (per-object cost).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from './_test-stubs/state.js';
import { checkRateLimit, GLOBAL_ACTOR, retryAfterSeconds, withRetryAfter } from './rate-limit.js';

function fakeSql(answer = () => [{ count: 1 }]) {
  const calls = [];
  const sql = async (strings, ...values) => {
    calls.push({ text: strings.join('?'), values });
    return answer();
  };
  sql.calls = calls;
  return sql;
}

describe('checkRateLimit (master)', () => {
  it.each([[''], [undefined], [null], [42]])('SEC-13b S2: actor %j is refused without a statement', async (actor) => {
    const sql = fakeSql();
    expect(await checkRateLimit(sql, actor, 'k.write', 10)).toBe(false);
    expect(sql.calls).toHaveLength(0);
  });

  it('SEC-13b: a cost larger than the limit is refused without a statement', async () => {
    const sql = fakeSql();
    expect(await checkRateLimit(sql, 'user_a', 'k.write', 4, 5)).toBe(false);
    expect(sql.calls).toHaveLength(0);
  });

  it.each([[0, 1], [1, 0], [1.5, 1], [5, -1], ['5', 1]])('limit %j with cost %j is a programming error (TypeError)', async (limit, cost) => {
    await expect(checkRateLimit(fakeSql(), 'user_a', 'k.write', limit, cost)).rejects.toThrow(TypeError);
  });

  it('a multi-object spend runs one upsert that adds the whole cost or nothing', async () => {
    const sql = fakeSql();
    expect(await checkRateLimit(sql, 'user_a', 'photos.upload', 2500, 3)).toBe(true);
    expect(sql.calls).toHaveLength(1);
    const [{ text, values }] = sql.calls;
    expect(text).toContain('INSERT INTO public.rate_limit_buckets (actor_clerk_sub, bucket_key, window_start, count)');
    expect(text).toContain('ON CONFLICT (actor_clerk_sub, bucket_key, window_start)');
    expect(text).toContain('DO UPDATE SET count = public.rate_limit_buckets.count + EXCLUDED.count');
    expect(text).toContain('WHERE public.rate_limit_buckets.count + EXCLUDED.count <= ?');
    expect(values).toEqual(['user_a', 'photos.upload', 3, 2500]);
  });

  it('cost defaults to 1 and sends the single-unit upsert, binding [actor, key, limit]', async () => {
    const sql = fakeSql();
    await checkRateLimit(sql, 'user_a', 'tag.create', 60);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].text).toContain('WHERE public.rate_limit_buckets.count < ?');
    expect(sql.calls[0].values).toEqual(['user_a', 'tag.create', 60]);
  });

  it('a returned row allows; no row (the guard refused the update) denies', async () => {
    expect(await checkRateLimit(fakeSql(() => [{ count: 7 }]), 'user_a', 'k', 10)).toBe(true);
    expect(await checkRateLimit(fakeSql(() => []), 'user_a', 'k', 10)).toBe(false);
  });

  it('a database error reaches the caller (each caller picks its fail mode)', async () => {
    const boom = Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
    await expect(checkRateLimit(fakeSql(() => { throw boom; }), 'user_a', 'k', 10)).rejects.toBe(boom);
  });

  it('the shared-bucket actor can never be a Clerk user id', () => {
    expect(GLOBAL_ACTOR).not.toMatch(/^user_/);
    expect(GLOBAL_ACTOR.length).toBeGreaterThan(0);
  });
});

describe('Retry-After', () => {
  const H = 3600 * 1000;
  it.each([
    [Date.UTC(2026, 9, 29, 19, 0, 0), 3600],
    [Date.UTC(2026, 9, 29, 19, 59, 59), 1],
    [Date.UTC(2026, 9, 29, 19, 30, 0) + 500, 1800],
  ])('retryAfterSeconds(%j) = %j (to the next hour window)', (now, secs) => {
    expect(retryAfterSeconds(now)).toBe(secs);
  });

  it('withRetryAfter adds the header and keeps status, body and the other headers', () => {
    const res = { statusCode: 429, headers: { 'Content-Type': 'application/json' }, body: '{"error":"x"}' };
    expect(withRetryAfter(res, 12)).toEqual({ ...res, headers: { 'Content-Type': 'application/json', 'Retry-After': '12' } });
    expect(res.headers).toEqual({ 'Content-Type': 'application/json' });
    const secs = Number(withRetryAfter(res).headers['Retry-After']);
    expect(secs).toBeGreaterThanOrEqual(1);
    expect(secs).toBeLessThanOrEqual(H / 1000);
  });
});

// ── The SEC-13b request-limit table (security PLAN 8b: one it.each for the boundaries and the allow-list) ──
// Trap: inventory-items caches its secrets on the first call and re-reads them only when the key is missing, so a
// row that needs NO key runs on a fresh module graph (fresh: true); a key cached by an earlier row would hide 501.
const USER = 'user_sec13b_owner';
const SECRETS = 'garden-app/secrets';
const isLimiter = (t) => t.includes('INSERT INTO public.rate_limit_buckets');
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const leaf = (n, name) => ({
  id: u(n), name, crop_type_slug: 'pepper', species: 'annuum', genus: 'Capsicum', variety_rank: null,
  blend_key: null, deleted_at: null, created_by: 'user_other', created_at: '2026-01-01T00:00:00Z',
});

// Markers that must never reach a log line: the image bytes, the pasted text and the model's answer.
const MARK_B64 = 'U0VDMTNCLUlNQUdFLU1BUktFUg=='; // base64 of SEC13B-IMAGE-MARKER
const MARK_TEXT = 'SEC13B-TEXT-MARKER';
const MARK_MODEL = 'SEC13B-MODEL-MARKER';
const USAGE_KEYS = ['actor', 'input_tokens', 'mode', 'outcome', 'output_tokens', 'stop_reason', 'tag', 'upstream_status'];
const MODEL_OK = {
  ok: true, status: 200,
  body: { content: [{ type: 'text', text: `[{"name":"${MARK_MODEL}"}]` }], usage: { input_tokens: 1234, output_tokens: 56 }, stop_reason: 'end_turn' },
};

const HANDLERS = {
  tags: (await import('./tags/index.js')).handler,
  varieties: (await import('./varieties/index.js')).handler,
  appEvents: (await import('./app-events/index.js')).handler,
  inventory: (await import('./inventory-items/index.js')).handler,
  ux: (await import('./ux-events/index.js')).handler,
  fav: (await import('./favorites/index.js')).handler,
};

// deny: every bucket refuses; deny-user / deny-global: only that actor's bucket; throw: the statement fails.
function limiterAnswer(mode, values) {
  if (mode === 'throw') throw Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
  const refused = mode === 'deny'
    || (mode === 'deny-user' && values[0] === USER)
    || (mode === 'deny-global' && values[0] === GLOBAL_ACTOR);
  return refused ? [] : [{ count: 1 }];
}

async function target(row) {
  if (!row.fresh) return { handler: HANDLERS[row.fn], state: stubState };
  vi.resetModules();
  const fresh = await import('./_test-stubs/state.js');
  fresh.resetStubs();
  const { handler } = await import('./inventory-items/index.js');
  return { handler, state: fresh.stubState };
}

const eventOf = (row) => ({
  requestContext: { http: { method: row.method } },
  rawPath: row.path,
  headers: { authorization: 'Bearer stub-token' },
  ...(row.query ? { queryStringParameters: row.query } : {}),
  ...(row.body === undefined ? {} : { body: JSON.stringify(row.body) }),
});

const show = (a) => {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.message}\n${a.stack}`;
  try { return JSON.stringify(a); } catch { return String(a); }
};

const IMAGE = { mode: 'image', image_base64: MARK_B64, media_type: 'image/jpeg' };
const TEXT = { mode: 'text', text: `ORDER ${MARK_TEXT}` };
const usage = (outcome, mode, more = {}) => ({
  tag: 'extract-seeds-usage', actor: USER, mode, outcome,
  upstream_status: null, input_tokens: null, output_tokens: null, stop_reason: null, ...more,
});
const extract = (name, more) => ({
  name: `extract-seeds: ${name}`, fn: 'inventory', method: 'POST', path: '/api/inventory-items/extract-seeds',
  key: true, model: 0, ...more,
});
const CALLED = { upstream_status: 200, input_tokens: 1234, output_tokens: 56, stop_reason: 'end_turn' };

// Every <FavoriteToggle> in src/ (non-test), the only client of POST /api/favorites (FavoriteToggle.jsx posts its
// entityType prop). A complete list, so each one must carry a literal entityType.
const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const TOGGLES = readdirSync(SRC_ROOT, { recursive: true })
  .filter((p) => /\.jsx?$/.test(p) && !/__tests__|\.test\./.test(p))
  .flatMap((p) => [...readFileSync(join(SRC_ROOT, p), 'utf8').matchAll(/<FavoriteToggle\b[^>]*>/g)]
    .map((m) => ({ file: p, tag: m[0], type: m[0].match(/\bentityType="([a-z_]+)"/)?.[1] })));
const CLIENT_TYPES = [...new Set(TOGGLES.map((t) => t.type))].sort();
const LEGACY_FAVORITE = { id: u(8), entity_type: 'location', entity_id: u(9), created_at: '2026-01-01T00:00:00Z' };
const favorite = (name, more) => ({ name: `favorites: ${name}`, fn: 'fav', path: '/api/favorites', ...more });

const ROWS = [
  {
    name: 'tags: tag.create over its limit -> 429 with Retry-After',
    fn: 'tags', method: 'POST', path: '/api/tags', body: { facet: 'group', label: 'Shade' },
    limiter: 'deny', status: 429, error: 'Rate limit exceeded — 60/hour for tag.create', retryAfter: true,
  },
  {
    name: 'varieties: crop_types.create over its limit -> 429 with Retry-After',
    fn: 'varieties', method: 'POST', path: '/api/varieties/crop-types', body: { display_name: 'Tomatillo' },
    limiter: 'deny', status: 429, error: 'Rate limit exceeded — 20/hour for crop_types.create', retryAfter: true,
  },
  {
    name: 'varieties: blend create over plant_varieties.create -> 429 with Retry-After',
    fn: 'varieties', method: 'POST', path: '/api/varieties/blend', body: { component_variety_ids: [u(1), u(2)], create: true },
    db: (text, values) => (/FROM public\.cultivar\s+WHERE id = ANY\(\?::uuid\[\]\)/.test(text)
      ? values[0].map((id) => [leaf(1, 'Carmen'), leaf(2, 'Jimmy Nardello')].find((l) => l.id === id)).filter(Boolean)
      : []),
    limiter: 'deny', status: 429, retryAfter: true,
  },
  {
    name: 'app-events: app_events.write over its limit -> 429 with Retry-After',
    fn: 'appEvents', method: 'POST', path: '/api/app-events', body: { event_name: 'reward_seen' },
    limiter: 'deny', status: 429, error: 'Rate limit exceeded — 1000/hour for app_events.write', retryAfter: true,
  },
  {
    name: 'app-events: under the limit -> 201 and no Retry-After',
    fn: 'appEvents', method: 'POST', path: '/api/app-events', body: { event_name: 'reward_seen' },
    db: (text) => (text.includes('INSERT INTO public.app_events') ? [{ id: 'e1', created_at: 'now' }] : []),
    limiter: 'allow', status: 201,
  },
  extract('the per-user bucket refuses -> 429, the model is not called (key set)', {
    body: IMAGE, limiter: 'deny-user', status: 429, error: 'extractor_rate_limited', retryAfter: true,
    limiterActors: [USER], usage: usage('limited_user', 'image'),
  }),
  extract('the global bucket refuses -> 429, the model is not called (key set)', {
    body: IMAGE, limiter: 'deny-global', status: 429, error: 'extractor_rate_limited', retryAfter: true,
    limiterActors: [USER, GLOBAL_ACTOR], usage: usage('limited_global', 'image'),
  }),
  extract('the limiter fails -> 503, the model is not called (fails closed)', {
    body: IMAGE, limiter: 'throw', status: 503, error: 'extractor_limiter_unavailable', retryAfter: '60',
    limiterActors: [USER], usage: usage('limiter_error', 'image'),
  }),
  extract('over the limit with no key -> 429, not 501 (limits come first)', {
    fresh: true, key: false, body: IMAGE, limiter: 'deny-user', status: 429, error: 'extractor_rate_limited', retryAfter: true,
    limiterActors: [USER], usage: usage('limited_user', 'image'),
  }),
  extract('under the limits with no key -> 501, the model is not called', {
    fresh: true, key: false, body: IMAGE, limiter: 'allow', status: 501, error: 'extractor_not_configured',
    limiterActors: [USER, GLOBAL_ACTOR], usage: usage('not_configured', 'image'),
  }),
  extract('an image under both limits -> one model call with max_tokens 4096', {
    body: IMAGE, limiter: 'allow', status: 200, model: 1, maxTokens: 4096,
    limiterActors: [USER, GLOBAL_ACTOR], usage: usage('called', 'image', CALLED),
  }),
  extract('pasted text under both limits -> one model call with max_tokens 8192', {
    body: TEXT, limiter: 'allow', status: 200, model: 1, maxTokens: 8192,
    limiterActors: [USER, GLOBAL_ACTOR], usage: usage('called', 'text', CALLED),
  }),
  extract('an upstream error -> 502; the usage line has its status and no tokens', {
    body: IMAGE, limiter: 'allow', status: 502, error: 'extractor_upstream', model: 1, maxTokens: 4096,
    upstream: { ok: false, status: 529, body: {} },
    limiterActors: [USER, GLOBAL_ACTOR], usage: usage('called', 'image', { upstream_status: 529 }),
  }),
  extract('an image of exactly 2,000,000 base64 chars passes the size cap', {
    body: { ...IMAGE, image_base64: 'A'.repeat(2_000_000) }, limiter: 'deny-user', status: 429,
    error: 'extractor_rate_limited', retryAfter: true, limiterActors: [USER], usage: usage('limited_user', 'image'),
  }),
  extract('an image of 2,000,001 base64 chars -> 413 before any limiter statement', {
    body: { ...IMAGE, image_base64: 'A'.repeat(2_000_001) }, limiter: 'allow', status: 413, error: 'image_too_large',
    limiterActors: [], usage: null,
  }),
  ...[
    ['meta of exactly 2048 bytes -> 201', { k: 'a'.repeat(2040) }, 201],
    ['meta of 2049 bytes -> 413, nothing written', { k: 'a'.repeat(2041) }, 413],
    ['meta of 1029 chars but 2050 UTF-8 bytes -> 413 (bytes, not chars)', { k: 'é'.repeat(1021) }, 413],
    ['no meta -> 201', undefined, 201],
  ].map(([name, meta, status]) => ({
    name: `ux-events: ${name}`, fn: 'ux', method: 'POST', path: '/api/ux-events',
    body: { flow_id: 'log_watering', session_id: 's-1', ...(meta === undefined ? {} : { meta }) },
    db: (text) => (text.includes('INSERT INTO ux_events') ? [{ id: 'ux-1' }] : []),
    status, writes: { 'INSERT INTO ux_events': status === 201 },
    ...(status === 413 ? { error: 'meta exceeds 2048 bytes' } : {}),
  })),
  // Every entityType a client posts (scanned from src/ below) is created; anything else is refused on create only.
  ...CLIENT_TYPES.map((type) => favorite(`client entity_type '${type}' is created (201)`, {
    method: 'POST', body: { entity_type: type, entity_id: u(9) }, status: 201, writes: { 'INSERT INTO favorites': true },
  })),
  ...['location', 'garden', 'PLANT', 'plant ', 42].map((type) => favorite(`unlisted entity_type ${JSON.stringify(type)} -> 400, nothing written`, {
    method: 'POST', body: { entity_type: type, entity_id: u(9) }, status: 400,
    error: 'entity_type must be one of: plant, project, inventory_item', writes: { 'INSERT INTO favorites': false },
  })),
  favorite('a legacy location favorite can still be removed (DELETE 200)', {
    method: 'DELETE', query: { entity_type: 'location', entity_id: u(9) }, status: 200, writes: { 'DELETE FROM favorites': true },
  }),
  favorite('a legacy location favorite is still listed (GET 200)', {
    method: 'GET', db: (text) => (text.includes('FROM favorites') ? [LEGACY_FAVORITE] : []), status: 200, json: [LEGACY_FAVORITE],
  }),
];

describe('SEC-13b request limits', () => {
  beforeEach(() => {
    resetStubs();
    stubState.verifyTokenResult = { sub: USER };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('the src/ scan found the FavoriteToggle sites, each with a literal entityType', () => {
    expect(TOGGLES.length).toBeGreaterThan(0);
    expect(TOGGLES.filter((t) => !t.type)).toEqual([]);
  });

  it.each(ROWS.map((row) => [row.name, row]))('%s', async (_name, row) => {
    const { handler, state } = await target(row);
    state.verifyTokenResult = { sub: USER };
    if (row.fn === 'inventory') state.secrets[SECRETS].ANTHROPIC_API_KEY = row.key ? 'sk-ant-stub' : undefined;
    const limiterActors = [];
    state.sqlHandler = (text, values) => {
      if (!isLimiter(text)) return row.db?.(text, values) ?? [];
      limiterActors.push(values[0]);
      return limiterAnswer(row.limiter, values);
    };
    const up = row.upstream ?? MODEL_OK;
    const fetchMock = vi.fn(async () => ({ ok: up.ok, status: up.status, json: async () => up.body }));
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await handler(eventOf(row));

    expect(res.statusCode, res.body).toBe(row.status);
    if (row.error !== undefined) expect(JSON.parse(res.body).error).toBe(row.error);
    if (row.json !== undefined) expect(JSON.parse(res.body)).toEqual(row.json);
    if (row.retryAfter === true) {
      const secs = Number(res.headers['Retry-After']);
      expect(secs).toBeGreaterThanOrEqual(1);
      expect(secs).toBeLessThanOrEqual(3600);
    } else if (typeof row.retryAfter === 'string') {
      expect(res.headers['Retry-After']).toBe(row.retryAfter);
    } else {
      expect(res.headers?.['Retry-After']).toBeUndefined();
    }
    for (const [statement, written] of Object.entries(row.writes ?? {})) {
      expect(state.sqlCalls.some((c) => c.text.includes(statement)), statement).toBe(written);
    }
    if (row.fn !== 'inventory') return;

    expect(fetchMock).toHaveBeenCalledTimes(row.model);
    if (row.maxTokens) expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(row.maxTokens);
    expect(limiterActors).toEqual(row.limiterActors);
    const usageLines = log.mock.calls.map((a) => a[0])
      .filter((s) => typeof s === 'string' && s.includes('"extract-seeds-usage"')).map((s) => JSON.parse(s));
    if (row.usage) {
      expect(usageLines).toHaveLength(1);
      expect(Object.keys(usageLines[0]).sort()).toEqual(USAGE_KEYS);
      expect(usageLines[0]).toEqual(row.usage);
    } else {
      expect(usageLines).toEqual([]);
    }
    const printed = [...log.mock.calls, ...err.mock.calls].flat().map(show).join('\n');
    for (const mark of [MARK_B64, MARK_TEXT, MARK_MODEL]) expect(printed).not.toContain(mark);
  });
});
