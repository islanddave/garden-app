// V5-SEEDMULTIPARENT-001 (release 2a) — re-filing a seed lot: seed-lot-filing.js executed, and
// PUT /api/inventory-items/:id/filing driven through the handler.
//
// THE ROUTE. Body { variety_id, expect_variety_id, name? }. It is a compare-and-set on the variety
// the lot is filed under:
//   stored = variety_id         200, changed: false, nothing written (a replay costs nothing);
//   stored = expect_variety_id  write -> 200, changed: true, and `previous` to undo with;
//   anything else               409 { error, code: "lot_changed", variety_id, name } — as stored now.
// 400 variety_unusable (the target is not a live variety), 400 filing_crop_mismatch (its crop differs
// from the parents' shared crop; skipped when the lot has no parents), 400 for a malformed body or a
// blank name. 404 for a lot that is absent, foreign, deleted or not seeds. It does NOT require the
// target to be the parents' mix — Undo files a lot back under what it was.
//
// The same statements serve the set route when a re-file rides beside a new parent set
// (source-plants-filing.test.js).
//
// WHAT THE STUB CANNOT SHOW. The verdict is computed in SQL (a CASE over the stored row, the target
// and the parents' crops) and the fake returns whatever verdict the test hands it. So what is proved
// here is the TEXT of that CASE — which branch is tested first, through what scope — and what the
// route does with each verdict. That the CASE reaches the right verdict for a real lot, that the
// held verdict stops the UPDATE, and that two re-files of one lot queue on the lot lock are named in
// the lane report as real-database cases.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';
import {
  VARIETY_UNUSABLE, FILING_CROP_MISMATCH, normalizeFiling, judgeFiling, fileLot, readFiling, filingOf,
  filingRefusal, fileSeedLot,
} from './seed-lot-filing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const HOUSE = ['user_a', 'user_b'];
const LOT = '2d6df841-b507-4e65-8db0-97c8659df37c';
const uuid = (n) => `3f9c1e64-1a2b-4c3d-8e4f-${String(n).padStart(12, '0')}`;
const A = uuid(1);
const B = uuid(2);
const OLD = uuid(101);      // what the lot is filed under: Alaska Mix
const MIX = uuid(103);      // what it is being moved to: the mix of Alaska and Jewel
const OTHER = uuid(104);    // what someone else re-filed it under in the meantime

const fakeSql = (answer = () => []) => {
  const calls = [];
  const fn = (strings, ...values) => {
    const call = { text: strings.join('?'), values };
    calls.push(call);
    return Promise.resolve().then(() => answer(call.text, values));
  };
  fn.calls = calls;
  fn.batches = [];
  fn.transaction = async (queries) => { fn.batches.push(queries.length); return Promise.all(queries); };
  return fn;
};
const flat = (t) => t.replace(/\s+/g, ' ').trim();
const boundAfter = (call, re) => {
  const m = call.text.match(re);
  expect(m, `SQL does not match ${re}`).toBeTruthy();
  const end = m.index + m[0].length;
  expect(call.text[end], `${re} must sit immediately before a binding`).toBe('?');
  return call.values[(call.text.slice(0, end).match(/\?/g) ?? []).length];
};

// The four statements of the filing route's transaction (and of a re-file inside the set route).
const IS = {
  judge: (t) => /AS previous_variety_id/.test(t),
  file: (t) => /SET variety_id = /.test(t),
  filed: (t) => /pv\.variety_rank, i\.name/.test(t),
  lock: (t) => /FOR UPDATE/.test(t),
};
const kindOf = (t) => Object.keys(IS).find((k) => IS[k](t)) ?? 'other';

const JUDGED = { verdict: 'write', previous_variety_id: OLD, previous_name: 'Nasturtium 2026', go: 'go' };
const FILED = { id: LOT, variety_id: MIX, variety_name: 'Alaska Mix + Jewel Mix', variety_rank: 'blend', name: 'Nasturtium 2026' };
const answers = (over = {}) => (text) => {
  const k = kindOf(text);
  if (k in over) return typeof over[k] === 'function' ? over[k]() : over[k];
  return { lock: [{ id: LOT }], judge: [JUDGED], file: [{ id: LOT }], filed: [FILED], other: [] }[k];
};

afterEach(() => vi.restoreAllMocks());

describe('normalizeFiling — the body rule, one for both doors', () => {
  it('accepts the two ids and returns them lower-cased, with no name to change', () => {
    expect(normalizeFiling({ variety_id: MIX.toUpperCase(), expect_variety_id: OLD }))
      .toEqual({ varietyId: MIX, expectVarietyId: OLD, name: null });
  });

  it('accepts a name and stores it TRIMMED, as POST does', () => {
    expect(normalizeFiling({ variety_id: MIX, expect_variety_id: OLD, name: '  Nasturtium mix 2026 ' }).name)
      .toBe('Nasturtium mix 2026');
  });

  it('a null name is an absent name: leave it alone', () => {
    expect(normalizeFiling({ variety_id: MIX, expect_variety_id: OLD, name: null }).name).toBeNull();
    expect(normalizeFiling({ variety_id: MIX, expect_variety_id: OLD }).name).toBeNull();
  });

  it('400s a name that is present and blank, or not a string — never read as "leave it"', () => {
    for (const name of ['', '   ', '\n\t', 7, true, ['x'], { n: 1 }]) {
      const out = normalizeFiling({ variety_id: MIX, expect_variety_id: OLD, name });
      expect(out, JSON.stringify(name)).toEqual({ error: 'name must not be blank when it is sent' });
    }
  });

  it('requires BOTH ids, as uuids — a non-uuid must never reach Postgres (22P02 is an opaque 500)', () => {
    for (const bad of [undefined, null, '', 'not-a-uuid', 7, [MIX], `${MIX} `]) {
      expect(normalizeFiling({ variety_id: bad, expect_variety_id: OLD }).error, JSON.stringify(bad))
        .toBe('variety_id must be the id of the variety to file this seed under');
      expect(normalizeFiling({ variety_id: MIX, expect_variety_id: bad }).error, JSON.stringify(bad))
        .toBe('expect_variety_id must be the id of the variety this seed is filed under now');
    }
  });

  it('400s anything that is not an object', () => {
    for (const bad of [undefined, null, 'x', 7, [], [{ variety_id: MIX }]]) {
      expect(normalizeFiling(bad), JSON.stringify(bad)).toEqual({ error: 'variety_id and expect_variety_id are required' });
    }
  });

  it('ignores every other key — it cannot be used to carry a parent, a count or anything else', () => {
    const out = normalizeFiling({
      variety_id: MIX, expect_variety_id: OLD, source_plant_ids: [A], seed_parent_plant_count: 3, category: 'tools',
    });
    expect(Object.keys(out).sort()).toEqual(['expectVarietyId', 'name', 'varietyId']);
  });
});

describe('judgeFiling — the verdict, as the statement computes it', () => {
  const build = (opts = {}) => {
    const sql = fakeSql();
    judgeFiling(sql, { lotId: LOT, householdIds: HOUSE, varietyId: MIX, expectVarietyId: OLD, ...opts });
    expect(sql.calls).toHaveLength(1);
    return sql.calls[0];
  };

  it('answers the verdict, what the lot holds before the write, and the held go — and writes nothing', () => {
    const call = build({ alone: true });
    expect(flat(call.text)).toMatch(/^SELECT v\.verdict, v\.previous_variety_id, v\.previous_name, set_config\('app\.seed_lot_go', /);
    expect(call.text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(call.text).not.toMatch(/FOR (UPDATE|SHARE|KEY SHARE|NO KEY UPDATE)/);
  });

  it('judges in THIS order: already there, changed by someone else, unusable target, wrong crop, write', () => {
    // The order is the contract. A replay (stored = target) is answered before anything is asked of
    // the target; a stale caller is told so before being told its target is wrong.
    const t = flat(build().text);
    const at = (s) => { const i = t.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    const same = at("WHEN i.variety_id = ?::uuid THEN 'same'");
    const changed = at("WHEN i.variety_id IS DISTINCT FROM ?::uuid THEN 'changed'");
    const unusable = at("WHEN fv.id IS NULL THEN 'unusable'");
    const crop = at("THEN 'crop'");
    const write = at("ELSE 'write' END AS verdict");
    expect([same, changed, unusable, crop, write]).toEqual([same, changed, unusable, crop, write].slice().sort((a, b) => a - b));
    // Target first, then what the caller expected: bound in that order.
    expect(boundAfter(build(), /WHEN i\.variety_id = /)).toBe(MIX);
    expect(boundAfter(build(), /WHEN i\.variety_id IS DISTINCT FROM /)).toBe(OLD);
  });

  it('UNUSABLE = no live variety with that id. Not household-scoped: varieties are a shared catalogue', () => {
    const call = build();
    const t = flat(call.text);
    expect(t).toContain('LEFT JOIN public.cultivar fv ON fv.id = ?::uuid AND fv.deleted_at IS NULL WHERE i.id = ?');
    expect(boundAfter(call, /ON fv\.id = /)).toBe(MIX);
    expect(t).not.toMatch(/\bfv\.created_by\b/);
  });

  it('CROP = the parents\' varieties share ONE crop and the target\'s differs from it (NULL is one value of its own)', () => {
    const t = flat(build().text);
    // count(*) = 1: exactly one distinct crop among the parents' varieties — none (no parents, or
    // none with a variety) or several (a drifted jar) and there is no shared crop to differ from.
    // IS DISTINCT FROM: NULL equals NULL, and differs from every named crop.
    expect(t).toContain(
      'WHEN (SELECT count(*) = 1 AND bool_or(d.crop IS DISTINCT FROM fv.crop_type_slug) FROM (SELECT DISTINCT pv.crop_type_slug AS crop FROM public.garden_node p JOIN public.cultivar pv ON pv.id = p.cultivar_id WHERE p.created_by = ANY(?)');
    // A soft-deleted variety still counts as a parent's variety.
    expect(t).not.toMatch(/\bpv\.deleted_at\b/);
  });

  it('on the filing route the parents are the lot\'s LIVE seed_parent rows as they stand', () => {
    const call = build({ alone: true });
    const t = flat(call.text);
    expect(t).toContain(
      "OR (NOT ?::boolean AND EXISTS ( SELECT 1 FROM public.seed_lot_parent_planting l WHERE l.inventory_item_id = i.id AND l.plant_id = p.id AND l.role = 'seed_parent' AND l.deleted_at IS NULL))");
    // alone; target; expected; household; "of this write" false, no set, false again; target; lot; household.
    expect(call.values).toEqual([true, MIX, OLD, HOUSE, false, [], false, MIX, LOT, HOUSE]);
  });

  it('inside the set route the parents are the set THAT write is making', () => {
    const call = build({ ids: [A, B] });
    expect(flat(call.text)).toContain('AND ((?::boolean AND p.id = ANY(?::uuid[]))');
    expect(call.values).toEqual([false, MIX, OLD, HOUSE, true, [A, B], true, MIX, LOT, HOUSE]);
    // An EMPTY set is still "the set this write is making": a jar being cleared has no parents to
    // differ from, whatever its stored rows are.
    expect(build({ ids: [] }).values.slice(4, 7)).toEqual([true, [], true]);
  });

  it('holds the verdict: go only for write or same, and only if everything judged before it said go', () => {
    const call = build();
    expect(flat(call.text)).toContain(
      "CASE WHEN v.verdict IN ('write', 'same') AND (?::boolean OR current_setting('app.seed_lot_go', true) = 'go') THEN 'go' ELSE 'stop' END, true) AS go");
    expect(boundAfter(call, /AND \(/)).toBe(false);
    expect(boundAfter(build({ alone: true }), /AND \(/)).toBe(true);
  });

  it('reads the lot through the whole lot predicate', () => {
    const call = build();
    expect(flat(call.text)).toMatch(/WHERE i\.id = \? AND i\.created_by = ANY\(\?\) AND i\.deleted_at IS NULL AND i\.category = 'seeds' \) v$/);
    expect(boundAfter(call, /WHERE i\.id = /)).toBe(LOT);
  });
});

describe('fileLot — the ONE statement that re-files a lot', () => {
  it('sets the variety, keeps the name unless one was sent, and bumps updated_at', () => {
    const sql = fakeSql();
    fileLot(sql, { lotId: LOT, householdIds: HOUSE, varietyId: MIX, name: 'Nasturtium mix 2026' });
    expect(flat(sql.calls[0].text)).toBe(
      "UPDATE public.inventory_items i SET variety_id = ?::uuid, name = COALESCE(?::text, i.name), updated_at = NOW() WHERE i.id = ? AND i.created_by = ANY(?) AND i.deleted_at IS NULL AND i.category = 'seeds' AND current_setting('app.seed_lot_go', true) = 'go' AND i.variety_id IS DISTINCT FROM ?::uuid RETURNING i.id");
    expect(sql.calls[0].values).toEqual([MIX, 'Nasturtium mix 2026', LOT, HOUSE, MIX]);
    // No name sent: NULL is bound and COALESCE keeps what is stored.
    const keep = fakeSql();
    fileLot(keep, { lotId: LOT, householdIds: HOUSE, varietyId: MIX });
    expect(keep.calls[0].values).toEqual([MIX, null, LOT, HOUSE, MIX]);
  });

  it('writes only on the held verdict, and never touches a lot already filed there', () => {
    const sql = fakeSql();
    fileLot(sql, { lotId: LOT, householdIds: HOUSE, varietyId: MIX });
    const t = flat(sql.calls[0].text);
    // It re-derives nothing: no expected variety, no crop, no liveness test of its own.
    expect(t).not.toMatch(/cultivar|garden_node|seed_lot_parent_planting/);
    expect(sql.calls[0].values).not.toContain(OLD);
    // "Same" in the statement's own terms: nothing to write, so no updated_at bump either.
    expect(t).toContain('AND i.variety_id IS DISTINCT FROM ?::uuid RETURNING i.id');
  });

  it('is the only statement in this directory that assigns variety_id outside the wide PUT and the INSERT', () => {
    const decomment = (s) => s.split('\n')
      .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
      .join('\n');
    const assigning = ['index.js', 'seed-lot-parents.js', 'seed-lot-rules.js', 'seed-lot-filing.js'].flatMap((f) => {
      const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
      return [...src.matchAll(/sql`[^`]*`/g)].map((m) => m[0])
        .filter((s) => /(^|[\s,])variety_id\s*=\s*(CASE|\$\{)/.test(s) && /\bUPDATE\b/.test(s))
        .map(() => f);
    });
    // The wide PUT (which now keeps a parented lot's stored variety) and this.
    expect(assigning.sort()).toEqual(['index.js', 'seed-lot-filing.js']);
  });
});

describe('readFiling, filingOf, filingRefusal', () => {
  it('reads the lot\'s filing with the variety\'s name and rank, through the lot predicate', () => {
    const sql = fakeSql();
    readFiling(sql, { lotId: LOT, householdIds: HOUSE });
    expect(flat(sql.calls[0].text)).toBe(
      "SELECT i.id, i.variety_id, pv.display_name AS variety_name, pv.variety_rank, i.name FROM public.inventory_items i LEFT JOIN public.cultivar pv ON pv.id = i.variety_id WHERE i.id = ? AND i.created_by = ANY(?) AND i.deleted_at IS NULL AND i.category = 'seeds'");
    expect(sql.calls[0].values).toEqual([LOT, HOUSE]);
  });

  it('builds the reply: what it is filed under now, whether this request changed it, and what it was', () => {
    expect(filingOf([FILED], JUDGED, true)).toEqual({
      variety_id: MIX, variety_name: 'Alaska Mix + Jewel Mix', variety_rank: 'blend', name: 'Nasturtium 2026',
      changed: true, previous: { variety_id: OLD, name: 'Nasturtium 2026' },
    });
    // Every key is always present — null, never missing — so a client can destructure the reply.
    expect(filingOf([], null, false)).toEqual({
      variety_id: null, variety_name: null, variety_rank: null, name: null, changed: false,
      previous: { variety_id: null, name: null },
    });
  });

  it('names the refusal for each verdict that is one, and nothing for the two that are not', () => {
    expect(filingRefusal({ verdict: 'changed' })).toBe('lot_changed');
    expect(filingRefusal({ verdict: 'unusable' })).toBe('variety_unusable');
    expect(filingRefusal({ verdict: 'crop' })).toBe('filing_crop_mismatch');
    for (const verdict of ['write', 'same', undefined, 'something-else']) expect(filingRefusal({ verdict })).toBeNull();
    expect(filingRefusal(null)).toBeNull();
  });
});

describe('fileSeedLot — the filing route\'s transaction', () => {
  const run = async (over, opts = {}) => {
    const sql = fakeSql(answers(over));
    const out = await fileSeedLot(sql, { lotId: LOT, householdIds: HOUSE, varietyId: MIX, expectVarietyId: OLD, ...opts });
    return { out, sql };
  };

  it('is ONE transaction of four statements: lock the lot, judge, file, read back', async () => {
    const { sql } = await run();
    expect(sql.batches).toEqual([4]);
    expect(sql.calls.map((c) => kindOf(c.text))).toEqual(['lock', 'judge', 'file', 'filed']);
    expect(sql.calls).toHaveLength(4);
  });

  it('locks the LOT first, with the lock the parents write and the planting merge take first', async () => {
    const { sql } = await run();
    expect(flat(sql.calls[0].text)).toBe(
      "SELECT i.id FROM public.inventory_items i WHERE i.id = ? AND i.created_by = ANY(?) AND i.deleted_at IS NULL AND i.category = 'seeds' FOR UPDATE");
    // The judge is a separate statement AFTER it: a subquery in the locking statement would read
    // the snapshot taken before the wait.
    expect(sql.calls[0].text).not.toMatch(/variety_id|cultivar/);
    // No planting is locked: nothing here can deadlock against a planting-side writer.
    for (const c of sql.calls) expect(c.text).not.toMatch(/FOR SHARE/);
    expect(sql.calls.filter((c) => /FOR UPDATE/.test(c.text))).toHaveLength(1);
  });

  it('judges ALONE (it starts the verdict) and against the lot\'s stored parents', async () => {
    const { sql } = await run();
    expect(sql.calls[1].values).toEqual([true, MIX, OLD, HOUSE, false, [], false, MIX, LOT, HOUSE]);
  });

  it('ok, changed: the filing as the transaction left it, and what it was before', async () => {
    const { out } = await run();
    expect(out).toEqual({
      outcome: 'ok', id: LOT,
      filing: {
        variety_id: MIX, variety_name: 'Alaska Mix + Jewel Mix', variety_rank: 'blend', name: 'Nasturtium 2026',
        changed: true, previous: { variety_id: OLD, name: 'Nasturtium 2026' },
      },
    });
  });

  it('ok, UNCHANGED: already filed there — nothing written, previous is what it is', async () => {
    const { out } = await run({
      judge: [{ verdict: 'same', previous_variety_id: MIX, previous_name: 'Nasturtium 2026', go: 'go' }], file: [],
    });
    expect(out.outcome).toBe('ok');
    expect(out.filing.changed).toBe(false);
    expect(out.filing.previous).toEqual({ variety_id: MIX, name: 'Nasturtium 2026' });
  });

  it('carries the name to the write, and only there', async () => {
    const { sql } = await run({}, { name: 'Nasturtium mix 2026' });
    expect(sql.calls[2].values).toEqual([MIX, 'Nasturtium mix 2026', LOT, HOUSE, MIX]);
    for (const c of [sql.calls[0], sql.calls[1], sql.calls[3]]) expect(c.values).not.toContain('Nasturtium mix 2026');
  });

  it('not_found: no judged row means the lot is absent, foreign, deleted or not seeds', async () => {
    expect((await run({ lock: [], judge: [], file: [], filed: [] })).out).toEqual({ outcome: 'not_found' });
  });

  it('lot_changed: someone else re-filed it — what it is filed under NOW, and its name', async () => {
    const { out } = await run({
      judge: [{ verdict: 'changed', previous_variety_id: OTHER, previous_name: 'Renamed jar', go: 'stop' }], file: [],
    });
    expect(out).toEqual({ outcome: 'lot_changed', variety_id: OTHER, name: 'Renamed jar' });
  });

  it('variety_unusable and filing_crop_mismatch: nothing written, nothing else said', async () => {
    for (const [verdict, outcome] of [['unusable', 'variety_unusable'], ['crop', 'filing_crop_mismatch']]) {
      const { out } = await run({ judge: [{ ...JUDGED, verdict, go: 'stop' }], file: [] });
      expect(out, verdict).toEqual({ outcome });
    }
  });

  it('conflict: the verdict said write and nothing was written — never a 200 for a write that did not happen', async () => {
    expect((await run({ file: [] })).out).toEqual({ outcome: 'conflict' });
  });

  it('conflict: a 40P01 deadlock victim, logged by code; any other error is not swallowed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dead = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    for (const at of ['lock', 'judge', 'file']) {
      // eslint-disable-next-line no-await-in-loop
      const { out } = await run({ [at]: () => { throw dead; } });
      expect(out, at).toEqual({ outcome: 'conflict' });
    }
    expect(JSON.parse(warn.mock.calls[0][0])).toEqual({ tag: 'inv-filing-retry', item: LOT, code: '40P01' });
    const boom = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    await expect(run({ judge: () => { throw boom; } })).rejects.toBe(boom);
    // A 23514 (a CHECK) is the handler-wide catch block's to answer, as for every route here.
    const check = Object.assign(new Error('violates check'), { code: '23514', constraint: 'chk_inventory_seed_requires_variety' });
    await expect(run({ file: () => { throw check; } })).rejects.toBe(check);
  });
});

describe('PUT /api/inventory-items/:id/filing — through the handler', () => {
  const put = (body, id = LOT, method = 'PUT') => ({
    requestContext: { http: { method } },
    rawPath: `/api/inventory-items/${id}/filing`,
    headers: { authorization: 'Bearer stub-token' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });
  const kinds = () => stubState.sqlCalls.map((c) => kindOf(c.text));
  const given = (over) => {
    resetStubs();
    stubState.verifyTokenResult = { sub: USER };
    stubState.sqlHandler = (text) => answers(over)(text);
  };
  const BODY = { variety_id: MIX, expect_variety_id: OLD };
  const LOT_CHANGED = 'This seed lot was changed at the same moment. Reload and try again.';

  beforeEach(() => {
    given();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('200: files the lot, and answers exactly the contract\'s keys', async () => {
    const res = parse(await handler(put(BODY)));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: LOT, variety_id: MIX, variety_name: 'Alaska Mix + Jewel Mix', variety_rank: 'blend', name: 'Nasturtium 2026',
      changed: true, previous: { variety_id: OLD, name: 'Nasturtium 2026' },
    });
    expect(kinds()).toEqual(['lock', 'judge', 'file', 'filed']);
    // The caller's household, the route's lot.
    expect(stubState.sqlCalls[0].values).toEqual([LOT, [USER]]);
  });

  it('200 changed:false when the lot is already filed there — a replay is not an error', async () => {
    given({
      judge: [{ verdict: 'same', previous_variety_id: MIX, previous_name: 'Nasturtium 2026', go: 'go' }], file: [],
    });
    const res = parse(await handler(put(BODY)));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: LOT, variety_id: MIX, changed: false, previous: { variety_id: MIX, name: 'Nasturtium 2026' } });
  });

  it('UNDO from `previous`: the reply of one re-file is the body of the one that takes it back', async () => {
    const first = parse(await handler(put(BODY))).body;
    // Undo: target = what it was, expected = what it is now, and the name it had.
    const undo = { variety_id: first.previous.variety_id, expect_variety_id: first.variety_id, name: first.previous.name };
    given({
      judge: [{ verdict: 'write', previous_variety_id: MIX, previous_name: 'Nasturtium 2026', go: 'go' }],
      filed: [{ id: LOT, variety_id: OLD, variety_name: 'Alaska Mix', variety_rank: 'cultivar', name: 'Nasturtium 2026' }],
    });
    const res = parse(await handler(put(undo)));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ variety_id: OLD, variety_rank: 'cultivar', changed: true, previous: { variety_id: MIX } });
    // It asked for OLD expecting MIX — and nothing requires OLD to be the parents' mix.
    const judge = stubState.sqlCalls[1];
    expect(judge.values.slice(1, 3)).toEqual([OLD, MIX]);
    const file = stubState.sqlCalls[2];
    expect(file.values).toEqual([OLD, 'Nasturtium 2026', LOT, [USER], OLD]);
    expect(file.text).not.toMatch(/blend_key/);
    expect(judge.text).not.toMatch(/blend_key/);
  });

  it('409 lot_changed, with the variety and name AS STORED, when someone else re-filed it first', async () => {
    given({
      judge: [{ verdict: 'changed', previous_variety_id: OTHER, previous_name: 'Renamed jar', go: 'stop' }], file: [],
    });
    const res = parse(await handler(put(BODY)));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: LOT_CHANGED, code: 'lot_changed', variety_id: OTHER, name: 'Renamed jar' });
  });

  it('400 variety_unusable; 400 filing_crop_mismatch — each a sentence and a code, nothing more', async () => {
    given({ judge: [{ ...JUDGED, verdict: 'unusable', go: 'stop' }], file: [] });
    let res = parse(await handler(put(BODY)));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: VARIETY_UNUSABLE, code: 'variety_unusable' });
    given({ judge: [{ ...JUDGED, verdict: 'crop', go: 'stop' }], file: [] });
    res = parse(await handler(put(BODY)));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: FILING_CROP_MISMATCH, code: 'filing_crop_mismatch' });
    for (const sentence of [VARIETY_UNUSABLE, FILING_CROP_MISMATCH]) expect(sentence).not.toMatch(/_id\b|variety_id|crop_type|uuid/i);
  });

  it('400s a malformed body before any SQL: missing or non-uuid ids, a blank name', async () => {
    const cases = [
      [{}, 'variety_id must be the id of the variety to file this seed under'],
      [{ variety_id: MIX }, 'expect_variety_id must be the id of the variety this seed is filed under now'],
      [{ variety_id: 'nope', expect_variety_id: OLD }, 'variety_id must be the id of the variety to file this seed under'],
      [{ ...BODY, name: '   ' }, 'name must not be blank when it is sent'],
      [{ ...BODY, name: 7 }, 'name must not be blank when it is sent'],
      [[], 'variety_id and expect_variety_id are required'],
      [undefined, 'variety_id must be the id of the variety to file this seed under'],
    ];
    for (const [body, message] of cases) {
      given();
      // eslint-disable-next-line no-await-in-loop
      const res = parse(await handler(put(body)));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toEqual({ error: message });
      expect(stubState.sqlCalls, JSON.stringify(body)).toHaveLength(0);
    }
  });

  it('404 for a lot that is absent, foreign, deleted or not seeds — all four the same way', async () => {
    given({ lock: [], judge: [], file: [], filed: [] });
    const res = parse(await handler(put(BODY)));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('every statement that names the lot row carries the WHOLE lot predicate, so "not seeds" is theirs to refuse', async () => {
    await handler(put(BODY));
    expect(stubState.sqlCalls).toHaveLength(4);
    for (const c of stubState.sqlCalls) {
      expect(c.text.replace(/\s+/g, ' '), kindOf(c.text)).toContain(
        "i.id = ? AND i.created_by = ANY(?) AND i.deleted_at IS NULL AND i.category = 'seeds'");
    }
  });

  it('404 for a malformed lot id, without sending it to Postgres', async () => {
    const res = parse(await handler(put(BODY, 'not-a-uuid')));
    expect(res.status).toBe(404);
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('409 lot_changed for a deadlock victim; a CHECK still reads as its sentence', async () => {
    given({ file: () => { throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); } });
    let res = parse(await handler(put(BODY)));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: LOT_CHANGED, code: 'lot_changed' });
    given({ file: () => { throw Object.assign(new Error('check'), { code: '23514', constraint: 'chk_inventory_seed_requires_variety' }); } });
    res = parse(await handler(put(BODY)));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('A seed lot has to name a variety. Pick one before saving.');
  });

  it('is PUT-only — every other verb is 405 before any SQL', async () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      given();
      // eslint-disable-next-line no-await-in-loop
      const res = parse(await handler(put(BODY, LOT, method)));
      expect(res.status, method).toBe(405);
      expect(stubState.sqlCalls, method).toHaveLength(0);
    }
  });

  it('is matched ABOVE the generic /:id arm, and no sibling route\'s pattern can catch its path', () => {
    const src = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
    const own = src.indexOf('const filingMatch = rawPath.match');
    expect(own).toBeGreaterThan(-1);
    expect(own).toBeLessThan(src.indexOf('const idMatch = rawPath.match'));
    const re = (name) => new RegExp(src.match(new RegExp(`const ${name} = rawPath\\.match\\(/(.*?)/\\);`))[1]);
    const path = `/api/inventory-items/${LOT}/filing`;
    expect(re('filingMatch').test(path)).toBe(true);
    for (const other of ['idMatch', 'sourcePlantsMatch', 'sourcePlantMatch', 'sourceKindMatch', 'seedMeasureMatch', 'seedStageMatch', 'sowArchiveMatch']) {
      expect(re(other).test(path), other).toBe(false);
    }
    expect(re('filingMatch').test(`/api/inventory-items/${LOT}/filing/extra`)).toBe(false);
    expect(re('filingMatch').test(`/api/inventory-items/${LOT}`)).toBe(false);
  });

  it('writes nothing but the lot\'s variety and name: no parent, no cache, no link row, no count', async () => {
    await handler(put({ ...BODY, name: 'Nasturtium mix 2026', source_plant_ids: [A], seed_parent_plant_count: 4 }));
    const writes = stubState.sqlCalls.filter((c) => /^\s*(UPDATE|INSERT|DELETE)\b/.test(c.text));
    expect(writes).toHaveLength(1);
    expect(writes[0].text.replace(/\s+/g, ' ')).toContain('SET variety_id = ?::uuid, name = COALESCE(?::text, i.name), updated_at = NOW() WHERE');
    for (const c of stubState.sqlCalls) {
      expect(JSON.stringify(c.values)).not.toContain(A);
      expect(c.text).not.toMatch(/source_plant_id|seed_parent_plant_count/);
    }
  });
});
