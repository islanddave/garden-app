// V5-SEEDMULTIPARENT-001 (release 2a) — two optional keys on PUT /api/inventory-items/:id/source-plants,
// driven through the handler:
//
//   expected_source_plant_ids — THE PRECONDITION. The set the caller last read. The route replaces
//     the whole set, so a page that loaded before another device added a parent would retire that
//     parent on a 200 (regression seat R2-12). Present and not SET-EQUAL to the lot's live
//     seed_parent plantings -> 409 { error, code: "lot_changed", source_plant_id, source_plants },
//     nothing written. Absent = release 1's behaviour exactly, so every shipped caller, the smoke
//     and the legacy route are untouched.
//
//   source_plant_id — THE CACHE HINT. Which member the column should cache after the write. Must be
//     one of source_plant_ids (400 otherwise). Absent = release 1's rule. It exists for Undo:
//     removing the cached parent and adding it back would otherwise leave the cache on another one.
//
// THE STUB EXECUTES NO SQL, and that matters more here than anywhere in this directory. "Judged
// ONCE, under the lot lock, before the first write" is the whole design of the precondition — a
// set-equality test repeated in each write's WHERE would be re-asked of a set the first write had
// already changed, and the edit would half-apply. What this file can show is that the comparison is
// IN the facts statement and in NO write statement, that the writes read the held verdict instead,
// and what the route answers for each shape of facts row. That the held verdict actually stops all
// three writes, and that it is judged after a concurrent writer's commit and not before, are named
// in the lane report as cases only a real Postgres can prove.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const LOT = '2d6df841-b507-4e65-8db0-97c8659df37c';
const uuid = (n) => `3f9c1e64-1a2b-4c3d-8e4f-${String(n).padStart(12, '0')}`;
const A = uuid(1);
const B = uuid(2);
const C = uuid(3);
const GONE = uuid(9);          // a planting that has since been deleted — fine in an expectation
const VARIETY = uuid(90);

const put = (body, id = LOT) => ({
  requestContext: { http: { method: 'PUT' } },
  rawPath: `/api/inventory-items/${id}/source-plants`,
  headers: { authorization: 'Bearer stub-token' },
  body: JSON.stringify(body),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

const IS = {
  rules: (t) => /AS rules_hold/.test(t),
  pfacts: (t) => /AS lot_found/.test(t),
  owns: (t) => /FROM public\.garden_node p\s+WHERE p\.id = ANY\(\?::uuid\[\]\)\s+AND p\.created_by = ANY/.test(t),
  members: (t) => /SELECT k\.plant_id AS id/.test(t),
  lock: (t) => /FOR UPDATE/.test(t),
  hold: (t) => /FOR SHARE/.test(t),
  facts: (t) => /AS live_parents/.test(t),
  retire: (t) => /UPDATE public\.seed_lot_parent_planting l/.test(t),
  add: (t) => /INSERT INTO public\.seed_lot_parent_planting/.test(t),
  cache: (t) => /UPDATE public\.inventory_items i/.test(t),
  read: (t) => /jsonb_agg/.test(t),
};
const kindOf = (t) => Object.keys(IS).find((k) => IS[k](t)) ?? 'other';
const kinds = () => stubState.sqlCalls.map((c) => kindOf(c.text));
const find = (k) => stubState.sqlCalls.find((c) => kindOf(c.text) === k);
const WRITES = ['retire', 'add', 'cache'];

const parent = (id, name) => ({
  id, name, variety_id: VARIETY, variety_name: 'Alaska Mix', breeding_system: 'open_pollinated',
  variety_rank: 'cultivar', crop_slug: 'nasturtium', archived: false, deleted: false,
});
const AS_STORED = [parent(A, 'Bed 3 nasturtium'), parent(C, 'Pot nasturtium')];

const world = (over = {}) => (text, values) => {
  const k = kindOf(text);
  if (k in over) return typeof over[k] === 'function' ? over[k](values) : over[k];
  return {
    owns: () => values[0].map((id) => ({ id })),
    members: () => [],
    pfacts: () => values[0].map((id) => ({
      id, cultivar_id: VARIETY, crop_slug: 'nasturtium', blend_key: null, member: false, lot_found: true, lot_variety_id: VARIETY,
    })),
    lock: () => [{ id: LOT }],
    hold: () => values[0].map((id) => ({ id })),
    facts: () => [{ id: LOT, source_kind: null, source_plant_id: A, live_parents: 2, ids_usable: true, set_as_expected: true, go: 'go' }],
    rules: () => [{ rules_hold: true, go: 'go' }],
    retire: () => [],
    add: () => [],
    cache: () => [{ id: LOT, source_plant_id: A }],
    read: () => [{ inventory_item_id: LOT, source_plants: AS_STORED }],
    other: () => [],
  }[k]();
};
const given = (over) => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  stubState.sqlHandler = world(over);
};
// The value bound to the n-th placeholder after a marker, read off one statement.
const boundAt = (c, marker, nth = 0) => {
  const at = c.text.indexOf(marker);
  expect(at, `statement does not contain ${marker}`).toBeGreaterThan(-1);
  return c.values[(c.text.slice(0, at + marker.length).match(/\?/g) ?? []).length + nth];
};
const LOT_CHANGED = 'This seed lot was changed at the same moment. Reload and try again.';

beforeEach(() => {
  given();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('expected_source_plant_ids — shape, before any SQL', () => {
  it('400s a non-array, a non-uuid element and more than twelve, NAMING THIS KEY', async () => {
    const thirteen = Array.from({ length: 13 }, (_, i) => uuid(i + 20));
    const cases = [
      [A, 'expected_source_plant_ids must be an array of planting ids'],
      [{ ids: [A] }, 'expected_source_plant_ids must be an array of planting ids'],
      [[A, 'not-a-uuid'], 'expected_source_plant_ids must contain only planting ids'],
      [[A, 7], 'expected_source_plant_ids must contain only planting ids'],
      [thirteen, 'expected_source_plant_ids can name at most 12 plantings'],
    ];
    for (const [value, message] of cases) {
      given();
      const res = parse(await handler(put({ source_plant_ids: [A], expected_source_plant_ids: value })));
      expect(res.status, JSON.stringify(value)).toBe(400);
      // Not "source_plant_ids must…": a caller told the wrong key was malformed fixes the wrong one.
      expect(res.body).toEqual({ error: message });
      expect(stubState.sqlCalls, 'malformed input reached the database').toHaveLength(0);
    }
  });

  it('still names source_plant_ids when THAT is the malformed one', async () => {
    const res = parse(await handler(put({ source_plant_ids: 'nope', expected_source_plant_ids: [A] })));
    expect(res.body).toEqual({ error: 'source_plant_ids must be an array of planting ids' });
  });

  it('null is ABSENT: there is no "clear" for an expectation to tell from "not sent"', async () => {
    const res = parse(await handler(put({ source_plant_ids: [A], expected_source_plant_ids: null })));
    expect(res.status).toBe(200);
    expect(boundAt(find('facts'), 'AS ids_usable,\n               (NOT ')).toBe(false);
  });

  it('[] is a REAL expectation — "I last saw no parents" — not absence', async () => {
    await handler(put({ source_plant_ids: [A], expected_source_plant_ids: [] }));
    const facts = find('facts');
    expect(boundAt(facts, 'AS ids_usable,\n               (NOT ')).toBe(true);
    expect(boundAt(facts, 'AS ids_usable,\n               (NOT ', 1)).toEqual([]);
  });

  it('is SHAPE-CHECKED ONLY: it is never put to the ownership gate, so it may name a planting since deleted', async () => {
    // The gate answers for the set being written. GONE is in the expectation alone; if it were
    // gated, the one request that most needs the precondition — "a parent I saw has gone" — would
    // be a 400 about a planting the caller is not even asking to use.
    given({ owns: (values) => values[0].filter((id) => id !== GONE).map((id) => ({ id })) });
    const res = parse(await handler(put({ source_plant_ids: [A], expected_source_plant_ids: [A, GONE] })));
    expect(res.status).toBe(200);
    expect(find('owns').values).toEqual([[A], [USER]]);
    expect(kinds()).not.toContain('members');
    // GONE is bound in exactly one statement: the facts.
    const naming = stubState.sqlCalls.filter((c) => JSON.stringify(c.values).includes(GONE));
    expect(naming.map((c) => kindOf(c.text))).toEqual(['facts']);
  });

  it('is deduped and lower-cased like the set, so a set is compared with a set', async () => {
    await handler(put({ source_plant_ids: [A], expected_source_plant_ids: [B.toUpperCase(), A, B] }));
    const facts = find('facts');
    const marker = 'AS ids_usable,\n               (NOT ';
    expect([1, 2, 3].map((n) => boundAt(facts, marker, n))).toEqual([[B, A], [B, A], [B, A]]);
  });
});

describe('expected_source_plant_ids — the precondition', () => {
  const stale = () => given({
    facts: [{ id: LOT, source_kind: null, source_plant_id: A, live_parents: 2, ids_usable: true, set_as_expected: false, go: 'stop' }],
    cache: [],
  });

  it('409 lot_changed when the lot\'s live set is not the one expected — with what the lot holds now', async () => {
    // Device 1 holds {A, C}. This caller loaded at {A}, adds B, and sends {A, B} — which under
    // release 1 retired C on a 200.
    stale();
    const res = parse(await handler(put({ source_plant_ids: [A, B], expected_source_plant_ids: [A] })));
    expect(res.status).toBe(409);
    // EXACTLY these four keys: the sentence a shipped client prints, the code a new one branches on,
    // and the lot as it stands so the page can redraw without a second fetch.
    expect(res.body).toEqual({ error: LOT_CHANGED, code: 'lot_changed', source_plant_id: A, source_plants: AS_STORED });
  });

  it('it is the SAME sentence and status the concurrent-writer 409 has always had', async () => {
    stale();
    const mismatch = parse(await handler(put({ source_plant_ids: [A, B], expected_source_plant_ids: [A] })));
    given({ add: () => { throw Object.assign(new Error('duplicate key value'), { code: '23505' }); } });
    const collision = parse(await handler(put({ source_plant_ids: [A, B] })));
    expect(collision.status).toBe(mismatch.status);
    expect(collision.body.error).toBe(mismatch.body.error);
    expect(collision.body.code).toBe(mismatch.body.code);
    // The collision's transaction rolled back, so it has no set to report. A client must not
    // assume lot_changed always carries one.
    expect(collision.body.source_plants).toBeUndefined();
    expect(mismatch.body.source_plants).toEqual(AS_STORED);
  });

  it('goes through when the expectation holds, with release 1\'s reply exactly', async () => {
    const res = parse(await handler(put({ source_plant_ids: [A, B], expected_source_plant_ids: [C, A] })));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: LOT, source_plant_id: A, source_plants: AS_STORED });
  });

  it('ABSENT = release 1: the comparison is switched off, not answered true', async () => {
    const res = parse(await handler(put({ source_plant_ids: [A, B] })));
    expect(res.status).toBe(200);
    const facts = find('facts');
    const marker = 'AS ids_usable,\n               (NOT ';
    expect(boundAt(facts, marker)).toBe(false);
    expect([1, 2, 3].map((n) => boundAt(facts, marker, n))).toEqual([[], [], []]);
    expect(Object.keys(res.body).sort()).toEqual(['id', 'source_plant_id', 'source_plants']);
  });

  it('is judged in ONE statement — the facts, after both locks — and by NO write', async () => {
    await handler(put({ source_plant_ids: [A, B], expected_source_plant_ids: [A, C] }));
    const order = kinds();
    expect(order.indexOf('lock')).toBeLessThan(order.indexOf('hold'));
    expect(order.indexOf('hold')).toBeLessThan(order.indexOf('facts'));
    expect(order.indexOf('facts')).toBeLessThan(order.indexOf('retire'));
    const comparing = stubState.sqlCalls.filter((c) => /AS set_as_expected/.test(c.text));
    expect(comparing.map((c) => kindOf(c.text))).toEqual(['facts']);
    // C is in the expectation only. It reaches the facts and nothing else: no write is given the
    // expected set to compare against a table that write itself is changing.
    for (const k of WRITES) {
      expect(JSON.stringify(find(k).values), k).not.toContain(C);
      expect(find(k).text, k).not.toMatch(/set_as_expected/);
    }
  });

  it('the writes read the HELD verdict instead: each carries it once, and only the facts set it', async () => {
    await handler(put({ source_plant_ids: [A, B], expected_source_plant_ids: [A, C] }));
    const GO = "current_setting('app.seed_lot_go', true) = 'go'";
    for (const k of WRITES) expect(find(k).text.split(GO), k).toHaveLength(2);
    const facts = find('facts').text.replace(/\s+/g, ' ');
    expect(facts).toContain("AND f.set_as_expected THEN 'go' ELSE 'stop' END, true) AS go");
    // The verdict folds release 1's three guards in with it, so it cannot say go where one of them
    // (still in each write) would say no.
    expect(facts).toContain("CASE WHEN (f.source_kind IS NULL OR f.source_kind = 'own_garden' OR cardinality(?::uuid[]) = 0) AND (NOT ?::boolean OR f.live_parents <= 1) AND f.ids_usable AND f.set_as_expected");
  });

  it('a stale caller is told so FIRST — before a shop-kind lot, an unusable planting or the rules', async () => {
    for (const facts of [
      { source_kind: 'gift' },
      { ids_usable: false },
    ]) {
      given({
        facts: [{ id: LOT, source_kind: null, source_plant_id: A, live_parents: 2, ids_usable: true, set_as_expected: false, ...facts }],
        cache: [],
      });
      // eslint-disable-next-line no-await-in-loop
      const res = parse(await handler(put({ source_plant_ids: [A, B], expected_source_plant_ids: [A] })));
      expect(res.status, JSON.stringify(facts)).toBe(409);
      expect(res.body.code, JSON.stringify(facts)).toBe('lot_changed');
    }
    given({
      facts: [{ id: LOT, source_kind: null, source_plant_id: A, live_parents: 2, ids_usable: true, set_as_expected: false }],
      rules: [{ rules_hold: false, go: 'stop' }], cache: [],
    });
    expect(parse(await handler(put({ source_plant_ids: [A, B], expected_source_plant_ids: [A] }))).body.code).toBe('lot_changed');
  });

  it('…but a lot that is not the caller\'s is still a 404, whatever was expected of it', async () => {
    given({ lock: [], facts: [], cache: [], read: [] });
    const res = parse(await handler(put({ source_plant_ids: [A], expected_source_plant_ids: [B] })));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('the LEGACY route never sends one: its facts read is bound "not asked"', async () => {
    const patch = {
      requestContext: { http: { method: 'PATCH' } }, rawPath: `/api/inventory-items/${LOT}/source-plant`,
      headers: { authorization: 'Bearer stub-token' },
      // An old client cannot know the key; one that sends it anyway is ignored, not refused.
      body: JSON.stringify({ source_plant_id: A, expected_source_plant_ids: [B] }),
    };
    stubState.sqlHandler = (text, values) => (
      /FROM public\.garden_node p\s+WHERE p\.id = \?/.test(text) ? [{ id: values[0] }] : world()(text, values));
    const res = parse(await handler(patch));
    expect(res.status).toBe(200);
    expect(boundAt(find('facts'), 'AS ids_usable,\n               (NOT ')).toBe(false);
    for (const c of stubState.sqlCalls) expect(JSON.stringify(c.values)).not.toContain(B);
  });
});

describe('source_plant_id — the cache hint', () => {
  const HINT = 'CASE\n                 WHEN ';

  it('400s a hint that is not one of source_plant_ids, before any SQL — POST\'s rule, in POST\'s words', async () => {
    for (const [ids, hint] of [[[A, B], C], [[], A], [[A], 7], [[A], 'not-a-uuid'], [[A], { id: A }]]) {
      given();
      // eslint-disable-next-line no-await-in-loop
      const res = parse(await handler(put({ source_plant_ids: ids, source_plant_id: hint })));
      expect(res.status, JSON.stringify(hint)).toBe(400);
      expect(res.body).toEqual({ error: 'source_plant_id must be one of source_plant_ids' });
      expect(stubState.sqlCalls, JSON.stringify(hint)).toHaveLength(0);
    }
  });

  it('is bound to the cache statement, and only there, guarded by membership', async () => {
    given({ cache: [{ id: LOT, source_plant_id: B }] });
    const res = parse(await handler(put({ source_plant_ids: [A, B], source_plant_id: B })));
    expect(res.status).toBe(200);
    // The cache AFTER the write is what the statement returned — the hint, since it is a member.
    expect(res.body.source_plant_id).toBe(B);
    const cache = find('cache');
    expect([0, 1, 2].map((n) => boundAt(cache, HINT, n))).toEqual([B, B, B]);
    expect(cache.text.replace(/\s+/g, ' ')).toContain(
      "WHEN ?::uuid IS NOT NULL AND EXISTS ( SELECT 1 FROM public.seed_lot_parent_planting h WHERE h.inventory_item_id = i.id AND h.plant_id = ?::uuid AND h.role = 'seed_parent' AND h.deleted_at IS NULL) THEN ?::uuid WHEN EXISTS (");
    // Never a bare assignment of a request's id to the column.
    for (const c of stubState.sqlCalls) expect(c.text).not.toMatch(/SET source_plant_id = \?/);
  });

  it('matches a member case-insensitively and binds it lower-cased', async () => {
    const res = parse(await handler(put({ source_plant_ids: [A, B], source_plant_id: B.toUpperCase() })));
    expect(res.status).toBe(200);
    expect(boundAt(find('cache'), HINT)).toBe(B);
  });

  it('ABSENT, or null, = release 1\'s rule: the hint arm is bound NULL and can never be true', async () => {
    for (const body of [{ source_plant_ids: [A, B] }, { source_plant_ids: [A, B], source_plant_id: null }]) {
      given();
      // eslint-disable-next-line no-await-in-loop
      expect(parse(await handler(put(body))).status).toBe(200);
      expect([0, 1, 2].map((n) => boundAt(find('cache'), HINT, n))).toEqual([null, null, null]);
    }
  });

  it('rides beside an expectation and a set: all three reach the one transaction', async () => {
    given({ cache: [{ id: LOT, source_plant_id: C }] });
    const res = parse(await handler(put({
      source_plant_ids: [A, C], expected_source_plant_ids: [A], source_plant_id: C,
    })));
    expect(res.status).toBe(200);
    expect(res.body.source_plant_id).toBe(C);
    expect(kinds()).toEqual(['owns', 'pfacts', 'lock', 'hold', 'facts', 'rules', 'retire', 'add', 'cache', 'read']);
  });
});

describe('the new keys are read by VALUE in index.js — not by the presence idiom (source shape)', () => {
  // src/__tests__/SavedSeeds.storedCount.test.jsx reads index.js for
  // `hasOwnProperty.call(body, '<key>')` and requires every key it finds to be in the Saved seeds
  // list row's strip list. That is right for a column the wide PUT could one day assign. It would be
  // wrong for these: `name` is a BARE assignment in the wide PUT, so a route that read an optional
  // `name` by that idiom here would force `name` into the strip list, and the harvest-year write
  // would then send no name at all (regression seat R2-09).
  const decomment = (s) => s.split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
    .join('\n');
  const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
  const byPresence = [...new Set([...SRC.matchAll(/hasOwnProperty\.call\(body, '([^']+)'\)/g)].map((m) => m[1]))].sort();

  it('reads the three optional set-route keys with `!= null`', () => {
    expect(SRC).toMatch(/const expected = body\.expected_source_plant_ids != null\s+\? normalizeSourcePlantIds\(body\.expected_source_plant_ids, 'expected_source_plant_ids'\)\s+: null;/);
    expect(SRC).toMatch(/const cacheHint = body\.source_plant_id != null \? String\(body\.source_plant_id\)\.toLowerCase\(\) : null;/);
    expect(SRC).toMatch(/const filing = body\.filing != null \? normalizeFiling\(body\.filing\) : null;/);
  });

  it('the complete list of keys this handler reads by presence — one new this release, and it is the plant count', () => {
    // Exact, so a key added by that idiom is a decision someone made in this file rather than a
    // surprise in a client test. `seed_parent_plant_count` IS meant to be there: it is the fourth
    // /seed-measure key, and the Saved seeds strip list names it (R2A-CONTRACT section 5).
    expect(byPresence).toEqual([
      'acquired_from_source_id', 'featured_photo_id', 'seed_count', 'seed_count_estimated',
      'seed_parent_plant_count', 'seed_process', 'seed_stage', 'seed_weight_g', 'source_id',
      'source_kind', 'source_plant_id', 'source_plant_ids', 'variety_id', 'year_harvested',
    ]);
    for (const k of ['name', 'filing', 'expected_source_plant_ids', 'expect_variety_id']) {
      expect(byPresence, `${k} must not be read by the presence idiom`).not.toContain(k);
    }
  });

  it('…and neither new module uses the idiom, or the name `body`, at all', () => {
    for (const f of ['seed-lot-rules.js', 'seed-lot-filing.js']) {
      const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
      expect(src, f).not.toMatch(/hasOwnProperty/);
      // lambda/authz-write-fk.test.js scans every module here for `body.<x>_id`. The filing's two
      // ids are read off a parameter that is not called body, so its record of body-settable FKs
      // is changed only by a decision, not by a rename.
      expect(src, f).not.toMatch(/\bbody\./);
    }
  });
});
