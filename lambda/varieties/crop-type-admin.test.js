// V4-CROPTYPERETIRE-001 — retire and restore a crop type.
//
// These run the handler (the vitest.config.ts stub aliases make ./index.js importable) because what
// matters is which branch a request takes: refused by the gate, refused by the guard, or written.
// The stub database below answers the usage read from a declared fixture and applies the two writes
// to it, so a read-back after a retire or a restore sees what the handler did.
//
// The stub accepts any SQL, so it cannot prove the guard inside the UPDATE. The static block at the
// bottom does that from the source text, and derives the list of dependent tables from migrations/.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { stubState, resetStubs } from '../_test-stubs/state.js';
import {
  CROP_TYPE_DEPENDENTS, usageSentence, describeType, auditLine, isAdmin, adminRefusal,
  RETIRED_CODE, RETIRED_MESSAGE, NOT_CONFIGURED_CODE, FOOD_CLASS_REFUSAL,
  GATE_REQUIRED_SLUGS, GATE_REQUIRED_REFUSAL, retireCropType,
} from './crop-type-admin.js';

const { handler } = await import('./index.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN = 'user_admin';
const OTHER = 'user_someone_else';

const call = (method, rawPath, body) => handler({
  requestContext: { http: { method } },
  rawPath,
  headers: { authorization: 'Bearer stub-token' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const parse = async (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });
const post = async (path, body) => parse(await call('POST', path, body));
const get = async (path) => parse(await call('GET', path));
const as = (sub) => { stubState.verifyTokenResult = { sub }; };

const ZERO = { varieties: 0, put_ups: 0, pantry_items: 0, batches: 0, put_up_sources: 0 };
const type = (slug, display_name, extra = {}) => ({
  slug, display_name, category: 'vegetable', sort_order: 0, default_lifecycle: null, deleted_at: null,
  ...ZERO, ...extra,
});

// The crop_types table plus its per-table counts, declared per test. A type may also declare
// dependent ROWS (`rows: { varieties: [{ deleted_at }] }`); the stub counts a soft-deleted one unless
// the statement it is answering filters that table on deleted_at, so a filter put back into either
// statement lets a type with only deleted rows through, and the tests below see it.
const ALIAS = { varieties: 'cv', put_ups: 'pl', pantry_items: 'pit', batches: 'kbi', put_up_sources: 'ps' };
const rowsCounted = (text, r, key) => (r.rows?.[key] ?? [])
  .filter((d) => !(d.deleted_at && text.includes(`${ALIAS[key]}.deleted_at IS NULL`))).length;
let table;
function db(rows) {
  table = rows.map((r) => ({ ...r }));
  stubState.sqlHandler = (text, values) => {
    if (text.includes('INSERT INTO public.rate_limit_buckets')) return [{ count: 1 }];
    if (text.includes('AS put_up_sources')) {
      return table.filter((r) => values[0] == null || r.slug === values[0]).map((r) => ({
        ...r, ...Object.fromEntries(Object.keys(ALIAS).map((k) => [k, r[k] + rowsCounted(text, r, k)])),
      }));
    }
    if (text.includes('SET deleted_at = now(), updated_at = now()')) {
      const row = table.find((r) => r.slug === values[0] && !r.deleted_at);
      if (!row) return [];
      if (Object.keys(ALIAS).some((k) => rowsCounted(text, row, k) > 0)) return [];
      // The gate-required list travels in the statement as an array parameter.
      if (values.some((v) => Array.isArray(v) && v.includes(values[0]))) return [];
      row.deleted_at = '2026-10-12T00:00:00.000Z';
      return [row];
    }
    if (text.includes('SET deleted_at = NULL, updated_at = now()')) {
      const row = table.find((r) => r.slug === values[0] && r.deleted_at);
      if (!row) return [];
      row.deleted_at = null;
      return [row];
    }
    if (text.includes('SELECT slug FROM public.crop_types')) return table.map((r) => ({ slug: r.slug }));
    if (text.includes('FROM public.crop_types')) return table.filter((r) => r.slug === values[0]);
    return [];
  };
}
const writes = () => stubState.sqlCalls.filter((c) => /UPDATE public\.crop_types/.test(c.text));

let logSpy;
const savedEnv = process.env.ADMIN_CLERK_SUBS;
beforeEach(() => {
  resetStubs();
  process.env.ADMIN_CLERK_SUBS = `user_other_admin, ${ADMIN}`;
  as(ADMIN);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  if (savedEnv === undefined) delete process.env.ADMIN_CLERK_SUBS;
  else process.env.ADMIN_CLERK_SUBS = savedEnv;
});
const auditLines = () => logSpy.mock.calls.map((c) => c[0]).filter((l) => typeof l === 'string' && l.includes('crop_type_'));

describe('retire — the guard', () => {
  it.each(CROP_TYPE_DEPENDENTS.map((d) => [d.table, d]))(
    'refuses while a %s row names the type, and says what uses it',
    async (_table, d) => {
      db([type('radish', 'Radish', { [d.key]: 2 })]);
      const res = await post('/api/varieties/crop-types/retire', { slug: 'radish' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('in_use');
      expect(res.body.error).toBe(`Still used by 2 ${d.many}.`);
      expect(writes()).toHaveLength(0);
      expect(table[0].deleted_at).toBeNull();
      expect(auditLines()).toEqual([]);
    },
  );

  // A deleted row can be un-deleted (variety restore, reviveBlend, the batch-input un-delete), and
  // it would come back naming a retired type. So it holds the type in place like a live one.
  it.each(CROP_TYPE_DEPENDENTS.map((d) => [d.table, d]))(
    'refuses a type whose only %s row is soft-deleted',
    async (_table, d) => {
      db([type('radish', 'Radish', { rows: { [d.key]: [{ deleted_at: '2026-09-01T00:00:00.000Z' }] } })]);
      const res = await post('/api/varieties/crop-types/retire', { slug: 'radish' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('in_use');
      expect(res.body.error).toBe(`Still used by 1 ${d.one}.`);
      expect(writes()).toHaveLength(0);
      expect(table[0].deleted_at).toBeNull();
      const list = await get('/api/varieties/crop-types/admin');
      expect(list.body.types[0]).toMatchObject({ can_retire: false, why_not: `Still used by 1 ${d.one}.` });
    },
  );

  it('the write itself refuses on a soft-deleted row that appears after the read passed', async () => {
    db([type('radish', 'Radish')]);
    const inner = stubState.sqlHandler;
    stubState.sqlHandler = (text, values) => {
      if (text.includes('SET deleted_at = now()')) table[0].rows = { varieties: [{ deleted_at: '2026-09-01T00:00:00.000Z' }] };
      return inner(text, values);
    };
    const res = await post('/api/varieties/crop-types/retire', { slug: 'radish' });
    expect(res.status).toBe(409);
    expect(table[0].deleted_at).toBeNull();
  });

  it('names every table that still uses the type in one sentence', async () => {
    db([type('cheddar', 'Cheddar', { pantry_items: 3, batches: 1 })]);
    const res = await post('/api/varieties/crop-types/retire', { slug: 'cheddar' });
    expect(res.body.error).toBe('Still used by 3 pantry items and 1 batch.');
  });

  it('refuses a non_plant_food type by category, even with nothing using it', async () => {
    db([type('bread', 'Bread', { category: 'non_plant_food' })]);
    const res = await post('/api/varieties/crop-types/retire', { slug: 'bread' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('food_class');
    expect(res.body.error).toBe(FOOD_CLASS_REFUSAL);
    expect(writes()).toHaveLength(0);
    expect(table[0].deleted_at).toBeNull();
  });

  it('refuses a type the garden\'s own gates need live, even with nothing using it', async () => {
    db([type('aloe', 'Aloe', { category: 'succulent' })]);
    const res = await post('/api/varieties/crop-types/retire', { slug: 'aloe' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('gate_required');
    expect(res.body.error).toBe("The garden's own checks need this crop type.");
    expect(GATE_REQUIRED_REFUSAL).toBe("The garden's own checks need this crop type.");
    expect(writes()).toHaveLength(0);
    expect(table[0].deleted_at).toBeNull();
    expect(auditLines()).toEqual([]);
  });

  it('gives the gate reason before the usage sentence, and the food-class reason before both', async () => {
    db([
      type('garlic', 'Garlic', { varieties: 3 }),
      type('bread', 'Bread', { category: 'non_plant_food' }),
    ]);
    expect(GATE_REQUIRED_SLUGS).toContain('bread');
    expect((await post('/api/varieties/crop-types/retire', { slug: 'garlic' })).body)
      .toMatchObject({ code: 'gate_required', error: GATE_REQUIRED_REFUSAL });
    expect((await post('/api/varieties/crop-types/retire', { slug: 'bread' })).body)
      .toMatchObject({ code: 'food_class', error: FOOD_CLASS_REFUSAL });
  });

  it('the write itself refuses a gate-required slug when the pre-check did not', async () => {
    // The usage read is made to describe some other, retirable type, so the pre-check passes and
    // only the UPDATE's own predicate stands between the request and a retired aloe.
    db([type('aloe', 'Aloe', { category: 'succulent' })]);
    const inner = stubState.sqlHandler;
    const calls = [];
    const sql = (strings, ...values) => {
      const text = strings.join('?');
      calls.push(text);
      return Promise.resolve(text.includes('AS put_up_sources') ? [type('radish', 'Radish')] : inner(text, values));
    };
    const res = await retireCropType(sql, { slug: 'aloe' }, ADMIN, { ADMIN_CLERK_SUBS: ADMIN });
    expect(calls.some((t) => t.includes('SET deleted_at = now()'))).toBe(true);
    expect(res.status).toBe(409);
    expect(table[0].deleted_at).toBeNull();
    expect(auditLines()).toEqual([]);
  });

  it('retires a type nothing uses, and it reads back retired', async () => {
    db([type('radish', 'Radish')]);
    const res = await post('/api/varieties/crop-types/retire', { slug: 'radish' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ slug: 'radish', retired: true, can_retire: false });
    const list = await get('/api/varieties/crop-types/admin');
    expect(list.body.types[0]).toMatchObject({ slug: 'radish', retired: true });
  });

  it('answers 409 when the write finds the type in use after the read passed', async () => {
    db([type('radish', 'Radish')]);
    const inner = stubState.sqlHandler;
    stubState.sqlHandler = (text, values) => (text.includes('SET deleted_at = now()') ? [] : inner(text, values));
    const res = await post('/api/varieties/crop-types/retire', { slug: 'radish' });
    expect(res.status).toBe(409);
    expect(auditLines()).toEqual([]);
  });

  it('answers 404 for an unknown slug, 409 for one already retired, 400 for none', async () => {
    db([type('radish', 'Radish', { deleted_at: '2026-10-01T00:00:00.000Z' })]);
    expect((await post('/api/varieties/crop-types/retire', { slug: 'nope' })).status).toBe(404);
    expect((await post('/api/varieties/crop-types/retire', { slug: 'radish' })).status).toBe(409);
    expect((await post('/api/varieties/crop-types/retire', {})).status).toBe(400);
    expect(writes()).toHaveLength(0);
  });
});

describe('restore', () => {
  it('the admin page brings a retired type back by slug, and it reads back live', async () => {
    db([type('radish', 'Radish', { deleted_at: '2026-10-01T00:00:00.000Z' })]);
    const res = await post('/api/varieties/crop-types', { restore_slug: 'radish' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ slug: 'radish', restored: true });
    const list = await get('/api/varieties/crop-types/admin');
    expect(list.body.types[0]).toMatchObject({ slug: 'radish', retired: false, can_retire: true });
  });

  it('an admin typing a retired type\'s name in an inline form restores it, as before', async () => {
    db([type('radish', 'Radish', { deleted_at: '2026-10-01T00:00:00.000Z' })]);
    const res = await post('/api/varieties/crop-types', { display_name: 'Radish' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ slug: 'radish', restored: true });
    expect(table[0].deleted_at).toBeNull();
  });

  it('answers 409 for a type that is not retired and 404 for an unknown slug', async () => {
    db([type('radish', 'Radish')]);
    expect((await post('/api/varieties/crop-types', { restore_slug: 'radish' })).status).toBe(409);
    expect((await post('/api/varieties/crop-types', { restore_slug: 'nope' })).status).toBe(404);
    expect(auditLines()).toEqual([]);
  });
});

describe('the record of who did it', () => {
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  it('auditLine is one JSON line with exactly evt, slug, by, at', () => {
    const line = auditLine('crop_type_retired', 'radish', ADMIN, new Date('2026-10-12T01:02:03.000Z'));
    expect(line).toBe('{"evt":"crop_type_retired","slug":"radish","by":"user_admin","at":"2026-10-12T01:02:03.000Z"}');
  });

  it('a retire writes one line and no event_log row', async () => {
    db([type('radish', 'Radish')]);
    await post('/api/varieties/crop-types/retire', { slug: 'radish' });
    const lines = auditLines();
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(Object.keys(rec)).toEqual(['evt', 'slug', 'by', 'at']);
    expect(rec).toMatchObject({ evt: 'crop_type_retired', slug: 'radish', by: ADMIN });
    expect(rec.at).toMatch(ISO);
    expect(stubState.sqlCalls.some((c) => /event_log/.test(c.text))).toBe(false);
  });

  it.each([
    ['the admin page', { restore_slug: 'radish' }],
    ['an inline name match', { display_name: 'Radish' }],
  ])('a restore through %s writes one line and no event_log row', async (_door, body) => {
    db([type('radish', 'Radish', { deleted_at: '2026-10-01T00:00:00.000Z' })]);
    await post('/api/varieties/crop-types', body);
    const lines = auditLines();
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(Object.keys(rec)).toEqual(['evt', 'slug', 'by', 'at']);
    expect(rec).toMatchObject({ evt: 'crop_type_restored', slug: 'radish', by: ADMIN });
    expect(rec.at).toMatch(ISO);
    expect(stubState.sqlCalls.some((c) => /event_log/.test(c.text))).toBe(false);
  });
});

describe('the admin gate', () => {
  it('copies the fail-closed helper: empty or unset means nobody', () => {
    expect(isAdmin(ADMIN, { ADMIN_CLERK_SUBS: `x, ${ADMIN}` })).toBe(true);
    expect(isAdmin(OTHER, { ADMIN_CLERK_SUBS: ADMIN })).toBe(false);
    expect(isAdmin(ADMIN, {})).toBe(false);
    expect(isAdmin(ADMIN, { ADMIN_CLERK_SUBS: ' , ' })).toBe(false);
    expect(isAdmin('', { ADMIN_CLERK_SUBS: '' })).toBe(false);
    expect(adminRefusal(ADMIN, { ADMIN_CLERK_SUBS: ADMIN })).toBeNull();
    expect(adminRefusal(OTHER, { ADMIN_CLERK_SUBS: ADMIN })).toEqual({ error: 'Admin only' });
  });

  it('refuses a non-admin on retire, and the type reads back live', async () => {
    db([type('radish', 'Radish')]);
    as(OTHER);
    const res = await post('/api/varieties/crop-types/retire', { slug: 'radish' });
    expect(res).toEqual({ status: 403, body: { error: 'Admin only' } });
    expect(stubState.sqlCalls).toHaveLength(0);
    expect(table[0].deleted_at).toBeNull();
  });

  it('refuses a non-admin on the listing', async () => {
    db([type('radish', 'Radish')]);
    as(OTHER);
    expect(await get('/api/varieties/crop-types/admin')).toEqual({ status: 403, body: { error: 'Admin only' } });
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('refuses a non-admin on the admin page\'s restore', async () => {
    db([type('radish', 'Radish', { deleted_at: '2026-10-01T00:00:00.000Z' })]);
    as(OTHER);
    const res = await post('/api/varieties/crop-types', { restore_slug: 'radish' });
    expect(res).toEqual({ status: 403, body: { error: 'Admin only' } });
    expect(stubState.sqlCalls).toHaveLength(0);
    expect(table[0].deleted_at).not.toBeNull();
  });

  it('refuses a non-admin whose inline name matches a retired type, with the distinct code', async () => {
    db([type('radish', 'Radish', { deleted_at: '2026-10-01T00:00:00.000Z' })]);
    as(OTHER);
    const res = await post('/api/varieties/crop-types', { display_name: 'Radish' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: RETIRED_MESSAGE, code: RETIRED_CODE });
    expect(res.body.error).toBe("That crop type was retired. Ask the garden's admin to bring it back.");
    expect(writes()).toHaveLength(0);
    expect(table[0].deleted_at).not.toBeNull();
    expect(auditLines()).toEqual([]);
  });

  it('still lets a non-admin create a new type and be steered to a live one', async () => {
    db([type('radish', 'Radish')]);
    as(OTHER);
    stubState.sqlHandler = ((inner) => (text, values) => (
      text.includes('INSERT INTO public.crop_types')
        ? [{ slug: values[0], display_name: values[1], default_lifecycle: null, category: null, sort_order: 0 }]
        : inner(text, values)))(stubState.sqlHandler);
    expect((await post('/api/varieties/crop-types', { display_name: 'Luffa' })).status).toBe(201);
    const steer = await post('/api/varieties/crop-types', { display_name: 'Radish' });
    expect(steer.status).toBe(409);
    expect(steer.body.reason).toBe('exists');
  });

  it.each([['unset', undefined], ['empty', ''], ['blank', ' , ']])(
    'ADMIN_CLERK_SUBS %s refuses everyone, with the not-switched-on code',
    async (_name, value) => {
      if (value === undefined) delete process.env.ADMIN_CLERK_SUBS;
      else process.env.ADMIN_CLERK_SUBS = value;
      db([type('radish', 'Radish'), type('turnip', 'Turnip', { deleted_at: '2026-10-01T00:00:00.000Z' })]);
      const refused = { status: 403, body: { error: 'Admin only', code: NOT_CONFIGURED_CODE } };
      expect(await get('/api/varieties/crop-types/admin')).toEqual(refused);
      expect(await post('/api/varieties/crop-types/retire', { slug: 'radish' })).toEqual(refused);
      expect(await post('/api/varieties/crop-types', { restore_slug: 'turnip' })).toEqual(refused);
      const inline = await post('/api/varieties/crop-types', { display_name: 'Turnip' });
      expect(inline).toEqual({ status: 403, body: { error: RETIRED_MESSAGE, code: RETIRED_CODE } });
      expect(writes()).toHaveLength(0);
    },
  );
});

describe('the listing', () => {
  it('includes retired types, with counts, whether each can be retired, and why not', async () => {
    db([
      type('radish', 'Radish'),
      type('pepper', 'Pepper', { varieties: 40, put_ups: 1 }),
      type('bread', 'Bread', { category: 'non_plant_food' }),
      type('turnip', 'Turnip', { deleted_at: '2026-10-01T00:00:00.000Z' }),
      type('dogwood', 'Dogwood', { category: 'tree' }),
      type('aloe', 'Aloe', { category: 'succulent', deleted_at: '2026-10-01T00:00:00.000Z' }),
    ]);
    const res = await get('/api/varieties/crop-types/admin');
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.types.map((t) => [t.slug, t]));
    expect(by.radish).toMatchObject({ retired: false, can_retire: true, why_not: null, counts: ZERO });
    expect(by.pepper).toMatchObject({ can_retire: false, why_not: 'Still used by 40 varieties and 1 put-up.' });
    expect(by.bread).toMatchObject({ can_retire: false, why_not: FOOD_CLASS_REFUSAL });
    expect(by.dogwood).toMatchObject({ retired: false, can_retire: false, why_not: GATE_REQUIRED_REFUSAL, counts: ZERO });
    // Already retired (by hand, or before the list knew it): no reason, and Bring back is offered.
    expect(by.aloe).toMatchObject({ retired: true, can_retire: false, why_not: null });
    expect(by.turnip).toMatchObject({ retired: true, can_retire: false, why_not: null, retired_at: '2026-10-01T00:00:00.000Z' });
  });

  it('usageSentence and describeType word singulars, plurals and lists', () => {
    expect(usageSentence(ZERO)).toBeNull();
    expect(usageSentence({ ...ZERO, varieties: 1 })).toBe('Still used by 1 variety.');
    expect(usageSentence({ varieties: 2, put_ups: 1, pantry_items: 1, batches: 2, put_up_sources: 1 }))
      .toBe('Still used by 2 varieties, 1 put-up, 1 pantry item, 2 batches and 1 put-up source.');
    expect(describeType(type('x', 'X', { put_up_sources: 1 })).why_not).toBe('Still used by 1 put-up source.');
  });
});

// ── static: the dependents census and the guard inside the write ────────────────────────────────
const REPO = resolve(__dirname, '..', '..');
const sqlFiles = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? sqlFiles(p) : (f.endsWith('.sql') ? [p] : []);
});
const stripSqlComments = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

// Every table that declares a foreign key to crop_types: the table named by the nearest CREATE TABLE
// or ALTER TABLE above each REFERENCES clause.
function foreignKeyTables() {
  const found = new Set();
  for (const file of sqlFiles(join(REPO, 'migrations'))) {
    const src = stripSqlComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/\bREFERENCES\s+(?:public\.)?crop_types\b/gi)) {
      const owners = [...src.slice(0, m.index).matchAll(
        /\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?)\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi,
      )];
      expect(owners.length, `no owning table found for a crop_types reference in ${file}`).toBeGreaterThan(0);
      found.add(owners[owners.length - 1][1].toLowerCase());
    }
  }
  return [...found].sort();
}

describe('the dependents census', () => {
  // plant_varieties is read through its view, as everywhere in this directory.
  const RELATION = { plant_varieties: 'cultivar' };
  const SRC = readFileSync(resolve(__dirname, 'crop-type-admin.js'), 'utf8');
  const statement = (marker) => {
    const all = [...SRC.matchAll(/sql`([\s\S]*?)`/g)].map((m) => m[1]).filter((s) => s.includes(marker));
    expect(all).toHaveLength(1);
    return all[0];
  };

  it('the guard knows every table with a foreign key to crop_types(slug)', () => {
    // A new table that references crop_types fails here until CROP_TYPE_DEPENDENTS, the usage read
    // and the retire guard all cover it. Without that, retire would hide a type its rows still name.
    expect(foreignKeyTables()).toEqual(CROP_TYPE_DEPENDENTS.map((d) => d.table).sort());
  });

  it('finds the five known foreign keys, so the census is not vacuous', () => {
    expect(foreignKeyTables()).toEqual(
      ['kitchen_batch_input', 'pantry_item', 'plant_varieties', 'preservation_log', 'preservation_source'],
    );
  });

  it.each(CROP_TYPE_DEPENDENTS.map((d) => [d.table, d]))(
    'counts every %s row in the listing, deleted ones included, and refuses on them inside the retire write',
    (tableName, d) => {
      const rel = RELATION[tableName] ?? tableName;
      // The predicate is the foreign key and nothing else: `\)` straight after it.
      const any = String.raw`FROM public\.${rel} (\w+)\s+WHERE \1\.crop_type_slug = ct\.slug\)`;
      expect(statement('AS put_up_sources')).toMatch(new RegExp(String.raw`\(SELECT count\([^)]*\)::int ${any} AS ${d.key}\b`));
      expect(statement('SET deleted_at = now()')).toMatch(new RegExp(String.raw`AND NOT EXISTS \(SELECT 1 ${any}`));
    },
  );

  it('filters no dependent table on a soft-delete column in either statement', () => {
    // deleted_at is the only soft-delete or archive column any of the five tables has (migrations/),
    // and public.cultivar is plant_varieties with no WHERE. The one deleted_at each statement may
    // name is crop_types' own.
    for (const marker of ['AS put_up_sources', 'SET deleted_at = now()']) {
      const named = [...statement(marker).matchAll(/\b(\w+)\.(deleted_at|archived_at|archived)\b/g)].map((m) => m[1]);
      expect([...new Set(named)], marker).toEqual(['ct']);
    }
  });

  it('the retire write also refuses a retired type and a food class, and sets updated_at by hand', () => {
    const upd = statement('SET deleted_at = now()');
    expect(upd).toMatch(/SET deleted_at = now\(\), updated_at = now\(\)/);
    expect(upd).toMatch(/AND ct\.deleted_at IS NULL/);
    expect(upd).toMatch(/AND \(ct\.category IS NULL OR ct\.category <> \$\{NON_PLANT_FOOD_CATEGORY\}\)/);
    expect(upd).toMatch(/AND NOT \(ct\.slug = ANY\(\$\{GATE_REQUIRED_SLUGS\}::text\[\]\)\)/);
    expect(statement('SET deleted_at = NULL')).toMatch(/SET deleted_at = NULL, updated_at = now\(\)/);
  });

  it('writes nothing to event_log', () => {
    expect(SRC.replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/event_log/);
  });
});

// ── static: the crop types a standing database gate requires to be live ─────────────────────────
//
// gate-invariants.yml re-runs every CONTINUOUS post-gate against prod and staging each week. A retire
// changes exactly one thing a gate can see, crop_types.deleted_at, so the gates that matter are the
// ones that read crop_types and name that column. Each is sorted into one of three kinds:
//   needs the type live   it expects a positive count of live named types, or is listed in COMPOUND
//                         as 'requires'. Its slugs go into the list.
//   cannot be failed      it expects ZERO from one plain SELECT over live rows. Hiding a row can only
//                         lower that count.
//   compound              it expects zero but is not one plain SELECT (a subquery, a JOIN, 1 - count).
//                         Nothing here can tell which way it cuts, so each is decided by hand in
//                         COMPOUND, and one that is not listed there FAILS this test.
// So a new gate that needs a type live reds this file until GATE_REQUIRED_SLUGS follows, and a new
// gate of a shape nobody has read reds it until somebody does.
const SCHEMA_VERSION_ARM = /(?<!NOT\s)EXISTS\s*\(\s*SELECT 1 FROM public\.schema_version\s+WHERE version\s*=\s*'[^']*'\s*\)/gi;
const COMPOUND = {
  // 1 - (count of the live garlic row with its seeded values) must be 0: garlic has to be live.
  'v4-garlicannual-001/post_garlic_row_actually_applied': 'requires',
  // No wanted food slug may lack a live row. (Also refused by category; listed because it is true.)
  'v4-putupfood-001/post_all_seven_food_types_present': 'requires',
  // The next three fail only while a variety row still names the type, and the in-use guard already
  // refuses a type any variety row names, deleted ones included.
  'v4-croptypealoe-001/post_cultivar_resolves_to_a_real_crop_type': 'held by the in-use guard',
  'v4-croptypedogwood-001/post_no_cultivar_dangles_off_dogwood': 'held by the in-use guard',
  'v5-frostband-001/post_no_cultivar_typed_to_a_dead_new_crop_type': 'held by the in-use guard',
  // x IS DISTINCT FROM x over a LEFT JOIN: never true, whatever is retired.
  'v4-dtmbasisvar-001/post_lambda_join_shape_resolves': 'cannot be failed by a retire',
  // Live types with no habit AND a live planting: the outer scan is of live rows, so hiding one
  // lowers the count.
  'v4-harvhabitgap-001/post_no_unseeded_slug_has_a_live_planting': 'cannot be failed by a retire',
};

// The slugs a gate names, read from the places a slug can stand: slug = 'x'; slug IN ('x', ...);
// the first member of each tuple when the statement pairs slug with another column, as
// (slug, display_name) IN (...) and VALUES (...) AS owned(slug, aliases) do; unnest(ARRAY[...]) AS
// want(slug). `\bslug` does not match inside crop_type_slug.
function slugsNamed(sql) {
  const lits = (s) => [...s.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
  const out = [...sql.matchAll(/\bslug\s*=\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
  for (const m of sql.matchAll(/\bslug\s+IN\s*\(([^()]*)\)/g)) out.push(...lits(m[1]));
  if (/\(\s*slug\s*,/.test(sql)) out.push(...[...sql.matchAll(/\(\s*'([a-z0-9_]+)'\s*,/g)].map((m) => m[1]));
  for (const m of sql.matchAll(/unnest\(ARRAY\[([^\]]*)\]\)\s+AS\s+\w+\(slug\)/g)) out.push(...lits(m[1]));
  return out;
}

function gateCensus() {
  const dir = join(REPO, 'migrations');
  const requiring = [];
  const compound = [];
  let read = 0;
  for (const m of readdirSync(dir).sort()) {
    let doc;
    try { doc = yaml.load(readFileSync(join(dir, m, 'gates.yml'), 'utf8')) ?? {}; } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue;
      throw e;
    }
    for (const g of doc.post ?? []) {
      // Mirrors scripts/gate_runner.py: continuous defaults to true; retired and manual gates do not run.
      if (g.continuous === false || g.retired || g.manual) continue;
      const sql = stripSqlComments(String(g.sql ?? ''));
      if (!/\bcrop_types\b/.test(sql) || !/\bdeleted_at\b/.test(sql)) continue;
      read += 1;
      const id = `${m}/${g.name}`;
      // The runner's whole vocabulary (gate_runner.py). rowcount_gte 0 cannot fail; rowcount_gte N
      // falls through to "needs the type live" like any other positive expectation.
      expect(['scalar_eq', 'rowcount_eq', 'rowcount_gte'], `${id}: an expectation this census has never read`).toContain(g.expect);
      if (g.expect === 'rowcount_gte' && g.value === 0) continue;
      const bare = sql.replace(SCHEMA_VERSION_ARM, 'TRUE');
      const plain = (bare.match(/\bSELECT\b/gi) ?? []).length === 1 && !/\bJOIN\b/i.test(bare)
        && /deleted_at\s+IS\s+NULL/i.test(bare);
      const zero = g.value === 0 && g.expect !== 'rowcount_gte';
      if (zero && plain) continue;
      if (zero) {
        compound.push(id);
        if (COMPOUND[id] !== 'requires') continue;
      }
      const slugs = slugsNamed(sql);
      requiring.push({ id, value: g.value, expect: g.expect, slugs });
    }
  }
  return { read, requiring, compound };
}

describe('the gate-required census', () => {
  const census = gateCensus();

  it('GATE_REQUIRED_SLUGS is exactly the crop types a standing gate needs live', () => {
    // Red here means migrations/**/gates.yml and the list in crop-type-admin.js have parted. Print
    // the recomputed list, paste it over the old one, and read the gate that changed it.
    const derived = [...new Set(census.requiring.flatMap((g) => g.slugs))].sort();
    expect(derived).toEqual(GATE_REQUIRED_SLUGS);
  });

  it('every compound zero-gate has been read and decided by hand', () => {
    expect(census.compound.sort()).toEqual(Object.keys(COMPOUND).sort());
  });

  it('reads the gates it is known to cover, so the census is not vacuous', () => {
    expect(census.read).toBeGreaterThanOrEqual(41);
    const by = Object.fromEntries(census.requiring.map((g) => [g.id, g]));
    expect(Object.keys(by).sort()).toEqual([
      'v4-croptypealias-001/post_display_names_untouched',
      'v4-croptypealias-001/post_own_53_aliases_intact',
      'v4-croptypealias-002/post_cilantro_alias',
      'v4-croptypealias-002/post_thunbergia_alias',
      'v4-croptypealias-002/post_winter_squash_alias_appended',
      'v4-croptypealoe-001/post_aloe_crop_type_exists',
      'v4-croptypedogwood-001/post_dogwood_crop_type_exists',
      'v4-garlicannual-001/post_garlic_row_actually_applied',
      'v4-putupfood-001/post_all_seven_food_types_present',
      'v4-putupprov-002-fruitseed/post_all_thirteen_fruit_types_present',
      'v4-wintergreenstypes-001/post_all_four_present',
    ]);
    expect(by['v4-putupprov-002-fruitseed/post_all_thirteen_fruit_types_present'].slugs.sort()).toEqual([
      'apple', 'apricot', 'blackberry', 'cherry', 'cranberry', 'elderberry', 'grape', 'nectarine',
      'pear', 'plum', 'raspberry', 'rhubarb', 'sour_cherry',
    ]);
    expect(by['v4-wintergreenstypes-001/post_all_four_present'].slugs.sort()).toEqual(['claytonia', 'mache', 'mizuna', 'tatsoi']);
    for (const s of ['aloe', 'dogwood', 'thunbergia', 'cilantro', 'winter_squash', 'garlic']) {
      expect(GATE_REQUIRED_SLUGS).toContain(s);
    }
  });

  it('a gate that counts N live types names exactly N slugs', () => {
    // The two count-style gates (53 alias rows, 13 display names) are derived, not listed by hand:
    // each counts rows matched to a slug it spells out, and this is the check that every one was read.
    for (const g of census.requiring.filter((r) => r.value > 0 && r.expect !== 'rowcount_gte')) {
      expect(new Set(g.slugs).size, g.id).toBe(g.value);
    }
    for (const g of census.requiring) expect(g.slugs.length, g.id).toBeGreaterThan(0);
  });

  it('the list is sorted and has no duplicate', () => {
    expect([...new Set(GATE_REQUIRED_SLUGS)].sort()).toEqual(GATE_REQUIRED_SLUGS);
  });
});
