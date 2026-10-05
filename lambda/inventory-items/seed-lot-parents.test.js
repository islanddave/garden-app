// V5-SEEDMULTIPARENT-001 — seed-lot-parents.js, executed.
//
// The module is dependency-free precisely so this file can import it and RUN it, rather than read
// its source: the id-array rule, the read's wire shape, and the set-replace transaction's outcomes
// are behaviour, and a regex over the source proves none of them.
//
// WHAT THIS CANNOT PROVE, said once here rather than implied by a green run: the driver is a fake
// that records SQL text and bound values and returns canned rows. Nothing below shows that a
// statement RUNS, that a guard written in SQL refuses what it should, or that the six statements
// are atomic — those need a real Postgres (the lane report lists each statement and the case an
// integration test must prove). What is pinned here is which statements are built, in what order,
// with which values bound where, and what the module concludes from each shape of result.
//
// The ownership gate (ownsEveryPlanting) is executed in lambda/authz-write-fk.test.js, beside the
// fleet's other gates; the routes are executed through the handler in source-plants-route.test.js,
// source-plant-legacy-route.test.js and post-source-plant-ids.test.js.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MAX_SOURCE_PLANTS, MULTI_PARENT_ERROR, normalizeSourcePlantIds, readSourcePlants, sourcePlantsOf,
  sourcePlantsByLot, settleSourcePlants, insertSeedParentLinks, replaceSourcePlants,
} from './seed-lot-parents.js';

const HOUSE = ['user_a', 'user_b'];
const LOT = '2d6df841-b507-4e65-8db0-97c8659df37c';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = uuid(1);
const B = uuid(2);
const C = uuid(3);

// A fake neon client: a tagged template that records text and values, plus .transaction([...]).
// `answer(text, values)` supplies each statement's rows; like the real driver, a transaction answers
// with one row array per statement, in order, or rejects as a whole.
const fakeSql = (answer = () => []) => {
  const calls = [];
  const fn = (strings, ...values) => {
    const call = { text: strings.join('?'), values };
    calls.push(call);
    return Promise.resolve().then(() => answer(call.text, values));
  };
  fn.calls = calls;
  fn.batches = [];
  fn.transaction = async (queries) => {
    fn.batches.push(queries.length);
    return Promise.all(queries);
  };
  return fn;
};

// The six statements of the set-replace transaction, each recognised by something only it says.
const IS = {
  lock: (t) => /FOR UPDATE/.test(t),
  facts: (t) => /AS live_parents/.test(t),
  retire: (t) => /UPDATE public\.seed_lot_parent_planting l/.test(t),
  add: (t) => /INSERT INTO public\.seed_lot_parent_planting/.test(t),
  cache: (t) => /UPDATE public\.inventory_items i/.test(t),
  read: (t) => /jsonb_agg/.test(t),
};
const kindOf = (t) => Object.keys(IS).find((k) => IS[k](t));

// The value bound to ONE named placeholder (the seed-lot-shape.test.js helper): the stub builds text
// as strings.join('?'), so a placeholder's value is indexed by the count of '?' before it.
const boundAfter = (call, re) => {
  const m = call.text.match(re);
  expect(m, `SQL does not match ${re}`).toBeTruthy();
  const end = m.index + m[0].length;
  expect(call.text[end], `${re} must sit immediately before a binding`).toBe('?');
  return call.values[(call.text.slice(0, end).match(/\?/g) ?? []).length];
};

const flat = (t) => t.replace(/\s+/g, ' ');
const parent = (id, name, extra = {}) => ({
  id, name, variety_id: uuid(90), variety_name: 'Jewel Mix', breeding_system: 'open_pollinated',
  archived: false, deleted: false, ...extra,
});

afterEach(() => vi.restoreAllMocks());

describe('normalizeSourcePlantIds — the id-array rule', () => {
  it('accepts an array of uuids and returns them deduped, lower-cased, in body order', () => {
    expect(normalizeSourcePlantIds([B, A])).toEqual({ ids: [B, A] });
    // Postgres reads a uuid case-insensitively, so these are ONE planting, named twice.
    expect(normalizeSourcePlantIds([A.toUpperCase(), B, A])).toEqual({ ids: [A, B] });
    expect(normalizeSourcePlantIds([])).toEqual({ ids: [] });
  });

  it('refuses a non-array outright', () => {
    for (const bad of [A, { 0: A }, 7, true, null, undefined]) {
      const out = normalizeSourcePlantIds(bad);
      expect(out.ids, JSON.stringify(bad)).toBeUndefined();
      expect(out.error).toBe('source_plant_ids must be an array of planting ids');
    }
  });

  it('refuses the WHOLE array for one element that is not a uuid — never drops it and carries on', () => {
    // Dropping the bad element would write a smaller set than the caller named and answer 200.
    for (const bad of ['not-a-uuid', '', 7, null, [A], { id: A }, `${A} `]) {
      const out = normalizeSourcePlantIds([A, bad, B]);
      expect(out.ids, JSON.stringify(bad)).toBeUndefined();
      expect(out.error).toBe('source_plant_ids must contain only planting ids');
    }
  });

  it('caps the DISTINCT count at twelve', () => {
    expect(MAX_SOURCE_PLANTS).toBe(12);
    const twelve = Array.from({ length: 12 }, (_, i) => uuid(i + 1));
    expect(normalizeSourcePlantIds(twelve).ids).toHaveLength(12);
    const thirteen = [...twelve, uuid(13)];
    expect(normalizeSourcePlantIds(thirteen).error).toBe('source_plant_ids can name at most 12 plantings');
    // After deduping, not before: the same planting thirteen times is a set of one.
    expect(normalizeSourcePlantIds(Array(13).fill(A))).toEqual({ ids: [A] });
  });
});

describe('readSourcePlants — the one parents read', () => {
  it('is one statement, with the household and the lot bound as parameters', () => {
    const sql = fakeSql();
    readSourcePlants(sql, HOUSE, LOT);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].values).toEqual([HOUSE, LOT, LOT]);
    // The list form: no lot, and the predicate collapses on the bound NULL.
    const all = fakeSql();
    readSourcePlants(all, HOUSE);
    expect(all.calls[0].values).toEqual([HOUSE, null, null]);
    expect(flat(all.calls[0].text)).toContain('(?::uuid IS NULL OR i.id = ?::uuid)');
  });

  it('projects exactly the SourcePlant shape, from the columns the views actually have', () => {
    const sql = fakeSql();
    readSourcePlants(sql, HOUSE, LOT);
    const t = flat(sql.calls[0].text);
    const built = t.match(/jsonb_build_object\((.*?)\) ORDER BY/)[1];
    // key, expression pairs, in wire order.
    expect([...built.matchAll(/'(\w+)', ((?:\([^)]*\))|[\w.]+)/g)].map((m) => [m[1], m[2]])).toEqual([
      ['id', 'l.plant_id'],
      // garden_node has NO name and NO variety_id; p.name here is BUG-SEEDDETAIL500-001 verbatim.
      ['name', 'p.display_name'],
      ['variety_id', 'p.cultivar_id'],
      ['variety_name', 'pv.display_name'],
      ['breeding_system', 'pv.breeding_system'],
      ['archived', '(p.archived_at IS NOT NULL)'],
      ['deleted', '(p.deleted_at IS NOT NULL)'],
    ]);
    expect(t).not.toMatch(/\bp\.name\b/);
    expect(t).not.toMatch(/\bp\.variety_id\b/);
    // Order: name, then id — the same order on every surface.
    expect(t).toContain(') ORDER BY p.display_name, l.plant_id) AS source_plants');
  });

  it('is ONE AGGREGATE PER LOT in a LATERAL — the link table is never joined against the lot list', () => {
    const sql = fakeSql();
    readSourcePlants(sql, HOUSE);
    const t = flat(sql.calls[0].text);
    expect(t).toMatch(/FROM public\.inventory_items i CROSS JOIN LATERAL \( SELECT jsonb_agg\(/);
    // Everything that could multiply rows is INSIDE the lateral: the outer query's FROM is the lot
    // and the lateral, nothing else.
    const outer = t.slice(t.indexOf(') sp WHERE'));
    expect(outer).not.toMatch(/\bJOIN\b/);
    expect(t.slice(0, t.indexOf('CROSS JOIN LATERAL')).match(/\bFROM\b/g)).toHaveLength(1);
    // A lot with no parents returns no row (the aggregate over nothing is NULL).
    expect(outer).toContain('AND sp.source_plants IS NOT NULL');
  });

  it('returns one element per LIVE seed_parent link row, whatever state the planting is in', () => {
    const sql = fakeSql();
    readSourcePlants(sql, HOUSE, LOT);
    const t = flat(sql.calls[0].text);
    expect(t).toContain("WHERE l.inventory_item_id = i.id AND l.role = 'seed_parent' AND l.deleted_at IS NULL");
    // LEFT joins, so neither the planting nor a missing cultivar can drop a link row…
    expect(t).toContain('LEFT JOIN public.garden_node p ON p.id = l.plant_id');
    expect(t).toContain('LEFT JOIN public.cultivar pv ON pv.id = p.cultivar_id');
    // …and NO predicate on the planting: an archived parent is still the parent
    // (BUG-SAVEDSEEDPROVENANCEARCHIVE-001) and a soft-deleted one is reported, not hidden.
    expect(t).not.toMatch(/p\.archived_at IS NULL/);
    expect(t).not.toMatch(/p\.deleted_at IS NULL/);
    expect(t).not.toMatch(/\bp\.created_by\b/);
    // Scoped through a live lot the household owns.
    expect(t).toContain('WHERE i.created_by = ANY(?) AND i.deleted_at IS NULL');
  });

  it('sourcePlantsOf and sourcePlantsByLot read its rows without assuming any came back', () => {
    const jar = [parent(A, 'Alaska Mix'), parent(B, 'Jewel Mix')];
    expect(sourcePlantsOf([{ inventory_item_id: LOT, source_plants: jar }])).toEqual(jar);
    expect(sourcePlantsOf([])).toEqual([]);          // no parents -> no row -> []
    expect(sourcePlantsOf(undefined)).toEqual([]);
    expect(sourcePlantsOf([{ inventory_item_id: LOT }])).toEqual([]);
    const byLot = sourcePlantsByLot([
      { inventory_item_id: LOT, source_plants: jar },
      { inventory_item_id: uuid(50), source_plants: null },
    ]);
    expect(byLot.get(LOT)).toEqual(jar);
    expect(byLot.has(uuid(50))).toBe(false);
    expect(sourcePlantsByLot(undefined).size).toBe(0);
  });
});

describe('settleSourcePlants — a failed parents read is null and a log line, never a throw', () => {
  it('passes rows through untouched', async () => {
    const rows = [{ inventory_item_id: LOT, source_plants: [] }];
    expect(await settleSourcePlants(Promise.resolve(rows), { item: LOT })).toBe(rows);
  });

  it('answers null — not [] — and says which read failed, by error class and code', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = Object.assign(new Error('relation "seed_lot_parent_planting" does not exist'), { code: '42P01' });
    // null means UNKNOWN. [] would tell the page "this jar has no parents", which is a different
    // and false statement.
    expect(await settleSourcePlants(Promise.reject(err), { item: LOT })).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      tag: 'inv-source-plants-failed', item: LOT, error: 'Error', code: '42P01',
      message: 'relation "seed_lot_parent_planting" does not exist',
    });
  });
});

describe('insertSeedParentLinks — the link INSERT', () => {
  it('names the role, takes the plantings from the bound array and the lot through the lot predicate', () => {
    const sql = fakeSql();
    insertSeedParentLinks(sql, { lotId: LOT, ids: [A, B], householdIds: HOUSE, userId: 'user_a' });
    expect(sql.calls).toHaveLength(1);
    const call = sql.calls[0];
    const t = flat(call.text);
    expect(t).toContain('INSERT INTO public.seed_lot_parent_planting (inventory_item_id, plant_id, role, created_by)');
    // created_by is the CALLER (who added the planting), bound; the role is a literal, never a default.
    expect(t).toContain("SELECT i.id, u.plant_id, 'seed_parent', ?::text FROM public.inventory_items i");
    expect(boundAfter(call, /'seed_parent', /)).toBe('user_a');
    expect(boundAfter(call, /CROSS JOIN unnest\(/)).toEqual([A, B]);
    expect(boundAfter(call, /WHERE i\.id = /)).toBe(LOT);
    expect(boundAfter(call, /i\.created_by = ANY\(/)).toEqual(HOUSE);
    expect(t).toContain("AND i.deleted_at IS NULL AND i.category = 'seeds'");
    // A planting that is already a live parent is skipped, by a NOT EXISTS on the same key the
    // unique index covers (lot, planting, role, live) — not by ON CONFLICT, so a concurrent
    // duplicate surfaces as 23505 instead of being swallowed.
    expect(t).toContain("AND NOT EXISTS ( SELECT 1 FROM public.seed_lot_parent_planting x WHERE x.inventory_item_id = i.id AND x.plant_id = u.plant_id AND x.role = 'seed_parent' AND x.deleted_at IS NULL)");
    expect(t).not.toMatch(/ON CONFLICT/i);
    // POST's use: legacy off.
    expect(boundAfter(call, /AND \(NOT /)).toBe(false);
  });
});

describe('replaceSourcePlants — the set-replace transaction', () => {
  // Canned rows for a lot that exists; `over` replaces one statement's answer.
  const answers = (over = {}) => (text) => {
    const k = kindOf(text);
    if (k in over) return over[k];
    return {
      lock: [{ id: LOT }],
      facts: [{ id: LOT, source_kind: null, live_parents: 1 }],
      retire: [],
      add: [],
      cache: [{ id: LOT, source_plant_id: A }],
      read: [{ inventory_item_id: LOT, source_plants: [parent(A, 'Alaska Mix')] }],
    }[k];
  };
  const run = (opts, over) => {
    const sql = fakeSql(answers(over));
    return replaceSourcePlants(sql, { lotId: LOT, ids: [A], householdIds: HOUSE, userId: 'user_a', ...opts })
      .then((out) => ({ out, sql }));
  };

  it('is ONE transaction of six statements, in the order the cache rule depends on', async () => {
    const { sql } = await run();
    // One batch: column and rows can never be written by separate transactions.
    expect(sql.batches).toEqual([6]);
    expect(sql.calls.map((c) => kindOf(c.text))).toEqual(['lock', 'facts', 'retire', 'add', 'cache', 'read']);
    // Nothing was issued outside the batch.
    expect(sql.calls).toHaveLength(6);
  });

  it('locks the lot first, and reads the facts in a LATER statement', async () => {
    const { sql } = await run();
    const [lock, facts] = sql.calls;
    expect(flat(lock.text)).toMatch(/SELECT i\.id FROM public\.inventory_items i WHERE i\.id = \? AND i\.created_by = ANY\(\?\) AND i\.deleted_at IS NULL AND i\.category = 'seeds' FOR UPDATE/);
    expect(lock.values).toEqual([LOT, HOUSE]);
    // The count is NOT a subquery of the locking statement: that one's snapshot predates its wait.
    expect(lock.text).not.toMatch(/count\(/);
    expect(facts.text).not.toMatch(/FOR UPDATE/);
    expect(flat(facts.text)).toContain("(SELECT count(*) FROM public.seed_lot_parent_planting n WHERE n.inventory_item_id = i.id AND n.role = 'seed_parent' AND n.deleted_at IS NULL)::int AS live_parents");
    expect(facts.values).toEqual([LOT, HOUSE]);
  });

  it('soft-deletes the live rows that left the set — and only those', async () => {
    const { sql } = await run({ ids: [A, B] });
    const retire = sql.calls.find((c) => IS.retire(c.text));
    const t = flat(retire.text);
    // deleted_at AND updated_at: the table has no trigger, the handler writes both.
    expect(t).toContain('SET deleted_at = now(), updated_at = now() FROM public.inventory_items i');
    expect(t).toContain("AND l.inventory_item_id = i.id AND l.role = 'seed_parent' AND l.deleted_at IS NULL AND NOT (l.plant_id = ANY(?::uuid[]))");
    expect(boundAfter(retire, /NOT \(l\.plant_id = ANY\(/)).toEqual([A, B]);
    // Never a hard delete: a removed parent is a soft-deleted row.
    for (const c of sql.calls) expect(c.text).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('sets the member cache: kept while still a member, else the earliest live row, else NULL', async () => {
    const { sql } = await run();
    const cache = sql.calls.find((c) => IS.cache(c.text));
    const t = flat(cache.text);
    expect(t).toContain("SET source_plant_id = CASE WHEN EXISTS ( SELECT 1 FROM public.seed_lot_parent_planting m WHERE m.inventory_item_id = i.id AND m.plant_id = i.source_plant_id AND m.role = 'seed_parent' AND m.deleted_at IS NULL) THEN i.source_plant_id");
    // The ELSE arm is a scalar subquery: no live row -> NULL, which is the empty-set half of the rule.
    expect(t).toContain("ELSE (SELECT e.plant_id FROM public.seed_lot_parent_planting e WHERE e.inventory_item_id = i.id AND e.role = 'seed_parent' AND e.deleted_at IS NULL ORDER BY e.created_at, e.id LIMIT 1) END, updated_at = NOW()");
    expect(t).toContain('RETURNING i.id, i.source_plant_id');
    // The cache is COMPUTED from the rows. No id from the request is ever assigned to the column.
    expect(cache.values).not.toContain(A);
  });

  it('carries the lot predicate and BOTH guards in every write statement', async () => {
    // The transaction is not interactive: a refusal cannot be an earlier read plus a decision in
    // JS, so each write re-tests the same conditions in its own WHERE.
    const { sql } = await run({ ids: [A, B], legacy: true });
    const writes = sql.calls.filter((c) => IS.retire(c.text) || IS.add(c.text) || IS.cache(c.text));
    expect(writes).toHaveLength(3);
    for (const w of writes) {
      const t = flat(w.text);
      expect(t).toContain("i.id = ? AND i.created_by = ANY(?) AND i.deleted_at IS NULL AND i.category = 'seeds'");
      expect(boundAfter(w, /i\.id = /)).toBe(LOT);
      expect(boundAfter(w, /i\.created_by = ANY\(/)).toEqual(HOUSE);
      // source_kind: a shop/gift lot refuses a non-empty set; an empty one is always allowed.
      expect(t).toContain("AND (i.source_kind IS NULL OR i.source_kind = 'own_garden' OR cardinality(?::uuid[]) = 0)");
      expect(boundAfter(w, /OR cardinality\(/)).toEqual([A, B]);
      // legacy: at most one live parent, counted inside the statement.
      expect(t).toContain("AND (NOT ?::boolean OR ( SELECT count(*) FROM public.seed_lot_parent_planting n WHERE n.inventory_item_id = i.id AND n.role = 'seed_parent' AND n.deleted_at IS NULL) <= 1)");
      expect(boundAfter(w, /AND \(NOT /)).toBe(true);
    }
  });

  it('binds the legacy guard OFF for the set route', async () => {
    const { sql } = await run({ ids: [A, B] });
    for (const w of sql.calls.filter((c) => IS.retire(c.text) || IS.add(c.text) || IS.cache(c.text))) {
      expect(boundAfter(w, /AND \(NOT /)).toBe(false);
    }
  });

  it('ok: answers the lot, its cache and the set as the transaction left it', async () => {
    const jar = [parent(A, 'Alaska Mix'), parent(B, 'Jewel Mix')];
    const { out } = await run({ ids: [A, B] }, {
      cache: [{ id: LOT, source_plant_id: A }],
      read: [{ inventory_item_id: LOT, source_plants: jar }],
    });
    expect(out).toEqual({ outcome: 'ok', id: LOT, source_plant_id: A, source_plants: jar });
  });

  it('ok on a clear: the cache is NULL and the set is []', async () => {
    const { out, sql } = await run({ ids: [] }, { cache: [{ id: LOT, source_plant_id: null }], read: [] });
    expect(out).toEqual({ outcome: 'ok', id: LOT, source_plant_id: null, source_plants: [] });
    // The empty array is what every statement was given — nothing is special-cased in JS.
    expect(boundAfter(sql.calls.find((c) => IS.retire(c.text)), /NOT \(l\.plant_id = ANY\(/)).toEqual([]);
    expect(boundAfter(sql.calls.find((c) => IS.add(c.text)), /CROSS JOIN unnest\(/)).toEqual([]);
  });

  it('not_found: no facts row means the lot is absent, foreign, deleted or not seeds', async () => {
    const { out } = await run({}, { lock: [], facts: [], cache: [], read: [] });
    expect(out).toEqual({ outcome: 'not_found' });
  });

  it('multi_parent: a LEGACY write on a lot with two or more parents is refused, with the set it has', async () => {
    const jar = [parent(A, 'Alaska Mix'), parent(B, 'Jewel Mix')];
    for (const ids of [[C], []]) {   // an id, and null (clear): both refused
      const { out } = await run({ ids, legacy: true }, {
        facts: [{ id: LOT, source_kind: null, live_parents: 2 }],
        cache: [],                    // the guard refused inside the write statements
        read: [{ inventory_item_id: LOT, source_plants: jar }],
      });
      expect(out).toEqual({ outcome: 'multi_parent', source_plant_ids: [A, B] });
    }
    expect(MULTI_PARENT_ERROR).toBe('This seed came from more than one plant. Reload the app to change which.');
  });

  it('the SAME two-parent lot is writable through the set route — the refusal is legacy-only', async () => {
    const { out } = await run({ ids: [C] }, {
      facts: [{ id: LOT, source_kind: null, live_parents: 2 }],
      cache: [{ id: LOT, source_plant_id: C }],
      read: [{ inventory_item_id: LOT, source_plants: [parent(C, 'Empress of India')] }],
    });
    expect(out.outcome).toBe('ok');
    expect(out.source_plant_id).toBe(C);
  });

  it('source_kind: a lot that says shop / gift / farm stand refuses a non-empty set', async () => {
    for (const kind of ['gift', 'store', 'farm_stand', 'other']) {
      const { out } = await run({ ids: [A] }, {
        facts: [{ id: LOT, source_kind: kind, live_parents: 0 }], cache: [], read: [],
      });
      expect(out, kind).toEqual({ outcome: 'source_kind' });
    }
  });

  it('an EMPTY set is never a source_kind refusal, whatever else refused it', async () => {
    // The one state where both guards could be in play: a shop-kind lot that nonetheless has two
    // live link rows (the drift /source-kind used to allow). The kind guard lets an empty set
    // through by design, so when a LEGACY clear writes nothing there, the reason is the two
    // parents — and the answer must be the 409 that says so, not a 400 about the kind.
    const jar = [parent(A, 'Alaska Mix'), parent(B, 'Jewel Mix')];
    const { out } = await run({ ids: [], legacy: true }, {
      facts: [{ id: LOT, source_kind: 'gift', live_parents: 2 }], cache: [],
      read: [{ inventory_item_id: LOT, source_plants: jar }],
    });
    expect(out).toEqual({ outcome: 'multi_parent', source_plant_ids: [A, B] });
  });

  it('…and own_garden, or no kind at all, does not', async () => {
    for (const kind of ['own_garden', null]) {
      const { out } = await run({ ids: [A] }, { facts: [{ id: LOT, source_kind: kind, live_parents: 0 }] });
      expect(out.outcome, String(kind)).toBe('ok');
    }
  });

  it('conflict: a 23505 from a concurrent writer rolls the batch back and is reported, not thrown', async () => {
    const dup = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505', constraint: 'uq_slpp_item_plant_role_live',
    });
    const { out } = await run({ ids: [A, B] }, {});
    expect(out.outcome).toBe('ok');
    const sql = fakeSql((text) => { if (IS.add(text)) throw dup; return answers()(text); });
    expect(await replaceSourcePlants(sql, { lotId: LOT, ids: [A, B], householdIds: HOUSE, userId: 'user_a' }))
      .toEqual({ outcome: 'conflict' });
  });

  it('any other database error is NOT swallowed', async () => {
    const boom = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    const sql = fakeSql((text) => { if (IS.cache(text)) throw boom; return answers()(text); });
    await expect(replaceSourcePlants(sql, { lotId: LOT, ids: [A], householdIds: HOUSE, userId: 'user_a' }))
      .rejects.toBe(boom);
  });

  it('conflict: nothing written and neither guard explains it', async () => {
    // Unreachable under the lock except through a writer that does not take it. The honest answer
    // is "try again", never a 200 for a write that did not happen.
    const { out } = await run({ ids: [A] }, { facts: [{ id: LOT, source_kind: null, live_parents: 1 }], cache: [] });
    expect(out).toEqual({ outcome: 'conflict' });
    const legacy = await run({ ids: [A], legacy: true }, { facts: [{ id: LOT, source_kind: null, live_parents: 1 }], cache: [] });
    expect(legacy.out).toEqual({ outcome: 'conflict' });
  });
});
