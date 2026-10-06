// V5-VARIETYBLEND-001 — POST /api/varieties/blend, the named mix (R2A-CONTRACT section 2).
//
// WHY THESE RUN THE HANDLER, per source-routes.test.js: the route is a chain of decisions between
// reads — refuse, preview, hand back, revive, create, find again, rename — and no regex over the
// source can see which one an input takes. The mock is that file's mock plus a small in-memory
// table, so "found", "soft-deleted" and "the name is taken" are states the fake holds rather than
// answers a test hard-codes per statement.
//
// WHAT THESE DO NOT PROVE, stated here rather than left to be discovered: the unit suite is MOCK-SQL.
// Nothing below reaches Postgres, so these prove the handler ISSUES the right statements with the
// right bindings in the right order — not that the cultivar view accepts the INSERT, not that the
// two unique indexes raise what the fake raises, not that the transaction rolls back (the fake's
// transaction is Promise.all and does not). Those are tests/integration/variety-blend.int.test.js's.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';
import {
  parseBlendBody, flattenLeafIds, blendKey, sortLeaves, automaticBlendName, distinctCrops, birthFacts,
  componentOf, restoreConflictMessage, BLEND_PROFILE, BLEND_ERRORS, NAME_SUFFIXES,
  MAX_BLEND_LEAVES, MAX_COMPONENT_IDS, RESTORE_CONFLICT_MESSAGES, RESTORE_CONFLICT_DEFAULT,
} from './blend.js';

vi.mock('@neondatabase/serverless', async () => {
  const { stubState: state } = await import('../_test-stubs/state.js');
  return {
    neon: () => {
      const tagged = async (strings, ...values) => {
        const text = Array.isArray(strings) ? strings.join('?') : String(strings);
        state.sqlCalls.push({ text, values });
        return state.sqlHandler(text, values);
      };
      // Each element is an already-running statement promise, so sqlCalls keeps the array's order.
      // A statement that throws rejects the whole transaction, as Postgres would.
      tagged.transaction = (stmts) => Promise.all(stmts);
      return tagged;
    },
  };
});

const { handler } = await import('./index.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — see admin-source-id.test.js.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const BLEND_SRC = decomment(readFileSync(resolve(__dirname, 'blend.js'), 'utf8'));
const INDEX_SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

const USER = 'user_stub_owner';
const MATE = 'user_stub_housemate';
const STRANGER = 'user_someone_else';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// u(1) < u(2) < ... in uuid order, so a key is readable at a glance.
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const keyOf = (...ns) => ns.map(u).sort().join(',');

const isRateLimit = (t) => t.includes('INSERT INTO public.rate_limit_buckets');
const isSetConfig = (t) => t.includes('set_config');
const isBlendInsert = (t) => t.includes('INSERT INTO public.cultivar');
const isComponentInsert = (t) => t.includes('INSERT INTO public.variety_blend_component');
const isProfileInsert = (t) => t.includes('INSERT INTO public.care_profile');
const isRevive = (t) => t.includes('UPDATE public.cultivar');
const isFind = (t) => /FROM public\.cultivar\s+WHERE blend_key = \?/.test(t);
const isRead = (t) => /FROM public\.cultivar\s+WHERE id = ANY\(\?::uuid\[\]\)/.test(t);
const isWrite = (t) => /\b(INSERT|UPDATE|DELETE)\b/.test(t) || isSetConfig(t);

const unique = (constraint) => Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), { code: '23505', constraint });

// The table. `varieties` are the rows that exist before the request; every write the route issues
// lands here, and the two unique indexes are emulated as the migrations define them:
//   uq_plant_varieties_name_species            (lower(name), COALESCE(species,'')) WHERE deleted_at IS NULL — all users
//   uq_plant_varieties_creator_blend_key_live  (created_by, blend_key) WHERE blend_key IS NOT NULL AND deleted_at IS NULL
let seq = 0;
function db({ varieties = [], allowRate = true, onInsert = null } = {}) {
  const rows = new Map();
  for (const v of varieties) {
    rows.set(v.id, {
      variety_rank: null, crop_type_slug: null, blend_key: null, deleted_at: null, species: null,
      genus: null, lifecycle: null, scoville_min: null, scoville_max: null, created_by: STRANGER,
      created_at: `2026-01-01T00:00:${String(seq++ % 60).padStart(2, '0')}Z`, ...v,
    });
  }
  const state = { rows, components: [], profiles: [] };
  const liveClash = (row, selfId) => {
    for (const r of rows.values()) {
      if (r.id === selfId || r.deleted_at) continue;
      if (r.name.toLowerCase() === row.name.toLowerCase() && (r.species ?? '') === (row.species ?? '')) {
        throw unique('uq_plant_varieties_name_species');
      }
      if (row.blend_key && r.blend_key === row.blend_key && r.created_by === row.created_by) {
        throw unique('uq_plant_varieties_creator_blend_key_live');
      }
    }
  };
  stubState.sqlHandler = (text, values) => {
    if (isRateLimit(text)) return allowRate ? [{ count: 1 }] : [];
    if (isSetConfig(text)) return [{ set_config: values[0] }];
    if (isBlendInsert(text)) {
      const [id, name, created_by, blend_key, crop_type_slug, species, genus, lifecycle, scoville_min, scoville_max, scoville_source] = values;
      if (onInsert) onInsert(state, { id, name });
      const row = {
        id, name, created_by, blend_key, crop_type_slug, species, genus, lifecycle, scoville_min,
        scoville_max, scoville_source, variety_rank: 'blend', deleted_at: null, created_at: '2026-10-06T00:00:00Z',
      };
      liveClash(row, id);
      rows.set(id, row);
      return [{ id }];
    }
    if (isComponentInsert(text)) {
      const [blend, createdBy, leafIds] = values;
      for (const c of leafIds) state.components.push({ blend_variety_id: blend, component_variety_id: c, created_by: createdBy });
      return [];
    }
    if (isProfileInsert(text)) {
      state.profiles.push({ scope_id: values[0], profile: JSON.parse(values[1]) });
      return [];
    }
    if (isRevive(text)) {
      const [name, id, household] = values;
      const row = rows.get(id);
      if (!row || !row.deleted_at || !household.includes(row.created_by)) return [];
      liveClash({ ...row, name: name ?? row.name }, id);
      row.deleted_at = null;
      if (name != null) row.name = name;
      return [{ id, deleted_at: null }];
    }
    if (isFind(text)) {
      const [key, household] = values;
      return [...rows.values()]
        .filter((r) => r.blend_key === key && household.includes(r.created_by))
        .sort((a, b) => (Number(!!a.deleted_at) - Number(!!b.deleted_at))
          || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)
          || (a.id < b.id ? -1 : 1))
        .slice(0, 1)
        .map((r) => ({ ...r }));
    }
    if (isRead(text)) return values[0].map((id) => rows.get(id)).filter(Boolean).map((r) => ({ ...r }));
    return [];   // applyDerive's reads, fail-open
  };
  return state;
}

const call = (method, rawPath, body) => handler({
  requestContext: { http: { method } },
  rawPath,
  headers: { authorization: 'Bearer stub-token' },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });
const blend = async (ids, create, extra = {}) => parse(await call('POST', '/api/varieties/blend', { component_variety_ids: ids, create, ...extra }));
const calls = (pred) => stubState.sqlCalls.filter((c) => pred(c.text));

const leaf = (n, name, more = {}) => ({ id: u(n), name, ...more });
const CARMEN = leaf(1, 'Carmen', { crop_type_slug: 'pepper', species: 'annuum', genus: 'Capsicum' });
const JIMMY = leaf(2, 'Jimmy Nardello', { crop_type_slug: 'pepper', species: 'annuum', genus: 'Capsicum' });
const ANCHO = leaf(3, 'Ancho', { crop_type_slug: 'pepper', species: 'annuum', genus: 'Capsicum' });
const mixRow = (n, ns, more = {}) => ({
  id: u(n), name: `Mix ${n}`, variety_rank: 'blend', blend_key: keyOf(...ns), crop_type_slug: 'pepper',
  created_by: USER, ...more,
});

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  db();
});
afterEach(() => { vi.unstubAllEnvs(); });

// ── the body ────────────────────────────────────────────────────────────────────────────────────────

describe('POST /api/varieties/blend — the body is refused, never repaired', () => {
  const post = async (body) => parse(await call('POST', '/api/varieties/blend', body));
  const CASES = [
    ['a body that is not JSON', '{not json'],
    ['a body that is an array', []],
    ['a body that is null', 'null'],
    ['no component_variety_ids', { create: false }],
    ['component_variety_ids that is not an array', { component_variety_ids: u(1), create: false }],
    ['an element that is not a uuid', { component_variety_ids: [u(1), 'blend'], create: false }],
    ['an element that is not a string', { component_variety_ids: [u(1), 7], create: false }],
    ['no create', { component_variety_ids: [u(1), u(2)] }],
    ['create as a string', { component_variety_ids: [u(1), u(2)], create: 'true' }],
    ['create as a number', { component_variety_ids: [u(1), u(2)], create: 1 }],
    ['create as null', { component_variety_ids: [u(1), u(2)], create: null }],
    [`more than ${MAX_COMPONENT_IDS} ids`, { component_variety_ids: Array.from({ length: MAX_COMPONENT_IDS + 1 }, (_, i) => u(i + 1)), create: false }],
  ];
  for (const [what, body] of CASES) {
    it(`400 { error } with no code and no statement for ${what}`, async () => {
      const { status, body: out } = await post(body);
      expect(status).toBe(400);
      expect(typeof out.error).toBe('string');
      expect(out).not.toHaveProperty('code');
      expect(stubState.sqlCalls).toHaveLength(0);
    });
  }

  it('lower-cases and dedupes before anything is counted', () => {
    const up = u(1).replace('4000', '4ABC');
    expect(parseBlendBody({ component_variety_ids: [up, up.toLowerCase(), u(2)], create: true }))
      .toEqual({ ids: [up.toLowerCase(), u(2)], create: true });
  });

  it('answers a method other than POST with 405 and reads nothing', async () => {
    // Above idMatch a GET no longer binds "blend" as a variety id (22P02 -> 500).
    for (const m of ['GET', 'PUT', 'DELETE']) {
      resetStubs(); stubState.verifyTokenResult = { sub: USER };
      expect((await call(m, '/api/varieties/blend')).statusCode).toBe(405);
      expect(stubState.sqlCalls).toHaveLength(0);
    }
  });
});

// ── each code ───────────────────────────────────────────────────────────────────────────────────────

describe('POST /api/varieties/blend — refusals carry a code and write nothing', () => {
  const refused = async (ids, code, create = true) => {
    const { status, body } = await blend(ids, create);
    expect(status).toBe(400);
    expect(body).toEqual({ error: BLEND_ERRORS[code], code });
    expect(calls(isWrite)).toHaveLength(0);
  };

  it('component_unknown — an id that is no variety row', async () => {
    db({ varieties: [CARMEN] });
    await refused([u(1), u(99)], 'component_unknown');
  });

  it('component_unknown — a mix whose leaf row is gone', async () => {
    db({ varieties: [mixRow(10, [1, 2]), CARMEN] });
    await refused([u(10)], 'component_unknown');
  });

  it('a soft-deleted variety is NOT unknown: it can still be a planting\'s variety', async () => {
    db({ varieties: [CARMEN, { ...JIMMY, deleted_at: '2026-09-01T00:00:00Z' }] });
    const { status, body } = await blend([u(1), u(2)], false);
    expect(status).toBe(200);
    expect(body.components.find((c) => c.id === u(2))).toMatchObject({ deleted: true });
    expect(body.components.find((c) => c.id === u(1))).toMatchObject({ deleted: false });
  });

  it('blend_needs_two — none, one, and the same one twice', async () => {
    db({ varieties: [CARMEN] });
    await refused([], 'blend_needs_two');
    await refused([u(1)], 'blend_needs_two');
    await refused([u(1), u(1).toUpperCase()], 'blend_needs_two');
  });

  it(`blend_too_many — ${MAX_BLEND_LEAVES + 1} leaves; ${MAX_BLEND_LEAVES} are accepted`, async () => {
    const many = Array.from({ length: 13 }, (_, i) => leaf(i + 1, `V${String(i + 1).padStart(2, '0')}`, { crop_type_slug: 'bean' }));
    db({ varieties: many });
    await refused(many.map((v) => v.id), 'blend_too_many');
    const { status, body } = await blend(many.slice(0, 12).map((v) => v.id), false);
    expect(status).toBe(200);
    expect(body.components).toHaveLength(12);
  });

  it('the bound is on LEAVES: a mix of 12 plus one more is 13; a mix of 12 plus its own 12 is 12', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => leaf(i + 1, `V${String(i + 1).padStart(2, '0')}`, { crop_type_slug: 'bean' }));
    const big = mixRow(50, twelve.map((_, i) => i + 1), { crop_type_slug: 'bean' });
    db({ varieties: [...twelve, big, leaf(13, 'V13', { crop_type_slug: 'bean' })] });
    await refused([u(50), u(13)], 'blend_too_many');
    const { status, body } = await blend([u(50), ...twelve.map((v) => v.id)], false);   // 13 ids named
    expect(status).toBe(200);
    expect(body.id).toBe(u(50));
  });

  it('mixed_crop_components — two crops', async () => {
    db({ varieties: [CARMEN, leaf(4, 'Lacinato', { crop_type_slug: 'kale' })] });
    await refused([u(1), u(4)], 'mixed_crop_components');
  });

  it('mixed_crop_components — no crop beside a tomato: NULL is a value of its own', async () => {
    db({ varieties: [leaf(5, 'Mystery'), leaf(6, 'Brandywine', { crop_type_slug: 'tomato' })] });
    await refused([u(5), u(6)], 'mixed_crop_components');
  });

  it('no crop beside no crop is ONE crop, and the mix is filed under none', async () => {
    db({ varieties: [leaf(5, 'Mystery'), leaf(7, 'Other mystery')] });
    const { status, body } = await blend([u(5), u(7)], true);
    expect(status).toBe(201);
    expect(body.crop_type_slug).toBeNull();
    expect(calls(isBlendInsert)[0].values[4]).toBeNull();
  });

  it('the crop rule reads the LEAVES of a named mix, not the mix row', async () => {
    // The mix row's own crop was edited to kale; its leaves are peppers. Leaves decide.
    db({ varieties: [CARMEN, JIMMY, mixRow(10, [1, 2], { crop_type_slug: 'kale' }), leaf(4, 'Lacinato', { crop_type_slug: 'kale' })] });
    await refused([u(10), u(4)], 'mixed_crop_components');
  });
});

// ── the key and flattening ──────────────────────────────────────────────────────────────────────────

describe('the key — leaf ids, lower-case, uuid order, joined by a comma', () => {
  it('is the same whatever order, case or repetition the ids arrive in', () => {
    const want = `${u(1)},${u(2)},${u(3)}`;
    expect(blendKey([u(3), u(1), u(2)])).toBe(want);
    expect(blendKey([u(2).toUpperCase(), u(3), u(1), u(2)])).toBe(want);
  });

  it('orders as the uuid type does (bytewise), not numerically or by locale', () => {
    const ids = ['ffffffff-0000-4000-8000-000000000000', '0a000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000000', '09000000-0000-4000-8000-000000000000'];
    expect(blendKey(ids).split(',')).toEqual([ids[3], ids[1], ids[2], ids[0]]);
  });

  it('matches the shape chk_plant_varieties_blend_key_format admits', () => {
    const FORMAT = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}(,[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}){1,11}$/;
    expect(blendKey([u(2), u(1)])).toMatch(FORMAT);
    expect(blendKey(Array.from({ length: 12 }, (_, i) => u(i + 1)))).toMatch(FORMAT);
  });

  it('flattenLeafIds replaces a keyed row by its key\'s ids and dedupes', () => {
    const byId = new Map([[u(10), { id: u(10), blend_key: keyOf(1, 2) }], [u(2), { id: u(2), blend_key: null }], [u(3), { id: u(3) }]]);
    expect(flattenLeafIds([u(10), u(2), u(3)], byId)).toEqual([u(1), u(2), u(3)]);
  });
});

describe('POST /api/varieties/blend — components are FLAT', () => {
  it('a mix named as a component contributes its leaves: {mix of A and B, C} is {A, B, C}', async () => {
    db({ varieties: [CARMEN, JIMMY, ANCHO, mixRow(10, [1, 2])] });
    const viaMix = await blend([u(10), u(3)], false);
    const flat = await blend([u(1), u(2), u(3)], false);
    expect(viaMix.body.blend_key).toBe(keyOf(1, 2, 3));
    expect(viaMix.body.blend_key).toBe(flat.body.blend_key);
    expect(viaMix.body.components.map((c) => c.id)).toEqual(flat.body.components.map((c) => c.id));
    // Leaves only: the mix itself is never a component.
    expect(viaMix.body.components.map((c) => c.id)).not.toContain(u(10));
  });

  it('a mix plus one of its own components resolves to that same mix', async () => {
    db({ varieties: [CARMEN, JIMMY, mixRow(10, [1, 2])] });
    const { status, body } = await blend([u(10), u(1)], true);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: u(10), blend_key: keyOf(1, 2), exists: true, created: false });
    expect(calls(isWrite)).toHaveLength(0);
  });

  it('reads the leaves a mix brought with it in ONE more statement, and only then', async () => {
    db({ varieties: [CARMEN, JIMMY, ANCHO, mixRow(10, [1, 2])] });
    await blend([u(10), u(3)], false);
    expect(calls(isRead).map((c) => c.values[0])).toEqual([[u(10), u(3)], [u(1), u(2)]]);
    resetStubs(); stubState.verifyTokenResult = { sub: USER };
    db({ varieties: [CARMEN, JIMMY] });
    await blend([u(1), u(2)], false);
    expect(calls(isRead)).toHaveLength(1);
  });
});

// ── create:false ────────────────────────────────────────────────────────────────────────────────────

describe('POST /api/varieties/blend — create:false never writes', () => {
  it('nothing found: three SELECTs at most, no write, no rate-limit draw, id null', async () => {
    db({ varieties: [CARMEN, JIMMY] });
    const { status, body } = await blend([u(2), u(1)], false);
    expect(status).toBe(200);
    expect(body).toEqual({
      id: null, name: 'Carmen + Jimmy Nardello mix', variety_rank: 'blend', crop_type_slug: 'pepper',
      blend_key: keyOf(1, 2), exists: false, created: false,
      components: [
        { id: u(1), name: 'Carmen', variety_rank: null, deleted: false },
        { id: u(2), name: 'Jimmy Nardello', variety_rank: null, deleted: false },
      ],
    });
    expect(stubState.sqlCalls).toHaveLength(2);                       // the read, the find
    expect(stubState.sqlCalls.every((c) => /^\s*SELECT\b/.test(c.text))).toBe(true);
    expect(calls(isWrite)).toHaveLength(0);
    expect(calls(isRateLimit)).toHaveLength(0);
  });

  it('found live: that row, exists true, created false, still no write', async () => {
    db({ varieties: [CARMEN, JIMMY, mixRow(10, [1, 2], { name: 'Sweet frying peppers' })] });
    const { status, body } = await blend([u(1), u(2)], false);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: u(10), name: 'Sweet frying peppers', variety_rank: 'blend', exists: true, created: false });
    expect(calls(isWrite)).toHaveLength(0);
  });

  it('only a soft-deleted one: id null, exists false, the automatic name — and it stays deleted', async () => {
    const state = db({ varieties: [CARMEN, JIMMY, mixRow(10, [1, 2], { deleted_at: '2026-09-30T00:00:00Z' })] });
    const { status, body } = await blend([u(1), u(2)], false);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: null, exists: false, created: false, name: 'Carmen + Jimmy Nardello mix' });
    expect(calls(isWrite)).toHaveLength(0);
    expect(state.rows.get(u(10)).deleted_at).not.toBeNull();
  });
});

// ── create:true ─────────────────────────────────────────────────────────────────────────────────────

describe('POST /api/varieties/blend — create:true', () => {
  it('found live: 200 with it, no write, no rate-limit spend', async () => {
    db({ varieties: [CARMEN, JIMMY, mixRow(10, [1, 2])] });
    const { status, body } = await blend([u(1), u(2)], true);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: u(10), exists: true, created: false });
    expect(calls(isWrite)).toHaveLength(0);
    expect(calls(isRateLimit)).toHaveLength(0);
  });

  it('finds by HOUSEHOLD: a housemate\'s mix is the answer, a stranger\'s is not', async () => {
    vi.stubEnv('GARDEN_HOUSEHOLD_IDS', `${USER},${MATE}`);
    db({ varieties: [CARMEN, JIMMY, mixRow(10, [1, 2], { created_by: MATE })] });
    expect((await blend([u(1), u(2)], true)).body).toMatchObject({ id: u(10), created: false });
    expect(calls(isFind)[0].values).toEqual([keyOf(1, 2), [USER, MATE]]);

    resetStubs(); stubState.verifyTokenResult = { sub: USER };
    db({ varieties: [CARMEN, JIMMY, mixRow(10, [1, 2], { created_by: STRANGER, name: 'Theirs' })] });
    const { status, body } = await blend([u(1), u(2)], true);
    expect(status).toBe(201);
    expect(body.id).not.toBe(u(10));
  });

  it('two rows for one key resolve to the oldest live one', async () => {
    vi.stubEnv('GARDEN_HOUSEHOLD_IDS', `${USER},${MATE}`);
    db({ varieties: [CARMEN, JIMMY,
      mixRow(11, [1, 2], { created_by: MATE, created_at: '2026-03-01T00:00:00Z', name: 'Newer' }),
      mixRow(12, [1, 2], { created_at: '2026-02-01T00:00:00Z', name: 'Older' }),
      mixRow(13, [1, 2], { created_at: '2025-01-01T00:00:00Z', name: 'Oldest but deleted', deleted_at: '2026-01-01T00:00:00Z', created_by: MATE }),
    ] });
    expect((await blend([u(1), u(2)], false)).body.id).toBe(u(12));
    expect(calls(isFind)[0].text).toMatch(/ORDER BY \(deleted_at IS NOT NULL\), created_at, id\s+LIMIT 1/);
  });

  it('found soft-deleted: revived, 200, created false, no second row, no rate-limit spend', async () => {
    const state = db({ varieties: [CARMEN, JIMMY, mixRow(10, [1, 2], { deleted_at: '2026-09-30T00:00:00Z', name: 'Frying mix' })] });
    const { status, body } = await blend([u(1), u(2)], true);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: u(10), name: 'Frying mix', exists: true, created: false });
    expect(state.rows.get(u(10)).deleted_at).toBeNull();
    expect([...state.rows.values()].filter((r) => r.blend_key === keyOf(1, 2))).toHaveLength(1);
    expect(calls(isBlendInsert)).toHaveLength(0);
    expect(calls(isRateLimit)).toHaveLength(0);
    // Under the audit actor, as the restore arm does it: set_config, then the UPDATE.
    const order = stubState.sqlCalls.map((c) => c.text);
    const at = order.findIndex(isRevive);
    expect(isSetConfig(order[at - 1])).toBe(true);
    expect(stubState.sqlCalls[at - 1].values[0]).toBe(USER);
    expect(order[at]).toMatch(/SET deleted_at = NULL/);
    expect(order[at]).toMatch(/AND deleted_at IS NOT NULL/);
    expect(stubState.sqlCalls[at].values).toEqual([null, u(10), [USER]]);   // no rename
  });

  it('revive: the stored name was taken meanwhile -> revived under " (2)", the key unchanged', async () => {
    const state = db({ varieties: [CARMEN, JIMMY,
      mixRow(10, [1, 2], { deleted_at: '2026-09-30T00:00:00Z', name: 'Frying mix' }),
      leaf(20, 'frying MIX'),
    ] });
    const { status, body } = await blend([u(1), u(2)], true);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: u(10), name: 'Frying mix (2)', blend_key: keyOf(1, 2), created: false });
    expect(state.rows.get(u(10)).deleted_at).toBeNull();
  });

  it('none: creates it — 201, created true, one draw on the create bucket', async () => {
    const state = db({ varieties: [CARMEN, JIMMY] });
    const { status, body } = await blend([u(2), u(1)], true);
    expect(status).toBe(201);
    expect(body.id).toMatch(UUID_RE);
    expect(body).toMatchObject({
      name: 'Carmen + Jimmy Nardello mix', variety_rank: 'blend', crop_type_slug: 'pepper',
      blend_key: keyOf(1, 2), exists: true, created: true,
    });
    expect(body.components.map((c) => c.name)).toEqual(['Carmen', 'Jimmy Nardello']);
    expect(state.rows.get(body.id)).toMatchObject({ created_by: USER, variety_rank: 'blend', blend_key: keyOf(1, 2) });
    const rate = calls(isRateLimit);
    expect(rate).toHaveLength(1);
    expect(rate[0].values).toEqual([USER, 'plant_varieties.create', 60]);
  });

  it('creates in one transaction, in order: actor, variety, components, care_profile, read back', async () => {
    db({ varieties: [CARMEN, JIMMY] });
    await blend([u(1), u(2)], true);
    const texts = stubState.sqlCalls.map((c) => c.text);
    const at = texts.findIndex(isBlendInsert);
    expect(isSetConfig(texts[at - 1])).toBe(true);
    expect(stubState.sqlCalls[at - 1].values[0]).toBe(USER);
    expect(isComponentInsert(texts[at + 1])).toBe(true);
    expect(isProfileInsert(texts[at + 2])).toBe(true);
    expect(isFind(texts[at + 3])).toBe(true);
    // The rate-limit draw is BEFORE the transaction, after the find that came up empty.
    expect(texts.findIndex(isRateLimit)).toBeLessThan(at - 1);
    expect(texts.findIndex(isFind)).toBeLessThan(texts.findIndex(isRateLimit));
  });

  it('writes one component row per LEAF, mirroring the key, stamped with the caller', async () => {
    const state = db({ varieties: [CARMEN, JIMMY, ANCHO, mixRow(10, [1, 2])] });
    const { body } = await blend([u(10), u(3)], true);
    expect(state.components).toEqual([1, 2, 3].map((n) => ({ blend_variety_id: body.id, component_variety_id: u(n), created_by: USER })));
    expect(state.components.map((c) => c.component_variety_id).join(',')).toBe(body.blend_key);
  });

  it('429 when the create bucket is spent, and nothing is written', async () => {
    db({ varieties: [CARMEN, JIMMY], allowRate: false });
    const { status, body } = await blend([u(1), u(2)], true);
    expect(status).toBe(429);
    expect(body.error).toMatch(/plant_varieties\.create/);
    expect(calls((t) => isBlendInsert(t) || isComponentInsert(t) || isProfileInsert(t) || isSetConfig(t))).toHaveLength(0);
  });

  it('the same request again finds what the first one made', async () => {
    db({ varieties: [CARMEN, JIMMY] });
    const first = await blend([u(1), u(2)], true);
    const again = await blend([u(2), u(1)], true);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: first.body.id, created: false });
    expect(calls(isBlendInsert)).toHaveLength(1);
    expect(calls(isRateLimit)).toHaveLength(1);
  });

  it('reply carries every REQUIRED key on each path', async () => {
    const REQUIRED = ['id', 'name', 'variety_rank', 'crop_type_slug', 'blend_key', 'exists', 'created', 'components'];
    db({ varieties: [CARMEN, JIMMY] });
    for (const create of [false, true, true, false]) {
      const { body } = await blend([u(1), u(2)], create);
      for (const k of REQUIRED) expect(body, `create:${create} reply missing ${k}`).toHaveProperty(k);
      expect(body.variety_rank).toBe('blend');
      for (const c of body.components) expect(Object.keys(c).sort()).toEqual(['deleted', 'id', 'name', 'variety_rank']);
    }
  });
});

// ── 23505 ───────────────────────────────────────────────────────────────────────────────────────────

describe('POST /api/varieties/blend — a unique violation is answered, never surfaced', () => {
  it('someone made the mix between the find and the insert: find again -> 200 with theirs', async () => {
    vi.stubEnv('GARDEN_HOUSEHOLD_IDS', `${USER},${MATE}`);
    let raced = false;
    const state = db({
      varieties: [CARMEN, JIMMY],
      onInsert: (s) => {
        if (raced) return;
        raced = true;
        // The housemate's row commits first, under the same automatic name.
        s.rows.set(u(30), { ...mixRow(30, [1, 2], { created_by: MATE, name: 'Carmen + Jimmy Nardello mix', species: 'annuum' }), deleted_at: null, created_at: '2026-10-06T00:00:00Z' });
      },
    });
    const { status, body } = await blend([u(1), u(2)], true);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: u(30), exists: true, created: false });
    expect(calls(isBlendInsert)).toHaveLength(1);                      // no second attempt
    expect([...state.rows.values()].filter((r) => r.blend_key === keyOf(1, 2))).toHaveLength(1);
  });

  it('the caller\'s own row appeared (the per-creator key index): find again -> 200', async () => {
    let raced = false;
    db({
      varieties: [CARMEN, JIMMY],
      onInsert: (s) => {
        if (raced) return;
        raced = true;
        s.rows.set(u(31), { ...mixRow(31, [1, 2], { name: 'Renamed already' }), deleted_at: null, created_at: '2026-10-06T00:00:00Z' });
      },
    });
    const { status, body } = await blend([u(1), u(2)], true);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: u(31), created: false });
  });

  it('nobody made it, so it was the NAME: retried with " (2)"', async () => {
    const state = db({ varieties: [CARMEN, JIMMY, leaf(20, 'carmen + jimmy nardello MIX', { species: 'annuum' })] });
    const { status, body } = await blend([u(1), u(2)], true);
    expect(status).toBe(201);
    expect(body).toMatchObject({ name: 'Carmen + Jimmy Nardello mix (2)', created: true, blend_key: keyOf(1, 2) });
    expect(calls(isBlendInsert).map((c) => c.values[1])).toEqual(['Carmen + Jimmy Nardello mix', 'Carmen + Jimmy Nardello mix (2)']);
    // A fresh id per attempt, and the profile + components of the row that landed carry ITS id.
    const [a, b] = calls(isBlendInsert).map((c) => c.values[0]);
    expect(a).not.toBe(b);
    expect(body.id).toBe(b);
    expect(state.profiles.filter((p) => p.scope_id === b)).toHaveLength(1);
    expect(state.components.filter((c) => c.blend_variety_id === b)).toHaveLength(2);
    expect(calls(isRateLimit)).toHaveLength(1);                         // one draw, however many names
  });

  it('walks " (2)" then " (3)" ... and stops at " (9)" with a 409 sentence', async () => {
    expect(NAME_SUFFIXES).toEqual([' (2)', ' (3)', ' (4)', ' (5)', ' (6)', ' (7)', ' (8)', ' (9)']);
    const base = 'Carmen + Jimmy Nardello mix';
    const squat = (names) => names.map((n, i) => leaf(100 + i, n, { species: 'annuum' }));

    db({ varieties: [CARMEN, JIMMY, ...squat([base, `${base} (2)`])] });
    expect((await blend([u(1), u(2)], true)).body.name).toBe(`${base} (3)`);

    resetStubs(); stubState.verifyTokenResult = { sub: USER };
    db({ varieties: [CARMEN, JIMMY, ...squat([base, ...NAME_SUFFIXES.map((s) => `${base}${s}`)])] });
    const { status, body } = await blend([u(1), u(2)], true);
    expect(status).toBe(409);
    expect(typeof body.error).toBe('string');
    expect(body.error).not.toMatch(/uq_|Unique violation/);
    expect(calls(isBlendInsert)).toHaveLength(9);
  });

  it('any other database error is not swallowed', async () => {
    db({ varieties: [CARMEN, JIMMY], onInsert: () => { throw Object.assign(new Error('boom'), { code: '57014' }); } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { expect((await blend([u(1), u(2)], true)).status).toBe(500); } finally { spy.mockRestore(); }
    expect(calls(isBlendInsert)).toHaveLength(1);
  });
});

// ── the automatic name ──────────────────────────────────────────────────────────────────────────────

describe('automaticBlendName', () => {
  const named = (...names) => sortLeaves(names.map((name, i) => ({ id: u(i + 1), name })));

  it('two leaves: joined with " + ", then " mix"', () => {
    expect(automaticBlendName(named('Jimmy Nardello', 'Carmen'))).toBe('Carmen + Jimmy Nardello mix');
  });
  it('three leaves: all three, then " mix"', () => {
    expect(automaticBlendName(named('Jimmy Nardello', 'Carmen', 'Ancho'))).toBe('Ancho + Carmen + Jimmy Nardello mix');
  });
  it('every leaf name already says mix or blend: no second " mix"', () => {
    expect(automaticBlendName(named('Jewel Mix Nasturtium', 'Alaska Mix'))).toBe('Alaska Mix + Jewel Mix Nasturtium');
    expect(automaticBlendName(named('Cayenne Blend', 'Alaska MIX', 'salad blend'))).toBe('Alaska MIX + Cayenne Blend + salad blend');
  });
  it('only SOME say it: " mix" is still added', () => {
    expect(automaticBlendName(named('Alaska Mix', 'Empress of India'))).toBe('Alaska Mix + Empress of India mix');
  });
  it('whole word only: "Mixed" and "Blender" do not count', () => {
    expect(automaticBlendName(named('Mixed Greens', 'Blender Kale'))).toBe('Blender Kale + Mixed Greens mix');
  });
  it('four leaves: the first two and "2 more", with no " mix"', () => {
    expect(automaticBlendName(named('Delta', 'Alpha', 'Charlie', 'Bravo'))).toBe('Alpha + Bravo + 2 more');
  });
  it('twelve leaves: "10 more"; and four that all say mix still take the short form', () => {
    expect(automaticBlendName(named(...Array.from({ length: 12 }, (_, i) => `V${String(i).padStart(2, '0')}`)))).toBe('V00 + V01 + 10 more');
    expect(automaticBlendName(named('A Mix', 'B Mix', 'C Mix', 'D Mix'))).toBe('A Mix + B Mix + 2 more');
  });
  it('no year and no crop word', () => {
    const name = automaticBlendName(sortLeaves([{ ...CARMEN }, { ...JIMMY }]));
    expect(name).not.toMatch(/\d{4}/);
    expect(name).not.toMatch(/pepper/i);
  });
  it('name order is lower(name) then id — never input order', () => {
    const a = { id: u(2), name: 'zebra' }; const b = { id: u(1), name: 'Zebra' }; const c = { id: u(3), name: 'apple' };
    expect(sortLeaves([a, b, c]).map((l) => l.id)).toEqual([u(3), u(1), u(2)]);
    expect(automaticBlendName(sortLeaves([a, c]))).toBe(automaticBlendName(sortLeaves([c, a])));
  });
});

// ── what the row carries at birth ───────────────────────────────────────────────────────────────────

describe('the mix row at birth', () => {
  // Facts a leaf holds that a mix must never inherit from one parent.
  const RICH = {
    days_to_maturity_min: 61, days_to_maturity_max: 83, origin_country: 'Italy', origin_region: 'Basilicata',
    photo_id: u(900), source_url: 'https://example.test/carmen', care_notes: 'stake early', soil_notes: 'rich',
    sun_requirements: 'full sun', common_diseases: ['blossom end rot'], expected_yield_notes: 'heavy',
    determinacy: 'indeterminate', growth_habit: 'upright', day_length_response: 'neutral', produces_scape: false,
    grown_as: 'annual', start_method: 'transplant', start_indoor_weeks_min: 8, start_indoor_weeks_max: 10,
    sow_depth_in: 0.25, sow_notes: 'bottom heat', dtm_basis: 'transplant',
    breeding_system: 'f1', breeding_source: 'vendor_catalog', breeding_confidence: 'high',
  };
  const FORBIDDEN = [
    'days_to_maturity_min', 'days_to_maturity_max', 'dtm_basis', 'origin_country', 'origin_region', 'photo_id',
    'source_url', 'care_notes', 'soil_notes', 'sun_requirements', 'common_diseases', 'expected_yield_notes',
    'determinacy', 'growth_habit', 'day_length_response', 'produces_scape', 'grown_as', 'start_method',
    'start_indoor_weeks_min', 'start_indoor_weeks_max', 'direct_sow_timing', 'sow_depth_in', 'seed_spacing_in',
    'row_spacing_in', 'days_to_germ_min', 'days_to_germ_max', 'sow_season', 'sow_notes',
    'breeding_system', 'breeding_source', 'breeding_confidence', 'source_proj_rescope_project_id',
  ];
  const insert = BLEND_SRC.match(/INSERT INTO public\.cultivar \(([\s\S]*?)\) VALUES \(([\s\S]*?)\)\s+RETURNING/);
  const columns = insert[1].split(',').map((c) => c.trim());

  it('the INSERT names exactly the birth columns', () => {
    expect((BLEND_SRC.match(/INSERT INTO public\.cultivar/g) || [])).toHaveLength(1);
    expect(columns).toEqual([
      'id', 'display_name', 'created_by', 'variety_rank', 'blend_key',
      'crop_type_slug', 'species', 'genus', 'lifecycle', 'scoville_min', 'scoville_max', 'scoville_source',
    ]);
    for (const col of FORBIDDEN) expect(columns, `${col} must be NULL at birth`).not.toContain(col);
  });

  it("variety_rank is the literal 'blend', never a bound value, and no body.* reaches the statement", () => {
    expect(insert[2]).toMatch(/\$\{userId\}, 'blend', \$\{key\}/);
    expect(insert[2]).not.toMatch(/body\./);
    expect(BLEND_SRC).not.toMatch(/\bbody\.[a-z_]+_id\b/);
  });

  it('never copies a leaf\'s maturity, origin, photo, care text or breeding', async () => {
    db({ varieties: [{ ...CARMEN, ...RICH }, { ...JIMMY, ...RICH }] });
    const { status, body } = await blend([u(1), u(2)], true);
    expect(status).toBe(201);
    const bound = calls(isBlendInsert)[0].values;
    for (const [k, v] of Object.entries(RICH)) {
      expect(bound, `the INSERT bound a leaf's ${k}`).not.toContainEqual(v);
      expect(body[k] ?? null, `the reply carries a leaf's ${k}`).toBeNull();
    }
    // What it binds, in column order after (id, name): the caller, the key, then the seven facts.
    expect(bound.slice(2)).toEqual([USER, keyOf(1, 2), 'pepper', 'annuum', 'Capsicum', null, null, null, null]);
  });

  it('species, genus and lifecycle only when EVERY leaf records the same value', () => {
    const base = { crop_type_slug: 'pepper' };
    expect(birthFacts([{ ...base, species: 'annuum', genus: 'Capsicum', lifecycle: 'tender_perennial' }, { ...base, species: 'annuum', genus: 'Capsicum', lifecycle: 'tender_perennial' }]))
      .toMatchObject({ species: 'annuum', genus: 'Capsicum', lifecycle: 'tender_perennial' });
    expect(birthFacts([{ ...base, species: 'annuum', genus: 'Capsicum' }, { ...base, species: 'chinense', genus: 'Capsicum' }]))
      .toMatchObject({ species: null, genus: 'Capsicum', lifecycle: null });
    // One leaf silent is not agreement.
    expect(birthFacts([{ ...base, species: 'annuum', genus: 'Capsicum' }, { ...base, species: null, genus: null }]))
      .toMatchObject({ species: null, genus: null });
  });

  it("heat: an envelope only when EVERY leaf has a whole range, labelled 'inference'", () => {
    const p = (min, max) => ({ crop_type_slug: 'pepper', scoville_min: min, scoville_max: max });
    expect(birthFacts([p(500, 2500), p(30000, 50000), p(0, 100)]))
      .toMatchObject({ scoville_min: 0, scoville_max: 50000, scoville_source: 'inference' });
    for (const partial of [[p(500, 2500), p(null, null)], [p(500, 2500), p(1000, null)], [p(500, 2500), p(null, 9000)]]) {
      expect(birthFacts(partial)).toMatchObject({ scoville_min: null, scoville_max: null, scoville_source: null });
    }
  });

  it('heat envelope reaches the INSERT', async () => {
    db({ varieties: [{ ...CARMEN, scoville_min: 0, scoville_max: 500 }, { ...JIMMY, scoville_min: 100, scoville_max: 1000 }] });
    await blend([u(1), u(2)], true);
    expect(calls(isBlendInsert)[0].values.slice(8)).toEqual([0, 1000, 'inference']);
  });

  it('componentOf reports state, never filters by it', () => {
    expect(componentOf({ id: u(1), name: 'A', variety_rank: 'cultivar', deleted_at: null })).toEqual({ id: u(1), name: 'A', variety_rank: 'cultivar', deleted: false });
    expect(componentOf({ id: u(2), name: 'B', deleted_at: '2026-01-01' })).toEqual({ id: u(2), name: 'B', variety_rank: null, deleted: true });
  });

  it('distinctCrops counts NULL as one value of its own', () => {
    expect(distinctCrops([{ crop_type_slug: null }, {}])).toHaveLength(1);
    expect(distinctCrops([{ crop_type_slug: null }, { crop_type_slug: 'tomato' }])).toHaveLength(2);
    expect(distinctCrops([{ crop_type_slug: 'tomato' }, { crop_type_slug: 'tomato' }])).toHaveLength(1);
  });
});

// ── the cadence profile row ─────────────────────────────────────────────────────────────────────────

describe('the mix gets a care_profile row that keeps the standing cadence gates green', () => {
  const CADENCE_KEYS = ['water_interval_days', 'water_interval_days_container', 'water_interval_days_inground'];
  const ADOPT_BYPASSING_KEYS = ['no_calendar_water', 'water_rule', 'no_calendar_feed', 'soil_moisture_target', '_seeded'];
  const GATES = readFileSync(resolve(__dirname, '..', '..', 'migrations', 'v4-cadencerefill-001', 'gates.yml'), 'utf8');

  it('is written in the creating transaction, keyed to the id the mix row was inserted with', async () => {
    const state = db({ varieties: [CARMEN, JIMMY] });
    const { body } = await blend([u(1), u(2)], true);
    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0].scope_id).toBe(body.id);
    expect(state.profiles[0].profile).toEqual(BLEND_PROFILE);
    const stmt = calls(isProfileInsert)[0].text;
    expect(stmt).toMatch(/'cultivar'::care_scope, \?::uuid, \?::jsonb, 1/);
    expect(stmt).toMatch(/ON CONFLICT \(scope, scope_id\) WHERE scope <> 'system' DO NOTHING/);
    expect(stmt).not.toMatch(/DO UPDATE|workspace_id/);
  });

  it('is not written on a preview, a hit or a revive', async () => {
    const state = db({ varieties: [CARMEN, JIMMY, mixRow(10, [1, 2], { deleted_at: '2026-09-30T00:00:00Z' })] });
    await blend([u(1), u(2)], false);
    await blend([u(1), u(2)], true);    // revives
    await blend([u(1), u(2)], true);    // hit
    expect(state.profiles).toHaveLength(0);
  });

  it('post_no_live_planting_rests_on_an_unresearched_placeholder cannot count a planting under a mix', () => {
    // The gate reds on `cp.profile->>'_basis' = '<label>'` with no resolved cadence. Read the label
    // from the gate itself, so relabelling either side is caught at the commit that does it.
    const at = GATES.indexOf('post_no_live_planting_rests_on_an_unresearched_placeholder');
    expect(at).toBeGreaterThan(-1);
    const label = GATES.slice(at).match(/cp\.profile->>'_basis' = '([^']+)'/);
    expect(label).not.toBeNull();
    expect(BLEND_PROFILE._basis).toBeTruthy();
    expect(BLEND_PROFILE._basis).not.toBe(label[1]);
  });

  it('says what it is, and claims neither research nor a Dave decision', () => {
    expect(BLEND_PROFILE._source).toBe('blend-create');
    expect(BLEND_PROFILE._basis).toBe('blend');
    expect(BLEND_PROFILE._basis).not.toBe('dave_decision');
    expect(Object.keys(BLEND_PROFILE).sort()).toEqual(['_basis', '_source', 'notes']);
    expect(BLEND_PROFILE).not.toHaveProperty('_retained');
  });

  it('is behaviourally inert: no cadence key, no adopt-bypassing key, no crop or genus string', () => {
    for (const k of [...CADENCE_KEYS, ...ADOPT_BYPASSING_KEYS, 'crop', 'genus']) expect(BLEND_PROFILE).not.toHaveProperty(k);
  });

  it('static: one care_profile INSERT and one component INSERT in blend.js, both inside the creating transaction', () => {
    expect((BLEND_SRC.match(/INSERT INTO public\.care_profile/g) || [])).toHaveLength(1);
    expect((BLEND_SRC.match(/INSERT INTO public\.variety_blend_component/g) || [])).toHaveLength(1);
    const tx = BLEND_SRC.slice(BLEND_SRC.lastIndexOf('await sql.transaction(['));
    const block = tx.slice(0, tx.indexOf(']);'));
    expect(block).toMatch(/setActor\([\s\S]*insertBlend\([\s\S]*insertBlendComponents\([\s\S]*insertBlendProfile\([\s\S]*findBlend\(/);
    // The audit actor is bound through the normalizer AT the bind (lambda/audit-actor-empty.test.js
    // holds every writer of the audited table to this), and both transactions lead with it.
    expect(BLEND_SRC).toMatch(/set_config\('app\.actor_clerk_sub', \$\{auditActor\(userId\)\}, true\)/);
    expect((BLEND_SRC.match(/await sql\.transaction\(\[\s+setActor\(sql, userId\),/g) || [])).toHaveLength(2);
    // And index.js keeps its own pins: the mix adds no statement there.
    expect((INDEX_SRC.match(/INSERT INTO public\.cultivar/g) || [])).toHaveLength(1);
    expect((INDEX_SRC.match(/INSERT INTO public\.care_profile/g) || [])).toHaveLength(1);
    expect(INDEX_SRC).not.toMatch(/variety_blend_component/);
  });
});

// ── restore ─────────────────────────────────────────────────────────────────────────────────────────

describe('POST /api/varieties/:id/restore — a unique-index clash is a 409 sentence', () => {
  const ID = u(10);
  const restoreDb = (err) => {
    stubState.sqlHandler = (text, values) => {
      if (isSetConfig(text)) return [{ set_config: values[0] }];
      if (text.includes('UPDATE public.cultivar')) { if (err) throw err; return [{ id: ID, deleted_at: null }]; }
      if (text.includes('FROM public.cultivar')) return [{ id: ID, deleted_at: '2026-09-30T00:00:00Z' }];
      return [];
    };
  };
  const restore = async () => parse(await call('POST', `/api/varieties/${ID}/restore`));

  for (const index of Object.keys(RESTORE_CONFLICT_MESSAGES)) {
    it(`${index} -> 409 with its sentence`, async () => {
      restoreDb(unique(index));
      const { status, body } = await restore();
      expect(status).toBe(409);
      expect(body).toEqual({ error: RESTORE_CONFLICT_MESSAGES[index] });
      expect(body.error).not.toMatch(/uq_|Unique violation/);
    });
  }

  it('names both indexes the contract names, and has a sentence for any other', async () => {
    expect(Object.keys(RESTORE_CONFLICT_MESSAGES).sort()).toEqual(['uq_plant_varieties_creator_blend_key_live', 'uq_plant_varieties_name_species']);
    expect(restoreConflictMessage({ constraint: 'something_else' })).toBe(RESTORE_CONFLICT_DEFAULT);
    restoreDb(unique('something_else'));
    expect(await restore()).toEqual({ status: 409, body: { error: RESTORE_CONFLICT_DEFAULT } });
  });

  it('a restore with no clash is unchanged: 200 { id, deleted_at }', async () => {
    restoreDb(null);
    expect(await restore()).toEqual({ status: 200, body: { id: ID, deleted_at: null } });
  });

  it('any other error still falls to the generic arm', async () => {
    restoreDb(Object.assign(new Error('boom'), { code: '57014' }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { expect((await restore()).status).toBe(500); } finally { spy.mockRestore(); }
  });
});
