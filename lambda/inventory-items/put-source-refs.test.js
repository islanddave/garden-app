// V4-SOURCEREG-001 — the two `public.source` FKs on the inventory write paths.
//
// WHY THE FIRST TEST IN THIS FILE IS THE ONE ABOUT AN OMITTED KEY. The PUT's SET list is a static
// full-row overwrite: 23 columns are assigned `= ${body.x ?? null}` with no COALESCE, so a client
// that omits a key NULLS that column. That is safe for the 23 only because InventoryDetail's edit
// form renders and returns every one of them.
//
// It renders NEITHER of these two, and today nothing in src/ does — no screen sends source_id or
// acquired_from_source_id at all. So a bare assignment would not merely risk provenance on one
// form's edits, it would erase it on the first edit of every row that has it, from any screen, and
// answer 200. The columns are new and empty on prod right now, which means the damage would land on
// exactly the rows a future picker writes and would be invisible until someone noticed a source they
// had set had quietly gone.
//
// BUG-INVSEEDPUT400-001 is the precedent and the shape: featured_photo_id / variety_id /
// seed_process / seed_stage all carry a hasOwnProperty sentinel feeding
// `CASE WHEN <flag> THEN <value> ELSE <column> END`, and `metadata` is excluded from the SET list
// outright for the same reason. These two take the sentinel.
//
// THE STRUCTURAL ASSERTION AND THE FLAG ASSERTION ARE BOTH NEEDED, and put-seed-validate.test.js
// records why: a CASE wired to a constant `true` satisfies the shape check while nulling the column
// exactly as a bare assignment would. So every preservation case below pins the ELSE arm AND the
// value bound to that specific flag.
import { describe, it, expect, beforeEach } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const ITEM = '2d6df841-b507-4e65-8db0-97c8659df37c';
// Two distinct live sources, so "the originator" and "the shop" are never satisfiable by the same
// value — an assertion that passed because both ids happened to be equal would prove nothing about
// a pair whose whole point is that they differ.
const ORIGINATOR = 'a1111111-1111-4111-8111-111111111111';
const SHOP = 'b2222222-2222-4222-8222-222222222222';
const GONE = 'c3333333-3333-4333-8333-333333333333';

// The value bound to ONE named placeholder, not "is this value anywhere in the list" — lifted from
// put-seed-validate.test.js, where `expect(values).toContain(false)` looked like it proved a
// presence guard was off and did not: this UPDATE now binds six such flags, so a `false` from any
// of them would satisfy a loose check while the flag under test stayed pinned to `true`. The stub
// builds its text as `strings.join('?')`, so a placeholder's value is indexed by how many '?'
// precede it.
const boundAfter = (call, re) => {
  const m = call.text.match(re);
  expect(m, `SQL does not match ${re}`).toBeTruthy();
  const end = m.index + m[0].length;
  expect(call.text[end], `${re} must sit immediately before a binding`).toBe('?');
  return call.values[(call.text.slice(0, end).match(/\?/g) ?? []).length];
};

const callMatching = (re) => {
  const hits = stubState.sqlCalls.filter((c) => re.test(c.text));
  expect(hits, `no statement matched ${re}`).toHaveLength(1);
  return hits[0];
};

// Routes by statement so the source lookups and the write can answer differently — a single
// blanket sqlHandler cannot express "this id is live and that one is not", which is the whole
// subject of the liveness block below.
const routeSql = ({ live = [ORIGINATOR, SHOP] } = {}) => (text, values) => {
  if (/FROM public\.source\b/.test(text)) return live.includes(values[0]) ? [{ ok: 1 }] : [];
  if (/UPDATE inventory_items/.test(text)) return [{ id: ITEM, category: 'seeds' }];
  if (/INSERT INTO inventory_items/.test(text)) return [{ id: ITEM }];
  return [];
};

// The EXACT shape InventoryDetail.buildChanges() produces — the point of the preservation cases is
// that this payload is what the real client sends, so an invented body that happened to omit the two
// keys would prove nothing about the screens in production. Fields mirror
// put-seed-validate.test.js's copy of the same function; neither key appears, and that absence IS
// the fixture.
const buildChangesPayload = () => ({
  name: 'Green Flesh Honeydew',
  category: 'seeds',
  status: 'active',
  notes: 'Saved from 2026',
  source: 'Gardens at Mathews',
  source_url: null,
  purchase_date: null,
  unit_cost: null,
  location_text: null,
  quantity_purchased: null,
  quantity_on_hand: 1,
  unit: 'packet',
  reorder_threshold: null,
  reorder_quantity: null,
  quantity: null,
  condition: null,
  brand: null,
  model: null,
});

const createPayload = () => ({
  name: 'Cascadia Snap Pea',
  type: 'consumable',
  category: 'seeds',
  variety_id: 'd58b5155-0c23-4365-bfad-30549b8ca069',
  unit: 'packet',
  quantity_on_hand: 2,
});

const put = (body, id = ITEM) => ({
  requestContext: { http: { method: 'PUT' } },
  rawPath: `/api/inventory-items/${id}`,
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
});
const post = (body) => ({
  requestContext: { http: { method: 'POST' } },
  rawPath: '/api/inventory-items',
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  stubState.sqlHandler = routeSql();
});

describe('V4-SOURCEREG-001 PUT — an omitted key must not erase provenance', () => {
  it('leaves source_id UNTOUCHED when the client does not mention it', async () => {
    const { status } = parse(await handler(put(buildChangesPayload())));
    expect(status).toBe(200);
    const call = callMatching(/UPDATE inventory_items/);
    // The presence guard, structurally: an ELSE arm that re-reads the stored column. A bare
    // `source_id = ${body.source_id ?? null}` writes null here and destroys the provenance.
    expect(call.text).toMatch(/\bsource_id = CASE[\s\S]*?ELSE source_id\s*\n?\s*END/);
    // …and the guard is actually OFF for THIS payload. Without this line a CASE hardwired to a
    // constant true passes the shape assertion above while nulling the column exactly as before.
    expect(boundAfter(call, /\bsource_id = CASE\s*WHEN /)).toBe(false);
  });

  it('leaves acquired_from_source_id UNTOUCHED when the client does not mention it', async () => {
    const { status } = parse(await handler(put(buildChangesPayload())));
    expect(status).toBe(200);
    const call = callMatching(/UPDATE inventory_items/);
    expect(call.text)
      .toMatch(/acquired_from_source_id = CASE[\s\S]*?ELSE acquired_from_source_id\s*\n?\s*END/);
    expect(boundAfter(call, /acquired_from_source_id = CASE\s*WHEN /)).toBe(false);
  });

  it('issues no source lookup at all when neither key is present', async () => {
    // The liveness check is not free — proving it stays off the common path is what keeps every
    // existing PUT a single round trip.
    await handler(put(buildChangesPayload()));
    expect(stubState.sqlCalls.filter((c) => /FROM public\.source\b/.test(c.text))).toHaveLength(0);
    expect(stubState.sqlCalls).toHaveLength(1);
  });
});

describe('V4-SOURCEREG-001 PUT — writing and clearing', () => {
  it('writes both ids through when the client sends them', async () => {
    const { status } = parse(await handler(put({
      ...buildChangesPayload(), source_id: ORIGINATOR, acquired_from_source_id: SHOP,
    })));
    expect(status).toBe(200);
    const call = callMatching(/UPDATE inventory_items/);
    expect(boundAfter(call, /\bsource_id = CASE\s*WHEN /)).toBe(true);
    expect(boundAfter(call, /\bsource_id = CASE\s*WHEN \?\s*THEN /)).toBe(ORIGINATOR);
    expect(boundAfter(call, /acquired_from_source_id = CASE\s*WHEN /)).toBe(true);
    expect(boundAfter(call, /acquired_from_source_id = CASE\s*WHEN \?\s*THEN /)).toBe(SHOP);
  });

  it('an EXPLICIT null clears one id without touching the other', async () => {
    // Presence, not truthiness. `source_id: null` means "this row no longer records an originator",
    // and a `!= null` test would make that unreachable — the failure mode the seed_stage sentinel
    // beside it was written to avoid.
    const { status } = parse(await handler(put({ ...buildChangesPayload(), source_id: null })));
    expect(status).toBe(200);
    const call = callMatching(/UPDATE inventory_items/);
    expect(boundAfter(call, /\bsource_id = CASE\s*WHEN /)).toBe(true);
    expect(boundAfter(call, /\bsource_id = CASE\s*WHEN \?\s*THEN /)).toBeNull();
    // The untouched sibling must stay untouched — a "clear" that cleared both would satisfy every
    // assertion above.
    expect(boundAfter(call, /acquired_from_source_id = CASE\s*WHEN /)).toBe(false);
  });

  it('a null needs no lookup — there is no row to check the liveness of', async () => {
    await handler(put({ ...buildChangesPayload(), source_id: null }));
    expect(stubState.sqlCalls.filter((c) => /FROM public\.source\b/.test(c.text))).toHaveLength(0);
  });
});

describe('V4-SOURCEREG-001 — liveness', () => {
  it('400s a source_id that matches no live row, naming the field', async () => {
    const { status, body } = parse(await handler(put({ ...buildChangesPayload(), source_id: GONE })));
    expect(status).toBe(400);
    expect(body.error).toMatch(/^source_id /);
    expect(body.error, 'the wrong field was named').not.toMatch(/acquired_from/);
    expect(stubState.sqlCalls.filter((c) => /UPDATE inventory_items/.test(c.text)),
      'a rejected payload reached the write').toHaveLength(0);
  });

  it('400s a dead acquired_from_source_id, naming THAT field and not its sibling', async () => {
    const { status, body } = parse(await handler(put({
      ...buildChangesPayload(), source_id: ORIGINATOR, acquired_from_source_id: GONE,
    })));
    expect(status).toBe(400);
    expect(body.error).toMatch(/^acquired_from_source_id /);
    expect(stubState.sqlCalls.filter((c) => /UPDATE inventory_items/.test(c.text))).toHaveLength(0);
  });

  it('asks the database for LIVE rows only — deleted_at is in the predicate', async () => {
    // The behavioural cases above are satisfied by whatever the stub decides is live, so on their
    // own they would stay green against `SELECT 1 FROM public.source WHERE id = $1` with no
    // soft-delete filter at all. Against the real table that query accepts a deleted source.
    await handler(put({ ...buildChangesPayload(), source_id: ORIGINATOR }));
    const call = callMatching(/FROM public\.source\b/);
    expect(call.text).toMatch(/deleted_at IS NULL/);
    expect(call.values[0]).toBe(ORIGINATOR);
  });

  it('400s a malformed id WITHOUT sending it to Postgres', async () => {
    // A non-uuid raises 22P02, which nothing maps, so it would fall through the catch as an opaque
    // 500 — both a worse contract and the side channel V4-AUTHZRESIDUE-001 closed everywhere else.
    const { status, body } = parse(await handler(put({ ...buildChangesPayload(), source_id: 'not-a-uuid' })));
    expect(status).toBe(400);
    expect(body.error).toMatch(/^source_id /);
    expect(stubState.sqlCalls, 'a malformed id reached the database').toHaveLength(0);
  });

  it('checks the same two fields on POST', async () => {
    const { status, body } = parse(await handler(post({ ...createPayload(), source_id: GONE })));
    expect(status).toBe(400);
    expect(body.error).toMatch(/^source_id /);
    expect(stubState.sqlCalls.filter((c) => /INSERT INTO inventory_items/.test(c.text))).toHaveLength(0);
  });
});

describe('V4-SOURCEREG-001 — the pair must name two different places', () => {
  it('400s a PUT that names one source twice, before any SQL runs', async () => {
    const { status, body } = parse(await handler(put({
      ...buildChangesPayload(), source_id: ORIGINATOR, acquired_from_source_id: ORIGINATOR,
    })));
    expect(status).toBe(400);
    expect(body.error).toBe('source_id and acquired_from_source_id must name different sources');
    expect(stubState.sqlCalls, 'the distinctness check should not need a round trip').toHaveLength(0);
  });

  it('400s the same collision on POST', async () => {
    const { status, body } = parse(await handler(post({
      ...createPayload(), source_id: SHOP, acquired_from_source_id: SHOP,
    })));
    expect(status).toBe(400);
    expect(body.error).toBe('source_id and acquired_from_source_id must name different sources');
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('says nothing when both are null — NULL is "not recorded", not "the same place"', async () => {
    // Two nulls are equal in JavaScript and legal in the database. A `===` comparison written
    // without the null guard would reject every payload that cleared both at once.
    const { status } = parse(await handler(put({
      ...buildChangesPayload(), source_id: null, acquired_from_source_id: null,
    })));
    expect(status).toBe(200);
  });

  it('answers the PARTIAL collision with a sentence, not a constraint name', async () => {
    // The body-only compare cannot see this one: the client sends acquired_from_source_id alone and
    // it collides with the source_id already stored on the row. No validator here reads the stored
    // row, so the CHECK is what catches it — and this is what the user is told when it does.
    stubState.sqlHandler = (text, values) => {
      if (/FROM public\.source\b/.test(text)) return values.includes(SHOP) ? [{ ok: 1 }] : [];
      const err = new Error('new row violates check constraint');
      err.code = '23514';
      err.constraint = 'chk_inventory_source_distinct';
      throw err;
    };
    const { status, body } = parse(await handler(put({
      ...buildChangesPayload(), acquired_from_source_id: SHOP,
    })));
    expect(status).toBe(400);
    expect(body.error, 'the schema name leaked into the user-facing string').not.toMatch(/chk_/);
    expect(body.error).toMatch(/two different sources/);
  });
});

describe('V4-SOURCEREG-001 POST — the columns are named in the INSERT', () => {
  it('writes both ids on create', async () => {
    // Postgres does not complain about a key an INSERT never mentions, so an unnamed column returns
    // 201 with the value silently dropped — the failure BUG-INVMETADROP-001 and
    // BUG-SEEDPOSTDROPSPARENT-001 both were, on this same statement.
    const { status } = parse(await handler(post({
      ...createPayload(), source_id: ORIGINATOR, acquired_from_source_id: SHOP,
    })));
    expect(status).toBe(201);
    const call = callMatching(/INSERT INTO inventory_items/);
    expect(call.text).toMatch(/source_id, acquired_from_source_id\s*\)\s*VALUES/);
    expect(call.values).toContain(ORIGINATOR);
    expect(call.values).toContain(SHOP);
    // Position, not membership: the ids must land in the two columns just declared, and `toContain`
    // is satisfied by a value bound anywhere in a 33-parameter statement.
    const cols = call.text.match(/INSERT INTO inventory_items \(([\s\S]*?)\) VALUES/)[1]
      .split(',').map((s) => s.trim());
    expect(call.values[cols.indexOf('source_id')]).toBe(ORIGINATOR);
    expect(call.values[cols.indexOf('acquired_from_source_id')]).toBe(SHOP);
  });

  it('binds null for both when the client sends neither', async () => {
    const { status } = parse(await handler(post(createPayload())));
    expect(status).toBe(201);
    const call = callMatching(/INSERT INTO inventory_items/);
    const cols = call.text.match(/INSERT INTO inventory_items \(([\s\S]*?)\) VALUES/)[1]
      .split(',').map((s) => s.trim());
    expect(call.values[cols.indexOf('source_id')]).toBeNull();
    expect(call.values[cols.indexOf('acquired_from_source_id')]).toBeNull();
  });
});
