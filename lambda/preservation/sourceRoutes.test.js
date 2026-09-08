// V5-PUTUPMULTISOURCE-001 — the /api/preservation/:id/sources handlers, EXECUTED.
//
// sourceRoutes.js imports only dependency-free siblings and takes `sql` as an argument, so vitest can
// import and RUN it. These are not text assertions about spelling: each route is invoked against a
// mock driver and the statements it issued — their text AND their bound parameters — are asserted.
// That is the difference between proving a household predicate is written and proving it is BOUND.
//
// WHAT IT STILL CANNOT DO. The mock is not Postgres. It cannot prove a CHECK fires, that the partial
// unique index holds, or that a ::cast resolves — those need a real database, and preservation_source
// does not exist in one yet. Every claim below is about what the handler SENDS. The database-side
// claims are proven separately against a real PG 17.10 instance; see the migration's own gates and
// the report for V5-PUTUPMULTISOURCE-001.
//
// TWO USERS ON EVERY OWNERSHIP ASSERTION. HOUSEHOLD is Dave and Jen; STRANGER is neither. A
// single-owner fixture cannot fail an ownership bug, because the one id it has is the one id that
// matches.
//
// LANE: the root `npm test` run (vitest run --coverage), which is blocking.
import { describe, it, expect } from 'vitest';
import { handleSourceRoute, parseSourceRoute, sourceErrorMessage } from './sourceRoutes.js';

const HOUSEHOLD = ['user_dave', 'user_jen'];
const STRANGER = ['user_stranger'];
const DAVE = 'user_dave';
const JAR = '99999999-1111-2222-3333-444444444444';
const PLANT = '11111111-1111-1111-1111-111111111111';
const HARVEST = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PATH = `/api/preservation/${JAR}/sources`;

// Records what each route SENDS. `norm` collapses whitespace so a full-literal assertion is about the
// clause and not about how the template happens to be indented.
function mockSql(queue = []) {
  const calls = [];
  const fn = (strings, ...values) => {
    const text = strings.raw.join(' ? ');
    calls.push({ text, norm: text.replace(/\s+/g, ' ').trim(), values });
    if (!queue.length) {
      return Promise.reject(new Error(`unexpected extra query: ${text.replace(/\s+/g, ' ').slice(0, 90)}`));
    }
    return Promise.resolve(queue.shift());
  };
  fn.calls = calls;
  return fn;
}

const OWNED = [{ id: JAR, user_id: DAVE }];
const garden = (over = {}) => ({
  source_kind: 'own_garden', display_label: 'Purple Petra', crop_type_slug: 'basil',
  plant_id: PLANT, ...over,
});
const bought = (over = {}) => ({
  source_kind: 'store', display_label: 'pine nuts', source_label: 'Big Y', ...over,
});

const call = (opts) => handleSourceRoute({
  rawPath: PATH, method: 'GET', rawBody: null, userId: DAVE, householdIds: HOUSEHOLD, ...opts,
});

describe('parseSourceRoute', () => {
  it('claims only /api/preservation/{uuid}/sources', () => {
    expect(parseSourceRoute(PATH)).toEqual({ kind: 'sources', id: JAR });
    expect(parseSourceRoute(`${PATH}/`)).toEqual({ kind: 'sources', id: JAR });
  });

  it('LEAVES THE LITERAL SUB-ROUTES ALONE — the reason it is safe to delegate first', () => {
    // index.js delegates this BEFORE checking 'whats-put-up' / 'use-soon'. That is only safe because
    // the uuid shape is part of the pattern. Mutation: relax the uuid test and this reds.
    expect(parseSourceRoute('/api/preservation/whats-put-up/sources')).toBeNull();
    expect(parseSourceRoute('/api/preservation/use-soon/sources')).toBeNull();
    expect(parseSourceRoute('/api/preservation')).toBeNull();
    expect(parseSourceRoute(`/api/preservation/${JAR}`)).toBeNull();
    expect(parseSourceRoute(`/api/preservation/${JAR}/sources/extra`)).toBeNull();
    expect(parseSourceRoute(null)).toBeNull();
  });

  it('returns null for a path that is not ours, so index.js falls through unchanged', () => {
    expect(parseSourceRoute('/api/kitchen-batches')).toBeNull();
  });
});

describe('ownership', () => {
  it('404s a jar outside the household, and never says "forbidden"', () => {
    // The uniform contract: absent / malformed / out-of-household / soft-deleted all answer the same.
    return call({ sql: mockSql([[]]), householdIds: STRANGER }).then((r) => {
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toMatch(/forbidden|permission/i);
    });
  });

  it('CONTROL: the same jar inside the household is served', async () => {
    // Without this the 404 above could be a handler that 404s everything.
    const sql = mockSql([OWNED, []]);
    const r = await call({ sql });
    expect(r.status).toBe(200);
    expect(r.body.sources).toEqual([]);
  });

  it('binds the household array, not the caller, on the ownership read', async () => {
    const sql = mockSql([OWNED, []]);
    await call({ sql });
    expect(sql.calls[0].norm).toMatch(/FROM preservation_log/);
    expect(sql.calls[0].norm).toMatch(/user_id = ANY\(/);
    expect(sql.calls[0].values).toContain(HOUSEHOLD);
    expect(sql.calls[0].values).not.toContain(DAVE);
  });
});

describe('GET', () => {
  it('reads live rows of this jar, in ordinal order, household-scoped', async () => {
    const rows = [{ id: 'x', ordinal: 0, display_label: 'Purple Petra' }];
    const sql = mockSql([OWNED, rows]);
    const r = await call({ sql });
    expect(r.status).toBe(200);
    expect(r.body.sources).toEqual(rows);
    const read = sql.calls[1];
    expect(read.norm).toMatch(/FROM preservation_source/);
    expect(read.norm).toMatch(/deleted_at IS NULL/);
    expect(read.norm).toMatch(/ORDER BY ordinal ASC, id ASC/);
    expect(read.values).toContain(HOUSEHOLD);
  });

  it('names its columns rather than SELECT *', async () => {
    // A SELECT * would make the L-081 contract unable to see the read surface at all.
    const sql = mockSql([OWNED, []]);
    await call({ sql });
    expect(sql.calls[1].norm).not.toMatch(/SELECT \*/);
    expect(sql.calls[1].norm).toMatch(/provenance_grade/);
    expect(sql.calls[1].norm).toMatch(/display_label/);
  });
});

describe('PUT replaces the whole list', () => {
  const put = (sources, over = {}) => call({
    method: 'PUT', rawBody: JSON.stringify({ sources }), ...over,
  });

  it('SOFT-DELETES BEFORE INSERTING, which is what lets a reorder work', async () => {
    // Replacing [A,B] with [B,A] reuses ordinals 0 and 1. Inserting first would collide with the
    // outgoing rows on uq_ps_parent_ordinal (partial on deleted_at IS NULL) and 23505.
    // Mutation: move the soft-delete after the insert loop and this reds.
    const sql = mockSql([OWNED, [], [], [], [], []]);
    await put([garden(), bought()], { sql });
    const kinds = sql.calls.slice(1).map((c) => c.norm.slice(0, 60));
    expect(kinds[0]).toMatch(/^UPDATE preservation_source SET deleted_at/);
    expect(kinds[1]).toMatch(/^INSERT INTO preservation_source/);
    expect(kinds[2]).toMatch(/^INSERT INTO preservation_source/);
  });

  it('inserts one row per source, with ordinals from array position', async () => {
    const sql = mockSql([OWNED, [], [], [], [], []]);
    await put([garden(), bought()], { sql });
    const inserts = sql.calls.filter((c) => /INSERT INTO preservation_source/.test(c.norm));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].values).toContain(0);
    expect(inserts[1].values).toContain(1);
  });

  it('copies user_id from the PARENT, not from the caller', async () => {
    // A household member editing another member's jar must not silently re-own its sources.
    const owned = [{ id: JAR, user_id: 'user_jen' }];
    const sql = mockSql([owned, [], [], [], []]);
    await put([garden()], { sql, userId: DAVE });
    const insert = sql.calls.find((c) => /INSERT INTO preservation_source/.test(c.norm));
    expect(insert.values).toContain('user_jen');
    expect(insert.values).not.toContain(DAVE);
  });

  it('WRITES THE PARENT CACHE IN THE SAME REQUEST, unconditionally', async () => {
    // The invariant the no-parent-migration decision rests on. Mutation: delete the parent UPDATE
    // and this reds — nothing else in the suite would.
    const sql = mockSql([OWNED, [], [], [], [], []]);
    await put([garden({ harvest_log_id: HARVEST }), bought()], { sql });
    const cache = sql.calls.find((c) => /UPDATE preservation_log/.test(c.norm));
    expect(cache, 'no parent cache write issued').toBeTruthy();
    expect(cache.norm).toMatch(/source_kind = \? ::text/);
    expect(cache.values).toContain('own_garden');
    expect(cache.values).toContain(PLANT);
    expect(cache.values).toContain(HARVEST);
  });

  it('caches a NON-garden primary WITHOUT its garden pointers', async () => {
    // chk_preservation_log_source_plant would 23514 the parent UPDATE otherwise. The handler cannot
    // even produce the row — sourceRowError refuses it — so this asserts the second guard.
    const sql = mockSql([OWNED, [], [], [], [], []]);
    await put([bought(), garden()], { sql });
    const cache = sql.calls.find((c) => /UPDATE preservation_log/.test(c.norm));
    expect(cache.values).toContain('store');
    expect(cache.values).toContain('Big Y');
    // The garden row is at ordinal 1, so its planting must NOT reach the parent.
    const cacheIdx = cache.values.indexOf('store');
    expect(cacheIdx).toBeGreaterThan(-1);
    expect(cache.values.slice(0, 4)).not.toContain(PLANT);
  });

  it('COALESCEs crop_type_slug and variety_id, and nothing else', async () => {
    // chk_preservation_log_attribution needs one of them non-null, so an all-bought list must not
    // null the jar's own crop. The other four are assigned unconditionally — a COALESCE there would
    // retain a pointer whose source row is now soft-deleted.
    const sql = mockSql([OWNED, [], [], [], []]);
    await put([bought()], { sql });
    const cache = sql.calls.find((c) => /UPDATE preservation_log/.test(c.norm));
    expect(cache.norm).toMatch(/crop_type_slug = COALESCE/);
    expect(cache.norm).toMatch(/variety_id = COALESCE/);
    expect(cache.norm).not.toMatch(/plant_id = COALESCE/);
    expect(cache.norm).not.toMatch(/source_kind = COALESCE/);
  });

  it('clears both sides on an explicit empty list', async () => {
    const sql = mockSql([OWNED, [], []]);
    const r = await put([], { sql });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sources: [], cleared: true });
    const cache = sql.calls.find((c) => /UPDATE preservation_log/.test(c.norm));
    expect(cache.values).toContain(null);
    // CONTROL: the clear really is a clear — no INSERT was issued.
    expect(sql.calls.some((c) => /INSERT/.test(c.norm))).toBe(false);
  });

  it('400s a bad row and writes NOTHING', async () => {
    // The refusal must precede the soft-delete, or a rejected submission destroys the existing list.
    // Mutation: move the validate below the soft-delete and this reds on the call count.
    const sql = mockSql([OWNED]);
    const r = await put([garden(), bought({ plant_id: PLANT })], { sql });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/^source 2:/);
    expect(sql.calls).toHaveLength(1);
  });

  it('400s a malformed body rather than 500ing', async () => {
    const sql = mockSql([OWNED]);
    const r = await call({ sql, method: 'PUT', rawBody: '{not json' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/valid JSON/);
  });

  it('re-reads and returns the stored list, not the submitted one', async () => {
    // The client must see what landed. Returning the echo would hide a write that partly failed.
    const stored = [{ id: 's1', ordinal: 0, display_label: 'Purple Petra' }];
    const sql = mockSql([OWNED, [], [], [], stored]);
    const r = await put([garden()], { sql });
    expect(r.body.sources).toEqual(stored);
  });
});

describe('method handling', () => {
  it('405s anything but GET and PUT', async () => {
    for (const method of ['POST', 'DELETE', 'PATCH']) {
      const r = await call({ sql: mockSql([OWNED]), method });
      expect(r.status, method).toBe(405);
    }
  });

  it('returns null — not a 404 — for a path it does not own', async () => {
    // index.js branches on null to fall through. A 404 here would swallow every other route.
    const r = await handleSourceRoute({
      sql: mockSql([]), rawPath: '/api/preservation/use-soon', method: 'GET',
      rawBody: null, userId: DAVE, householdIds: HOUSEHOLD,
    });
    expect(r).toBeNull();
  });
});

describe('sourceErrorMessage', () => {
  it('gives every chk_ps_* constraint words', () => {
    const names = [
      'chk_ps_garden_only', 'chk_ps_source_kind', 'chk_ps_provenance_grade',
      'chk_ps_label_nonblank', 'chk_ps_label_len', 'chk_ps_source_label_nonblank',
      'chk_ps_source_label_len', 'chk_ps_qty_pairing', 'chk_ps_qty_positive',
      'chk_ps_qty_unit', 'chk_ps_ordinal_nonneg',
    ];
    for (const c of names) {
      const msg = sourceErrorMessage({ code: '23514', constraint: c });
      expect(msg, c).toBeTruthy();
      // Never render the raw machine value.
      expect(msg, c).not.toMatch(/chk_|_id\b/);
    }
  });

  it('returns null for anything it does not own, so the mappers below it still run', () => {
    expect(sourceErrorMessage({ code: '23514', constraint: 'chk_preservation_log_source_plant' }))
      .toBeNull();
    expect(sourceErrorMessage({ code: '23505', constraint: 'chk_ps_garden_only' })).toBeNull();
    expect(sourceErrorMessage(null)).toBeNull();
  });
});
