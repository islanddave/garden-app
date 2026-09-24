// BUG-VOICEALIASHITCOUNT-001 — PATCH /api/varieties/voice-aliases counts a USE of taught aliases.
//
// RUNS THE HANDLER (the vitest.config stub aliases make ./index.js importable) for the decisions that
// live in the route — what it refuses, whose rows it may touch, what it binds — and reads the SQL text
// for the rest. The SQL itself never runs here (mock-sql only). It was planned against the LIVE prod
// schema with EXPLAIN in a read-only transaction (lane V report), and prod's voice_alias has no
// deleted_at and no RLS, so the WHERE below is the whole of the scoping.
import { describe, it, expect, beforeEach } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const SUYO = '00000000-0000-4000-8000-0000000000d2';
const SS100 = '00000000-0000-4000-8000-0000000000d0';
const PATH = '/api/varieties/voice-aliases';

const call = (method, body) => handler({
  requestContext: { http: { method } },
  rawPath: PATH,
  headers: { authorization: 'Bearer stub-token' },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });
const updates = () => stubState.sqlCalls.filter((c) => /UPDATE\s+public\.voice_alias/i.test(c.text));
const inserts = () => stubState.sqlCalls.filter((c) => /INSERT\s+INTO\s+public\.voice_alias/i.test(c.text));

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
});

describe('PATCH /api/varieties/voice-aliases — count a use', () => {
  it('increments the caller\'s alias for the variety that was used, and says how many rows it counted', async () => {
    stubState.sqlHandler = (text) => (/UPDATE\s+public\.voice_alias/i.test(text) ? [{ heard_key: 'cucumberone' }] : []);
    const r = parse(await call('PATCH', { used: [{ heard_key: 'cucumberone', variety_id: SUYO }] }));
    expect(r).toEqual({ status: 200, body: { counted: 1 } });
    expect(updates()).toHaveLength(1);
    const [u] = updates();
    expect(u.text).toMatch(/SET\s+hit_count\s*=\s*a\.hit_count\s*\+\s*1/i);
    expect(u.text).toMatch(/last_used_at\s*=\s*now\(\)/i);
    expect(u.text).toMatch(/a\.user_id\s*=\s*\?/i);
    expect(u.text).toMatch(/a\.heard_key\s*=\s*u\.k/i);
    expect(u.text).toMatch(/a\.variety_id\s*=\s*u\.v/i);
    // DISTINCT: a phrase repeated in one body is one use.
    expect(u.text).toMatch(/SELECT\s+DISTINCT\s+k,\s*v\s+FROM\s+unnest\(\?::text\[\],\s*\?::uuid\[\]\)/i);
    expect(u.values).toEqual([['cucumberone'], [SUYO], USER]);
  });

  it('binds the VERIFIED caller, never anything the body says about whose alias it is', async () => {
    await call('PATCH', { used: [{ heard_key: 'cucumberone', variety_id: SUYO, user_id: 'user_someone_else' }], user_id: 'user_someone_else' });
    expect(updates()).toHaveLength(1);
    expect(updates()[0].values).toEqual([['cucumberone'], [SUYO], USER]);
    expect(JSON.stringify(stubState.sqlCalls)).not.toContain('user_someone_else');
  });

  it('counts several aliases in one statement, keys and varieties kept in pairs', async () => {
    await call('PATCH', { used: [{ heard_key: 'cucumberone', variety_id: SUYO }, { heard_key: 'supersweet100', variety_id: SS100 }] });
    expect(updates()).toHaveLength(1);
    expect(updates()[0].values).toEqual([['cucumberone', 'supersweet100'], [SUYO, SS100], USER]);
  });

  it.each([
    ['not JSON', '{nope'],
    ['no list', {}],
    ['an empty list', { used: [] }],
    ['more than 20', { used: Array.from({ length: 21 }, () => ({ heard_key: 'cucumberone', variety_id: SUYO })) }],
    ['a variety that is not a uuid', { used: [{ heard_key: 'cucumberone', variety_id: 'suyo' }] }],
    ['an un-normalised key', { used: [{ heard_key: 'Cucumber One', variety_id: SUYO }] }],
    ['a key with a space', { used: [{ heard_key: 'cucumber one', variety_id: SUYO }] }],
    ['a key under 4 characters', { used: [{ heard_key: 'cuc', variety_id: SUYO }] }],
    ['a missing key', { used: [{ variety_id: SUYO }] }],
    ['one bad entry among good ones', { used: [{ heard_key: 'cucumberone', variety_id: SUYO }, { heard_key: 'x', variety_id: SUYO }] }],
  ])('refuses %s with a 400 and touches nothing', async (_what, body) => {
    const r = parse(await call('PATCH', body));
    expect(r.status).toBe(400);
    expect(stubState.sqlCalls).toEqual([]);
  });

  it('an unauthenticated count touches nothing', async () => {
    stubState.verifyTokenResult = new Error('bad token');
    const r = parse(await call('PATCH', { used: [{ heard_key: 'cucumberone', variety_id: SUYO }] }));
    expect(r.status).toBe(401);
    expect(stubState.sqlCalls).toEqual([]);
  });

  it('other methods on the path are still refused', async () => {
    expect(parse(await call('DELETE')).status).toBe(405);
    expect(stubState.sqlCalls).toEqual([]);
  });
});

describe('POST /api/varieties/voice-aliases — a re-teach keeps the tally of the SAME meaning', () => {
  it('resets hit_count and last_used_at only when the variety changes', async () => {
    stubState.sqlHandler = (text) => {
      if (/FROM\s+public\.cultivar/i.test(text)) return [{ id: SUYO }];
      if (/INSERT\s+INTO\s+public\.voice_alias/i.test(text)) return [{ heard_key: 'cucumberone', heard_text: 'cucumber one', variety_id: SUYO, hit_count: 4, last_used_at: null }];
      return [];
    };
    const r = parse(await call('POST', { heard_key: 'cucumberone', heard_text: 'cucumber one', variety_id: SUYO }));
    expect(r.status).toBe(200);
    const [ins] = inserts();
    const set = ins.text.replace(/\s+/g, ' ');
    expect(set).toContain('hit_count = CASE WHEN voice_alias.variety_id = EXCLUDED.variety_id THEN voice_alias.hit_count ELSE 0 END');
    expect(set).toContain('last_used_at = CASE WHEN voice_alias.variety_id = EXCLUDED.variety_id THEN voice_alias.last_used_at ELSE NULL END');
    expect(set).not.toMatch(/hit_count\s*=\s*0\s*,/);
  });
});
