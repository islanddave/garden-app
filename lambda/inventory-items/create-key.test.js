// BUG-NEWLOTNOIDEMPOTENCYKEY-001 — the key a create is retried under, driven through the handler.
//
// POST /api/inventory-items may carry `idempotency_key`, a uuid the client mints once per draft
// (src/components/seed/seedLotKey.js). The row keeps it behind uq_inventory_items_idempotency_key:
// global, and partial on IS NOT NULL only, so a soft-deleted row still holds its key
// (migrations/v5-newlotnoidempotencykey-001).
//
// THE RULES:
//   • optional, and accepted on the create only. Absent or null is the create every client sent
//     before: no statement is added and the column is bound NULL. Present and not a uuid is a 400
//     before any statement;
//   • a key this household already made a live lot under is a REPLAY: 200, that lot in the body a
//     fresh create answers with (the row, variety_rank, source_plants) plus `replayed: true`, and
//     nothing written. Decided before any other check, the way lambda/preservation
//     batchBuilderRoutes.js decides its own: a retried create gets its lot back even when a
//     planting it names has since stopped being usable;
//   • the INSERT can still lose to a request that landed after that read. A 23505 on the key's
//     index, and on no other, is read back the same way;
//   • a key held by a row this household cannot be answered with (another household's, or a
//     soft-deleted one) is 409 key_conflict with no payload. Both reads carry the household
//     predicate, so another household's row is never selected at all;
//   • the key is the client's own. No answer of this Lambda sends it back.
//
// WHAT THE STUB CANNOT SHOW: that the index exists, that the driver's 23505 names it, or that two
// requests in flight together make one row. `table` below is a model of the three statements that
// touch a key, and it answers the by-key read with exactly the predicates that statement's TEXT
// carries, so a read that lost one answers here as the database would. The real-Postgres case is in
// tests/integration/inventory-items.int.test.js.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { handler, validateCreate } = await import('./index.js');

const USER = 'user_stub_owner';
const PARTNER = 'user_stub_partner';
const STRANGER = 'user_stub_stranger';
const VARIETY = 'd58b5155-0c23-4365-bfad-30549b8ca069';
const uuid = (n) => `3f9c1e64-1a2b-4c3d-8e4f-${String(n).padStart(12, '0')}`;
const A = uuid(1);
const B = uuid(2);
const KEY = '7b0c7f0e-5a61-4c1b-9d2e-0f3a4b5c6d7e';
const INDEX = 'uq_inventory_items_idempotency_key';
const KEY_CONFLICT = { error: 'That key is already in use.', code: 'key_conflict' };

const event = (method, rawPath, body, qs) => ({
  requestContext: { http: { method } },
  rawPath,
  headers: { authorization: 'Bearer stub-token' },
  ...(qs ? { queryStringParameters: qs } : {}),
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const post = (body) => event('POST', '/api/inventory-items', body);
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}'), raw: res.body });

const seedLot = (extra = {}) => ({
  name: 'Alaska Mix 2026', type: 'consumable', category: 'seeds', unit: 'packet',
  quantity_on_hand: 1, variety_id: VARIETY, ...extra,
});
const tool = (extra = {}) => ({ name: 'Broadfork', type: 'durable', category: 'tools', quantity: 1, ...extra });
// What the wide PUT is sent: a list row's editable fields (source-plants-read.test.js).
const edit = (extra = {}) => ({
  name: 'Renamed', type: 'consumable', category: 'seeds', unit: 'packet', quantity_on_hand: 2, ...extra,
});

// `byKey` first: nothing else names the column. `rules` before `owns`, which its text also
// satisfies (post-source-plant-ids.test.js). The parents-path kinds before the read kinds.
const IS = {
  byKey: (t) => /i\.idempotency_key = \?::uuid/.test(t),
  rules: (t) => /AS rules_hold/.test(t),
  pfacts: (t) => /AS lot_found/.test(t),
  mix: (t) => /AND fv\.blend_key = \?\s*$/.test(t),
  owns: (t) => /FROM public\.garden_node p\s+WHERE p\.id = ANY\(\?::uuid\[\]\)\s+AND p\.created_by = ANY/.test(t),
  members: (t) => /SELECT k\.plant_id AS id/.test(t),
  lot: (t) => /INSERT INTO inventory_items \(/.test(t),
  hold: (t) => /FOR SHARE/.test(t),
  link: (t) => /INSERT INTO public\.seed_lot_parent_planting/.test(t),
  assert: (t) => /AS every_parent_linked/.test(t),
  parents: (t) => /jsonb_agg/.test(t),
  list: (t) => /se\.entered_at AS stage_entered_at/.test(t),
  detail: (t) => /effective_featured_photo_id/.test(t) && /WHERE i\.id = \?/.test(t),
  update: (t) => /UPDATE inventory_items SET/.test(t),
};
const kindOf = (t) => Object.keys(IS).find((k) => IS[k](t)) ?? 'other';
const kinds = (from = 0) => stubState.sqlCalls.slice(from).map((c) => kindOf(c.text));
const calls = (k) => stubState.sqlCalls.filter((c) => kindOf(c.text) === k);

// The value bound to the `?` that ends `re`'s match; undefined when the text has no such predicate.
const boundAt = (text, values, re) => {
  const m = text.match(re);
  if (!m) return undefined;
  return values[(text.slice(0, m.index + m[0].length).match(/\?/g) ?? []).length - 1];
};

// The lot INSERT as the row it would write: its column list and its bindings, by position.
const insertedRow = (text, values) => {
  const open = 'INSERT INTO inventory_items (';
  const names = text.slice(text.indexOf(open) + open.length, text.indexOf(') VALUES ('))
    .split(',').map((s) => s.trim()).filter(Boolean);
  expect(names.length, 'the column list must be found').toBeGreaterThan(20);
  const placeholders = (text.slice(text.indexOf(') VALUES (')).match(/\?/g) ?? []).length;
  expect(placeholders, 'one binding per column').toBe(names.length);
  return Object.fromEntries(names.map((n, i) => [n, values[i]]));
};

const parent = (id, name) => ({
  id, name, variety_id: uuid(90), variety_name: name, breeding_system: 'open_pollinated',
  variety_rank: 'cultivar', crop_slug: 'nasturtium', archived: false, deleted: false,
});
const JAR = [parent(A, 'Alaska Mix'), parent(B, 'Jewel Mix')];

// THE MODEL. `table` is inventory_items as far as a key is concerned; `withParents` the lots that
// were written with a parent (the member cache is non-null exactly then).
let table;
let withParents;
const dup = () => Object.assign(
  new Error(`duplicate key value violates unique constraint "${INDEX}"`), { code: '23505', constraint: INDEX },
);
const stored = (row) => ({ ...row, variety_rank: 'cultivar' });
const MODEL = {
  // What the text asks for, and no more: the key always, the household and the live-row predicates
  // only when the statement carries them.
  byKey: (text, values) => {
    let rows = table.filter((r) => r.idempotency_key === boundAt(text, values, /i\.idempotency_key = \?/));
    const scope = boundAt(text, values, /i\.created_by = ANY\(\?/);
    if (scope !== undefined) rows = rows.filter((r) => scope.includes(r.created_by));
    if (/i\.deleted_at IS NULL/.test(text)) rows = rows.filter((r) => r.deleted_at == null);
    return rows.map(stored);
  },
  // The index is global and ignores deleted_at; two NULL keys never collide.
  lot: (text, values) => {
    const row = { ...insertedRow(text, values), deleted_at: null };
    if (row.idempotency_key != null && table.some((r) => r.idempotency_key === row.idempotency_key)) throw dup();
    table.push(row);
    if (row.source_plant_id != null) withParents.add(row.id);
    return [stored(row)];
  },
  rules: () => [{ rules_hold: true, go: 'go' }],
  pfacts: (text, values) => values[0].map((id) => ({
    id, cultivar_id: uuid(90), crop_slug: 'nasturtium', blend_key: null, member: false, lot_found: false, lot_variety_id: null,
  })),
  mix: () => [],
  owns: (text, values) => values[0].map((id) => ({ id })),
  members: () => [],
  hold: (text, values) => values[0].map((id) => ({ id })),
  link: () => [],
  assert: () => [{ every_parent_linked: 1 }],
  // readSourcePlants binds (householdIds, lotId, lotId); the list asks with no lot.
  parents: (text, values) => [...withParents]
    .filter((id) => values[1] == null || id === values[1])
    .map((id) => ({ inventory_item_id: id, source_plants: JAR })),
  list: () => table.filter((r) => r.deleted_at == null).map(stored),
  detail: (text, values) => table.filter((r) => values.includes(r.id)).map(stored),
  update: () => table.slice(0, 1).map(stored),
  other: () => [],
};
const world = (over = {}) => (text, values) => {
  const k = kindOf(text);
  if (k in over) return typeof over[k] === 'function' ? over[k](text, values) : over[k];
  return MODEL[k](text, values);
};

// A keyed lot already in the table, as some earlier request left it.
const keyedRow = (createdBy, extra = {}) => ({
  id: uuid(500), user_id: createdBy, created_by: createdBy, type: 'consumable', name: 'Jewel Mix 2025',
  category: 'seeds', unit: 'packet', quantity_on_hand: 1, variety_id: VARIETY, source_plant_id: null,
  idempotency_key: KEY, deleted_at: null, ...extra,
});

const savedHousehold = process.env.GARDEN_HOUSEHOLD_IDS;
let errorLog;
beforeEach(() => {
  resetStubs();
  table = [];
  withParents = new Set();
  stubState.verifyTokenResult = { sub: USER };
  stubState.sqlHandler = world();
  delete process.env.GARDEN_HOUSEHOLD_IDS;
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (savedHousehold === undefined) delete process.env.GARDEN_HOUSEHOLD_IDS;
  else process.env.GARDEN_HOUSEHOLD_IDS = savedHousehold;
});

describe('validateCreate — the key is optional, and a uuid when it is there', () => {
  it('passes a body with no key, a null key, and a uuid', () => {
    expect(validateCreate(seedLot())).toBeNull();
    expect(validateCreate(seedLot({ idempotency_key: null }))).toBeNull();
    expect(validateCreate(seedLot({ idempotency_key: KEY }))).toBeNull();
    expect(validateCreate(tool({ idempotency_key: KEY.toUpperCase() }))).toBeNull();
  });

  it('refuses anything else that is there', () => {
    const bad = ['', 'not-a-uuid', KEY.slice(1), `${KEY} `, `${KEY}\n`, 42, 0, true, false, {}, [KEY], { key: KEY }];
    for (const idempotency_key of bad) {
      expect(validateCreate(seedLot({ idempotency_key })), JSON.stringify(idempotency_key)).toBe('idempotency_key must be a uuid');
    }
  });
});

describe('POST with a key — a fresh create', () => {
  it('reads by key inside the household, then writes the lot with the key in its column', async () => {
    const res = parse(await handler(post(seedLot({ idempotency_key: KEY }))));
    expect(res.status).toBe(201);
    expect(kinds()).toEqual(['byKey', 'lot']);
    const [read] = calls('byKey');
    expect(boundAt(read.text, read.values, /i\.idempotency_key = \?/)).toBe(KEY);
    expect(boundAt(read.text, read.values, /i\.created_by = ANY\(\?/)).toEqual([USER]);
    expect(read.text).toMatch(/i\.deleted_at IS NULL/);
    expect(table).toHaveLength(1);
    expect(table[0].idempotency_key).toBe(KEY);
    expect(table[0].created_by).toBe(USER);
    expect(res.body.id).toBe(table[0].id);
    expect(res.body.name).toBe('Alaska Mix 2026');
    expect(res.body.source_plants).toEqual([]);
    expect(res.body).not.toHaveProperty('replayed');
  });

  it('a key that is not a uuid is a 400, and no statement runs', async () => {
    const res = parse(await handler(post(seedLot({ idempotency_key: 'not-a-uuid' }))));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'idempotency_key must be a uuid' });
    expect(stubState.sqlCalls).toHaveLength(0);
    expect(table).toHaveLength(0);
  });
});

describe('POST without a key — the create every client sent before', () => {
  for (const [name, extra] of [['no key in the body', {}], ['a null key', { idempotency_key: null }]]) {
    it(`one statement, and the column is bound NULL — ${name}`, async () => {
      const res = parse(await handler(post(seedLot(extra))));
      expect(res.status).toBe(201);
      expect(kinds()).toEqual(['lot']);
      expect(table[0].idempotency_key).toBeNull();
      expect(res.body.source_plants).toEqual([]);
      expect(res.body).not.toHaveProperty('replayed');
    });
  }

  it('the same body twice is two lots, as it always was', async () => {
    const first = parse(await handler(post(tool())));
    const second = parse(await handler(post(tool())));
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(table).toHaveLength(2);
    expect(second.body.id).not.toBe(first.body.id);
    expect(kinds()).toEqual(['lot', 'lot']);
  });

  it('a create with parents asks nothing about a key either', async () => {
    const res = parse(await handler(post(seedLot({ source_plant_ids: [A, B] }))));
    expect(res.status).toBe(201);
    expect(kinds()).not.toContain('byKey');
    expect(table[0].idempotency_key).toBeNull();
    expect(res.body.source_plants).toEqual(JAR);
  });
});

describe('a replay — the same key again', () => {
  it('answers the first lot, writes nothing, and says it is a replay', async () => {
    const first = parse(await handler(post(seedLot({ idempotency_key: KEY }))));
    const mark = stubState.sqlCalls.length;
    const second = parse(await handler(post(seedLot({ idempotency_key: KEY }))));
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ...first.body, replayed: true });
    expect(table).toHaveLength(1);
    // The by-key read, then the lot's parents (a seed lot may have them). No INSERT.
    expect(kinds(mark)).toEqual(['byKey', 'parents']);
  });

  it('a lot made with parents is answered with them, read for that lot', async () => {
    const body = seedLot({ idempotency_key: KEY, source_plant_ids: [A, B] });
    const first = parse(await handler(post(body)));
    const mark = stubState.sqlCalls.length;
    const second = parse(await handler(post(body)));
    expect(first.status).toBe(201);
    expect(first.body.source_plants).toEqual(JAR);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ...first.body, replayed: true });
    expect(table).toHaveLength(1);
    expect(kinds(mark)).toEqual(['byKey', 'parents']);
    expect(calls('parents').at(-1).values).toEqual([[USER], first.body.id, first.body.id]);
  });

  it('a row that is not seed has no parents to read', async () => {
    const first = parse(await handler(post(tool({ idempotency_key: KEY }))));
    const mark = stubState.sqlCalls.length;
    const second = parse(await handler(post(tool({ idempotency_key: KEY }))));
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ...first.body, replayed: true });
    expect(second.body.source_plants).toEqual([]);
    expect(kinds(mark)).toEqual(['byKey']);
  });

  it('is decided before any other check: a planting that stopped being usable does not cost the answer', async () => {
    const body = seedLot({ idempotency_key: KEY, source_plant_ids: [A, B] });
    const first = parse(await handler(post(body)));
    // The same request without a key is refused now…
    stubState.sqlHandler = world({ owns: [] });
    const { idempotency_key: _key, ...unkeyed } = body;
    expect(parse(await handler(post(unkeyed))).status).toBe(400);
    // …and the retried create still gets its lot.
    const mark = stubState.sqlCalls.length;
    const second = parse(await handler(post(body)));
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(kinds(mark)).toEqual(['byKey', 'parents']);
    expect(table).toHaveLength(1);
  });

  it('another body under the same key is still the first lot', async () => {
    const first = parse(await handler(post(seedLot({ idempotency_key: KEY }))));
    const second = parse(await handler(post(seedLot({ idempotency_key: KEY, name: 'Typed again' }))));
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.name).toBe('Alaska Mix 2026');
    expect(table).toHaveLength(1);
  });

  it('a household member is answered with the lot the other member made', async () => {
    process.env.GARDEN_HOUSEHOLD_IDS = `${USER},${PARTNER}`;
    table.push(keyedRow(PARTNER));
    const res = parse(await handler(post(seedLot({ idempotency_key: KEY }))));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(uuid(500));
    expect(res.body.replayed).toBe(true);
    expect(table).toHaveLength(1);
    const [read] = calls('byKey');
    expect(boundAt(read.text, read.values, /i\.created_by = ANY\(\?/)).toEqual([USER, PARTNER]);
  });
});

describe('a replay that raced — the INSERT loses to a request that landed after the read', () => {
  // The first by-key read finds nothing; the other request commits; the INSERT meets its row.
  const landsAfterTheRead = () => {
    let asked = 0;
    return (text, values) => {
      asked += 1;
      if (asked > 1) return MODEL.byKey(text, values);
      table.push(keyedRow(USER));
      return [];
    };
  };

  it('reads the row back and answers it: 200, one row, never a 500', async () => {
    stubState.sqlHandler = world({ byKey: landsAfterTheRead() });
    const res = parse(await handler(post(seedLot({ idempotency_key: KEY }))));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(uuid(500));
    expect(res.body.name).toBe('Jewel Mix 2025');
    expect(res.body.replayed).toBe(true);
    expect(res.body.source_plants).toEqual([]);
    expect(kinds()).toEqual(['byKey', 'lot', 'byKey', 'parents']);
    expect(table).toHaveLength(1);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('the same from inside the parents transaction, and it is not parents_changed', async () => {
    stubState.sqlHandler = world({ byKey: landsAfterTheRead() });
    const res = parse(await handler(post(seedLot({ idempotency_key: KEY, source_plant_ids: [A, B] }))));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(uuid(500));
    expect(res.body.replayed).toBe(true);
    expect(res.body).not.toHaveProperty('code');
    expect(kinds().filter((k) => k === 'byKey')).toHaveLength(2);
    expect(table).toHaveLength(1);
  });

  it('a 23505 on any other index is not a replay', async () => {
    for (const constraint of ['uq_slpp_item_plant_role_live', undefined]) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      stubState.sqlHandler = world({
        lot: () => { throw Object.assign(new Error('duplicate key value'), { code: '23505', constraint }); },
      });
      const res = parse(await handler(post(seedLot({ idempotency_key: KEY }))));
      expect(res.status, String(constraint)).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
      expect(kinds()).toEqual(['byKey', 'lot']);
    }
  });
});

describe('a key this household cannot be answered with', () => {
  it('another household holds it: 409 key_conflict, no payload, and their row is never selected', async () => {
    table.push(keyedRow(STRANGER, { name: 'A stranger’s seed' }));
    const res = parse(await handler(post(seedLot({ idempotency_key: KEY }))));
    expect(res.status).toBe(409);
    expect(res.body).toEqual(KEY_CONFLICT);
    expect(res.raw).not.toContain(uuid(500));
    expect(res.raw).not.toContain('stranger');
    expect(res.raw).not.toContain(STRANGER);
    // Nothing was written, and both reads were the caller's household's.
    expect(table).toHaveLength(1);
    expect(kinds()).toEqual(['byKey', 'lot', 'byKey']);
    for (const read of calls('byKey')) {
      expect(boundAt(read.text, read.values, /i\.created_by = ANY\(\?/)).toEqual([USER]);
    }
  });

  it('the same with parents: the transaction is undone and the answer is still key_conflict', async () => {
    table.push(keyedRow(STRANGER));
    const res = parse(await handler(post(seedLot({ idempotency_key: KEY, source_plant_ids: [A, B] }))));
    expect(res.status).toBe(409);
    expect(res.body).toEqual(KEY_CONFLICT);
    expect(table).toHaveLength(1);
  });

  it('a lot this household made and then deleted still holds its key: 409, and no second lot', async () => {
    table.push(keyedRow(USER, { deleted_at: '2026-10-13T09:00:00Z' }));
    const res = parse(await handler(post(seedLot({ idempotency_key: KEY }))));
    expect(res.status).toBe(409);
    expect(res.body).toEqual(KEY_CONFLICT);
    expect(table).toHaveLength(1);
    expect(kinds()).toEqual(['byKey', 'lot', 'byKey']);
  });
});

describe('the key is never sent back', () => {
  const clean = (res) => {
    expect(res.body).toBeTruthy();
    expect(res.body, 'the column').not.toContain('idempotency_key');
    expect(res.body, 'the value').not.toContain(KEY);
  };

  it('by the create, with or without parents', async () => {
    const plain = await handler(post(seedLot({ idempotency_key: KEY })));
    expect(plain.statusCode).toBe(201);
    clean(plain);
    table = [];
    const jar = await handler(post(seedLot({ idempotency_key: KEY, source_plant_ids: [A, B] })));
    expect(jar.statusCode).toBe(201);
    clean(jar);
    // The stub did hand the handler a row that carries it (RETURNING *).
    expect(table[0].idempotency_key).toBe(KEY);
  });

  it('by a replay, found by the read or after the INSERT lost', async () => {
    table.push(keyedRow(USER));
    const found = await handler(post(seedLot({ idempotency_key: KEY })));
    expect(found.statusCode).toBe(200);
    clean(found);
    let asked = 0;
    stubState.sqlHandler = world({ byKey: (text, values) => ((asked += 1) > 1 ? MODEL.byKey(text, values) : []) });
    const raced = await handler(post(seedLot({ idempotency_key: KEY })));
    expect(raced.statusCode).toBe(200);
    clean(raced);
  });

  it('by a refusal', async () => {
    table.push(keyedRow(STRANGER));
    const res = await handler(post(seedLot({ idempotency_key: KEY })));
    expect(res.statusCode).toBe(409);
    clean(res);
  });

  it('by the list, the detail read or the wide PUT', async () => {
    table.push(keyedRow(USER));
    const answers = [
      await handler(event('GET', '/api/inventory-items')),
      await handler(event('GET', '/api/inventory-items', undefined, { category: 'seeds' })),
      await handler(event('GET', `/api/inventory-items/${uuid(500)}`)),
      await handler(event('PUT', `/api/inventory-items/${uuid(500)}`, edit())),
    ];
    expect(kinds().filter((k) => ['list', 'detail', 'update'].includes(k))).toEqual(['list', 'list', 'detail', 'update']);
    for (const res of answers) {
      expect(res.statusCode).toBe(200);
      clean(res);
    }
    // Each of those statements answered with a row that carries the key, as `i.*` and
    // `RETURNING *` do: what kept it out of the body is the handler.
    expect(JSON.parse(answers[0].body)[0].id).toBe(uuid(500));
    expect(JSON.parse(answers[2].body).id).toBe(uuid(500));
    expect(JSON.parse(answers[3].body).id).toBe(uuid(500));
  });
});

// A construct named in a comment is not that construct (select-columns.test.js).
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const SOURCES = readdirSync(__dirname).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).sort();
const statementsOf = (file) => decomment(readFileSync(resolve(__dirname, file), 'utf8')).match(/sql`[\s\S]*?`/g) ?? [];
const naming = (re) => SOURCES.flatMap((file) => statementsOf(file).filter((s) => re.test(s)).map((s) => [file, s]));

describe('the statements this rests on', () => {
  it('every statement that answers with a whole inventory_items row is one the test above drives', () => {
    // `i.*` and `RETURNING *` carry every column the table has, this one included. There are six
    // such statements in this directory and each one's answer is checked above: the detail read,
    // the two list reads, the by-key read, the wide PUT and the create. A seventh has to drop the
    // key from what it answers (withoutCreateKey, or the read arms' own destructuring) and join
    // that test before this count moves.
    const wildcard = naming(/\bi\.\*/);
    expect(wildcard.map(([file]) => file)).toEqual(['index.js', 'index.js', 'index.js', 'index.js']);
    const returningAll = naming(/RETURNING \*/);
    expect(returningAll.map(([file]) => file)).toEqual(['index.js', 'index.js']);
    expect(returningAll.map(([, s]) => /^sql`\s*(INSERT INTO|UPDATE) inventory_items\b/.test(s))).toEqual([true, true]);
  });

  it('two statements name the column: the create writes it and the by-key read finds it', () => {
    // Accepted on the create only. The wide PUT round-trips a list row and must never assign it,
    // and no other route in this directory has a reason to know it.
    const named = naming(/\bidempotency_key\b/);
    expect(named.map(([file]) => file)).toEqual(['index.js', 'index.js']);
    const [read, insert] = named.map(([, s]) => s.replace(/\s+/g, ' '));
    expect(read).toContain(
      'WHERE i.idempotency_key = ${key}::uuid AND i.created_by = ANY(${householdIds}) AND i.deleted_at IS NULL',
    );
    expect(insert).toMatch(/^sql` INSERT INTO inventory_items \(/);
    expect(insert).toMatch(/, idempotency_key \) VALUES \(/);
    expect(insert).toMatch(/\$\{createKey\}::uuid \) RETURNING \*/);
  });

  it('a PUT that carries the key writes nothing with it', async () => {
    table.push(keyedRow(USER));
    const other = 'c0ffee00-0000-4000-8000-000000000001';
    const res = await handler(event('PUT', `/api/inventory-items/${uuid(500)}`, edit({ idempotency_key: other })));
    expect(res.statusCode).toBe(200);
    const [update] = calls('update');
    expect(update.text).not.toMatch(/idempotency_key/);
    expect(update.values).not.toContain(other);
  });
});
