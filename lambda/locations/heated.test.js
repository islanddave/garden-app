// V5-LOCHEATEDUI-001 — locations.heated through the API: the type rule, the heated-implies-covered
// rule, and the column's place in every statement that writes or lists it.
//
// Two halves. The rules themselves are pure (heated.js) and are tested as behaviour. The handler is
// then IMPORTED and driven through the Lambda runtime stubs (lambda/_test-stubs, aliased in
// vitest.config.ts), so the tests below prove the rules are wired in at the right points and that the
// right values reach the right SQL parameters. The stubs are not a database: nothing here proves a
// statement RUNS. That half is tests/integration/locations.int.test.js (real Postgres).
import { describe, it, expect, beforeEach } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';
import {
  validateHeatedType, heatedCoverError, nextFlagsForPut, nextFlagsForPost,
  HEATED_TYPE_ERROR, HEATED_NEEDS_COVER_ERROR,
} from './heated.js';

const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const LOC = '7ee03125-2470-4400-a870-d931da1ffb92';

const event = (method, path, body) => ({
  requestContext: { http: { method } },
  rawPath: path,
  headers: { authorization: 'Bearer stub-token' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

const callsMatching = (re) => stubState.sqlCalls.filter((c) => re.test(c.text));
const updateCall = () => callsMatching(/UPDATE locations\s+SET\s+name/)[0];
const insertCall = () => callsMatching(/INSERT INTO locations/)[0];
const flagsRead = () => callsMatching(/SELECT covered, heated FROM locations/);

// The value bound to the FIRST placeholder after `re` in a recorded statement. The stub records the
// template as strings.join('?'), so the k-th '?' is values[k] — which only holds while the SQL text
// itself carries no literal '?'. Asserted, not assumed: a '?' added to a comment in these templates
// would otherwise shift every lookup by one onto a neighbouring null and pass for the wrong reason.
function paramAfter(call, re) {
  expect(call.text.split('?').length - 1, 'a literal ? in the SQL text would misalign params')
    .toBe(call.values.length);
  const m = re.exec(call.text);
  expect(m, `no ${re} in the recorded statement`).not.toBeNull();
  const qIdx = call.text.indexOf('?', m.index + m[0].length);
  return call.values[call.text.slice(0, qIdx).split('?').length - 1];
}

// The current row the PUT's pre-read sees, and what the UPDATE hands back.
let currentRow;
function scriptSql() {
  stubState.sqlHandler = (text) => {
    if (/SELECT id::text AS id/.test(text)) return currentRow ? [{ id: LOC }] : [];
    if (/SELECT covered, heated FROM locations/.test(text)) {
      return currentRow ? [{ covered: currentRow.covered, heated: currentRow.heated }] : [];
    }
    if (/UPDATE locations\s+SET\s+name/.test(text)) return currentRow ? [{ id: LOC, ...currentRow }] : [];
    if (/INSERT INTO locations/.test(text)) return [{ id: 'new-loc', heated: false, covered: null }];
    if (/FROM locations_with_path/.test(text)) return [];
    if (/FROM locations/.test(text)) return [{ id: LOC, name: 'House', covered: true, heated: true }];
    return [];
  };
}

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  currentRow = { name: 'House', covered: true, heated: false };
  scriptSql();
});

// ─── the rules, as behaviour ─────────────────────────────────────────────────────────────────────

describe('heated.js — the type rule', () => {
  it('absent and null are "not sent", never a value', () => {
    expect(validateHeatedType({})).toBeNull();
    expect(validateHeatedType({ heated: null })).toBeNull();
    expect(validateHeatedType(undefined)).toBeNull();
  });

  it('true and false are the only values', () => {
    expect(validateHeatedType({ heated: true })).toBeNull();
    expect(validateHeatedType({ heated: false })).toBeNull();
  });

  // The strings are the dangerous ones: Postgres would cast 'true', 't', 'yes', 'on' and '1' to TRUE,
  // and a false TRUE silences every cold card in the location.
  it.each([['true'], ['false'], ['yes'], ['t'], [1], [0], ['on'], [{}], [[]]])(
    'refuses %j, naming the field', (v) => {
      expect(validateHeatedType({ heated: v })).toBe(HEATED_TYPE_ERROR);
      expect(HEATED_TYPE_ERROR).toMatch(/\bheated\b/);
    });
});

describe('heated.js — heated implies covered, on the row as it will be written', () => {
  it.each([
    [{ heated: true, covered: true }, null],
    [{ heated: false, covered: false }, null],
    [{ heated: false, covered: null }, null],
    [{ heated: true, covered: false }, HEATED_NEEDS_COVER_ERROR],
    // NULL is "not stated", and the standing gate's predicate is `covered IS NOT TRUE`, so a heated
    // location with an unstated cover is refused exactly as an open-sky one is.
    [{ heated: true, covered: null }, HEATED_NEEDS_COVER_ERROR],
  ])('%j -> %s', (next, expected) => {
    expect(heatedCoverError(next)).toBe(expected);
  });

  it('PUT: an absent or null key keeps the current value (COALESCE grammar)', () => {
    const cur = { covered: true, heated: true };
    expect(nextFlagsForPut({}, cur)).toEqual({ heated: true, covered: true });
    expect(nextFlagsForPut({ heated: null, covered: null }, cur)).toEqual({ heated: true, covered: true });
    expect(nextFlagsForPut({ covered: false }, cur)).toEqual({ heated: true, covered: false });
    expect(nextFlagsForPut({ heated: false }, cur)).toEqual({ heated: false, covered: true });
  });

  it('PUT: the case the brief names — covered:false alone on a heated location is refused', () => {
    expect(heatedCoverError(nextFlagsForPut({ covered: false }, { covered: true, heated: true })))
      .toBe(HEATED_NEEDS_COVER_ERROR);
    // …and the UI's untick path, which sends both, is not.
    expect(heatedCoverError(nextFlagsForPut({ covered: false, heated: false }, { covered: true, heated: true })))
      .toBeNull();
  });

  it('POST: a new row has only its body — heated defaults to false, covered to NULL', () => {
    expect(nextFlagsForPost({})).toEqual({ heated: false, covered: null });
    expect(nextFlagsForPost({ heated: true })).toEqual({ heated: true, covered: null });
    expect(heatedCoverError(nextFlagsForPost({ heated: true }))).toBe(HEATED_NEEDS_COVER_ERROR);
    expect(heatedCoverError(nextFlagsForPost({ heated: true, covered: true }))).toBeNull();
  });
});

// ─── the handler: POST ───────────────────────────────────────────────────────────────────────────

describe('POST /api/locations — heated', () => {
  const post = (body) => handler(event('POST', '/api/locations', body)).then(parse);

  it('writes heated:true when covered:true comes with it, bound to the heated column', async () => {
    const { status } = await post({ name: 'Heated Greenhouse', covered: true, heated: true });
    expect(status).toBe(201);
    const ins = insertCall();
    const cols = /INSERT INTO locations\s*\(([^)]*)\)/.exec(ins.text)[1].split(',').map((s) => s.trim());
    // Zip the column list with the bound values. Each VALUES item is exactly one ${}, in column order.
    expect(ins.values).toHaveLength(cols.length);
    const row = Object.fromEntries(cols.map((c, i) => [c, ins.values[i]]));
    expect(row.heated).toBe(true);
    expect(row.covered).toBe(true);
    expect(row.created_by).toBe(USER);
  });

  it('not sent -> false, never NULL (the column is NOT NULL)', async () => {
    for (const body of [{ name: 'Bed A' }, { name: 'Bed B', heated: null }]) {
      stubState.sqlCalls = [];
      const { status } = await post(body);
      expect(status).toBe(201);
      const ins = insertCall();
      const cols = /INSERT INTO locations\s*\(([^)]*)\)/.exec(ins.text)[1].split(',').map((s) => s.trim());
      const row = Object.fromEntries(cols.map((c, i) => [c, ins.values[i]]));
      expect(row.heated, JSON.stringify(body)).toBe(false);
    }
  });

  it.each([['true'], [1], ['yes']])('heated %j -> 400 naming the field, and nothing is written', async (v) => {
    const { status, body } = await post({ name: 'Bad', covered: true, heated: v });
    expect(status).toBe(400);
    expect(body.error).toBe(HEATED_TYPE_ERROR);
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it.each([
    [{ heated: true }],
    [{ heated: true, covered: false }],
    [{ heated: true, covered: null }],
  ])('%j without covered:true -> 400, and nothing is written', async (flags) => {
    const { status, body } = await post({ name: 'Bad', ...flags });
    expect(status).toBe(400);
    expect(body.error).toBe(HEATED_NEEDS_COVER_ERROR);
    expect(stubState.sqlCalls).toHaveLength(0);
  });
});

// ─── the handler: PUT ────────────────────────────────────────────────────────────────────────────

describe('PUT /api/locations/:id — heated', () => {
  const put = (body) => handler(event('PUT', `/api/locations/${LOC}`, body)).then(parse);

  it('ticks heated on a covered location: 200, true bound to the heated arm', async () => {
    currentRow = { name: 'House', covered: true, heated: false };
    const { status } = await put({ heated: true });
    expect(status).toBe(200);
    expect(paramAfter(updateCall(), /\bheated\s*=\s*COALESCE\(/)).toBe(true);
  });

  it('read-back shape: the response is the written row, heated included', async () => {
    currentRow = { name: 'House', covered: true, heated: true };
    const { status, body } = await put({ heated: true });
    expect(status).toBe(200);
    expect(body).toHaveProperty('heated', true);
    expect(updateCall().text).toMatch(/RETURNING \*/);
  });

  it('a PUT without heated leaves it unchanged: the arm binds NULL, which COALESCE keeps', async () => {
    // This is the whole edit-form-less caller population today — toggleActive sends only is_active,
    // and every stale client sends no heated key at all. A binding of false here would un-heat the
    // House on the next rename.
    currentRow = { name: 'House', covered: true, heated: true };
    for (const body of [{ name: 'The House' }, { is_active: false }, { heated: null }]) {
      stubState.sqlCalls = [];
      const { status } = await put(body);
      expect(status, JSON.stringify(body)).toBe(200);
      const upd = updateCall();
      expect(upd.text).toMatch(/\bheated\s*=\s*COALESCE\(\?, heated\)/);
      expect(paramAfter(upd, /\bheated\s*=\s*COALESCE\(/), JSON.stringify(body)).toBeNull();
    }
  });

  it('heated:"yes" -> 400 naming the field, and nothing is written', async () => {
    const { status, body } = await put({ heated: 'yes' });
    expect(status).toBe(400);
    expect(body.error).toBe(HEATED_TYPE_ERROR);
    expect(updateCall()).toBeUndefined();
  });

  it.each([
    ['open to the sky', false],
    ['cover not stated', null],
  ])('ticking heated on a location %s -> 400, nothing written', async (_label, covered) => {
    currentRow = { name: 'Bag Area', covered, heated: false };
    const { status, body } = await put({ heated: true });
    expect(status).toBe(400);
    expect(body.error).toBe(HEATED_NEEDS_COVER_ERROR);
    expect(updateCall()).toBeUndefined();
  });

  it('ticking heated AND setting covered:true in one request is allowed', async () => {
    currentRow = { name: 'New Greenhouse', covered: null, heated: false };
    const { status } = await put({ heated: true, covered: true });
    expect(status).toBe(200);
    expect(paramAfter(updateCall(), /\bheated\s*=\s*COALESCE\(/)).toBe(true);
    expect(paramAfter(updateCall(), /\bcovered\s*=\s*COALESCE\(/)).toBe(true);
  });

  it('covered:false alone on a heated location -> 400, nothing written', async () => {
    currentRow = { name: 'House', covered: true, heated: true };
    const { status, body } = await put({ covered: false });
    expect(status).toBe(400);
    expect(body.error).toBe(HEATED_NEEDS_COVER_ERROR);
    expect(updateCall()).toBeUndefined();
  });

  it('covered:false with heated:false (the UI untick path) is allowed', async () => {
    currentRow = { name: 'House', covered: true, heated: true };
    const { status } = await put({ covered: false, heated: false });
    expect(status).toBe(200);
    expect(paramAfter(updateCall(), /\bheated\s*=\s*COALESCE\(/)).toBe(false);
  });

  it('a row already inconsistent (hand-written SQL) is refused with the plain 400, even on a rename', async () => {
    currentRow = { name: 'Bag Area', covered: false, heated: true };
    const { status, body } = await put({ name: 'Bag Area 2' });
    expect(status).toBe(400);
    expect(body.error).toBe(HEATED_NEEDS_COVER_ERROR);
    expect(updateCall()).toBeUndefined();
  });

  it('the pre-read is household- and live-scoped, keyed on the resolved id', async () => {
    await put({ name: 'x' });
    const reads = flagsRead();
    expect(reads).toHaveLength(1);
    expect(reads[0].text).toMatch(/WHERE id = \?\s+AND deleted_at IS NULL\s+AND created_by = ANY\(\?\)/);
    expect(reads[0].values).toEqual([LOC, [USER]]);
  });

  it('a row that vanishes between resolve and pre-read is a 404, not a 400', async () => {
    stubState.sqlHandler = (text) => (/SELECT id::text AS id/.test(text) ? [{ id: LOC }] : []);
    const { status, body } = await put({ heated: true });
    expect(status).toBe(404);
    expect(body.error).toBe('Not found');
  });

  // The race backstop. The pre-read cannot see a write that lands between it and the UPDATE, so the
  // statement re-checks the rule on the row it is writing. Pinned on the emitted SQL and its bound
  // values — the stubs cannot evaluate SQL, so its truth table is proven against a real Postgres (lane
  // report) and exercised end to end by the integration test.
  it('the UPDATE re-checks heated-implies-covered on the row being written', async () => {
    currentRow = { name: 'House', covered: true, heated: false };
    await put({ heated: true, covered: true });
    const upd = updateCall();
    const where = upd.text.slice(upd.text.indexOf('WHERE id = ?'), upd.text.indexOf('RETURNING'));
    expect(where.length, 'WHERE slice bound').toBeLessThan(900);
    expect(where).toMatch(
      /AND \(COALESCE\(\?, heated\) IS NOT TRUE\s+OR COALESCE\(\?, covered\) IS TRUE\)/);
    expect(paramAfter(upd, /AND \(COALESCE\(/)).toBe(true);
    expect(paramAfter(upd, /OR COALESCE\(/)).toBe(true);
  });

  it('heated is not clearable — NOT NULL has no clear arm', async () => {
    const { status, body } = await put({ clear: ['heated'] });
    expect(status).toBe(400);
    expect(body.error).toMatch(/cannot be cleared/);
    expect(updateCall()).toBeUndefined();
  });
});

// ─── the handler: GET list ───────────────────────────────────────────────────────────────────────

describe('GET /api/locations — heated is returned wherever covered is', () => {
  it('the list projection carries heated beside covered', async () => {
    const res = parse(await handler(event('GET', '/api/locations')));
    expect(res.status).toBe(200);
    const list = callsMatching(/SELECT id, name, slug, level/)[0];
    expect(list.text).toMatch(/is_active, covered, heated, created_at/);
    expect(res.body.locations[0]).toHaveProperty('heated', true);
  });
});
