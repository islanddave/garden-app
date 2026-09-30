// Put-Up release 4 — /api/recipes, EXECUTED against a mock driver (the fermentRoutes.test.js idiom): the route
// table, the body rules (link_url scheme included), every route's statement and answers for DAVE / JEN (one
// household) and STRANGER, the replays, "Save as recipe" reading every F §1.5 column, the type find-or-create,
// batch create's recipe_id gate, getBatch's recipe key, and the recipe basis for discard-by (V4 §3.1/§3.2/§3.4).
// What the SQL does on a real database is tests/integration/recipes-*.int.test.js's.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRecipeRoute, loadOwnedRecipe } from './recipeRoutes.js';
import {
  parseRecipeRoute, validateRecipeCreate, validateRecipePatch, linkUrlError, keepsError, recipeLineError,
  recipePatchPlan, validateTypeCreate, typeLabelOf, RECIPE_BUILTIN_TYPES, RECIPE_STORAGE_KINDS,
} from './recipeRules.js';
import { handleKitchenRoute } from './kitchenRoutes.js';
import { planPutUp } from './putUp.js';
import { recipeUseBy, addDays, RECIPE_KEEPS_UNITS } from './shelfLife.js';
import { moveUseBy, correctionUseBy, PLACE_KINDS } from './jarRoutes.js';
import { KITCHEN_BATCH_KINDS } from './kitchenBatch.js';

const here = dirname(fileURLToPath(import.meta.url));
const DAVE = 'user_dave';
const HOUSEHOLD = ['user_dave', 'user_jen'];
const STRANGER = ['user_stranger'];
const R1 = 'aaaaaaaa-1111-4222-8333-444444444444';
const BATCH = 'bbbbbbbb-1111-4222-8333-444444444444';
const TYPE = '7ec1be00-0000-4000-8000-000000000001';
const MY_TYPE = 'cccccccc-1111-4222-8333-444444444444';
const K1 = '11111111-1111-4222-8333-444444444444';

function mockSql(queue = []) {
  const calls = [];
  const fn = (strings, ...values) => {
    const text = strings.raw.join('?');
    calls.push({ text, norm: text.replace(/\s+/g, ' ').trim(), values });
    if (!queue.length) return Promise.reject(new Error(`unexpected extra query: ${text.replace(/\s+/g, ' ').slice(0, 90)}`));
    const next = queue.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  fn.transaction = async (qs) => Promise.all(qs);
  fn.calls = calls;
  return fn;
}
const route = (path, method, body, householdIds = HOUSEHOLD, query = {}) => ({
  rawPath: path, method, rawBody: body == null ? null : JSON.stringify(body), query, userId: DAVE, householdIds,
});
const err = (code, constraint) => Object.assign(new Error(code), { code, constraint });
// The value bound right after `needle` in a call's SQL (the placeholder that follows it).
const after = (call, needle) => {
  const at = call.norm.indexOf(needle);
  expect(at, `SQL lacks ${needle}`).toBeGreaterThan(-1);
  return call.values[(call.norm.slice(0, at + needle.length).match(/\?/g) ?? []).length];
};
const RECIPE_ROW = { id: R1, user_id: DAVE, name: 'Petri Dish Pioneer', kind: 'ferment', recipe_type_id: TYPE,
  type_label: 'Hot sauce', link_url: null, notes: 'Steps as written.', keeps_n: 2, keeps_unit: 'month',
  keeps_storage_kind: 'fridge' };
const LINE_ROW = { id: 'l1', ordinal: 1, name: 'jalapeño', amount_text: '170 g fresh jalapeño', qty: '170', qty_unit: 'g', at_the_end: false };
const BATCH_ROW = { id: BATCH, user_id: 'user_jen', label: 'Petri Dish', started_at: '2026-09-20T16:00:00Z', outcome: 'put_up', closed_at: '2026-10-02T00:00:00Z' };
// readRecipe's three reads: the row, its lines, its batches.
const READ = [[RECIPE_ROW], [LINE_ROW], [BATCH_ROW]];
const body = (over = {}) => ({ idempotency_key: K1, name: 'Petri Dish Pioneer', ...over });

// ── the route table ─────────────────────────────────────────────────────────────────────────────
describe('parseRecipeRoute — literals before :id, and an :id is a uuid', () => {
  it.each([
    ['/api/recipes', { kind: 'collection' }],
    ['/api/recipes/', { kind: 'collection' }],
    ['/api/recipes/types', { kind: 'types' }],
    [`/api/recipes/types/${MY_TYPE}`, { kind: 'type', id: MY_TYPE }],
    [`/api/recipes/from-batch/${BATCH}`, { kind: 'from_batch', batchId: BATCH }],
    [`/api/recipes/${R1}`, { kind: 'recipe', id: R1 }],
    ['/api/recipes/nope', { kind: 'bad_id' }],
    ['/api/recipes/from-batch/nope', { kind: 'bad_id' }],
    ['/api/recipesx', null],
    [`/api/recipes/${R1}/lines`, null],
    ['/api/kitchen-batches', null],
  ])('%s', (path, want) => expect(parseRecipeRoute(path)).toEqual(want));

  it('a path that is not ours falls through (null), a malformed id is a 404 without a query', async () => {
    expect(await handleRecipeRoute({ sql: mockSql(), ...route('/api/preservation', 'GET') })).toBeNull();
    const sql = mockSql();
    expect((await handleRecipeRoute({ sql, ...route('/api/recipes/nope', 'GET') })).status).toBe(404);
    expect(sql.calls).toHaveLength(0);
  });

  it('unknown verbs are 405', async () => {
    expect((await handleRecipeRoute({ sql: mockSql(), ...route('/api/recipes', 'PUT', {}) })).status).toBe(405);
    expect((await handleRecipeRoute({ sql: mockSql(), ...route(`/api/recipes/${R1}`, 'PUT', {}) })).status).toBe(405);
    expect((await handleRecipeRoute({ sql: mockSql(), ...route(`/api/recipes/from-batch/${BATCH}`, 'GET') })).status).toBe(405);
  });
});

// ── the body rules ───────────────────────────────────────────────────────────────────────────────
describe('link_url — http/https only (V4 §2.6)', () => {
  it.each([
    'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,hi', 'ftp://example.com/x', 'mailto:a@b.c',
    'example.com/recipe', '//example.com/x', 'https://', 'https://exa mple.com', '   ', 'x'.repeat(10),
    `https://example.com/${'a'.repeat(2000)}`,
  ])('%s → refused', (v) => expect(linkUrlError(v)).toBeTruthy());

  it.each(['https://example.com/recipes/mojo?x=1#y', 'http://example.com', 'HTTPS://Example.com/A'])('%s → ok', (v) => {
    expect(linkUrlError(v)).toBeNull();
  });

  it('a non-string link is refused, null is fine', () => {
    expect(linkUrlError(42)).toBeTruthy();
    expect(linkUrlError(null)).toBeNull();
  });
});

describe('the keeps line and the lines', () => {
  it('keeps: all three or none; n a whole number 1..1000; unit and storage kind from their vocabularies', () => {
    expect(keepsError(null)).toBeNull();
    expect(keepsError({ n: 7, unit: 'day', storage_kind: 'fridge' })).toBeNull();
    expect(keepsError({ n: 7, unit: 'day' })).toMatch(/storage_kind/);
    expect(keepsError({ n: 0, unit: 'day', storage_kind: 'fridge' })).toMatch(/whole number/);
    expect(keepsError({ n: 1.5, unit: 'day', storage_kind: 'fridge' })).toMatch(/whole number/);
    expect(keepsError({ n: 2, unit: 'year', storage_kind: 'fridge' })).toMatch(/keeps.unit/);
    expect(keepsError({ n: 2, unit: 'week', storage_kind: 'shelf' })).toMatch(/keeps.storage_kind/);
    expect(keepsError({ n: 2, unit: 'week', storage_kind: 'fridge', note: 'x' })).toMatch(/unknown/);
    expect(RECIPE_STORAGE_KINDS).toEqual(PLACE_KINDS);
  });

  const ok = (over) => ({ name: 'garlic', ...over });
  it.each([
    [{ name: ' ' }, /name is required/],
    [{ name: 'x'.repeat(201) }, /at most 200/],
    [{ qty: 5 }, /both be set/],
    [{ qty: 0, qty_unit: 'g' }, /greater than 0/],
    [{ qty: 5, qty_unit: 'quarts' }, /qty_unit must be one of/],
    [{ form: 'pickled' }, /form must be one of/],
    [{ role: 'oil' }, /role must be one of/],
    [{ role: 'water', form: 'fresh' }, /no form/],
    [{ role: 'salt', shu_rating_low: 5 }, /no heat rating/],
    [{ shu_rating_high: 500 }, /needs its low end/],
    [{ shu_rating_low: 800, shu_rating_high: 500 }, /at least shu_rating_low/],
    [{ salt_pct: 3 }, /only on a salt line/],
    [{ role: 'salt', salt_pct: 3, qty: 5, qty_unit: 'g' }, /go together/],
    [{ role: 'salt', salt_pct: 3, salt_base: 'produce', base_g: 200, qty: 5, qty_unit: 'oz' }, /weighed in g/],
    [{ role: 'salt', salt_pct: 3, salt_base: 'peppers', base_g: 200, qty: 5, qty_unit: 'g' }, /salt_base must be one of/],
    [{ salt_method: 'dry' }, /only on a salt line/],
    [{ role: 'salt', base_from: 'scale' }, /needs the base weight/],
    [{ at_the_end: 'yes' }, /true or false/],
    [{ ordinal: -1 }, /ordinal/],
    [{ brand: ' ' }, /brand cannot be blank/],
    [{ surprise: 1 }, /unknown field/],
  ])('%o → 400', (over, want) => expect(recipeLineError(ok(over))).toMatch(want));

  it('good lines: as written, at the end, a salt line with its facts, listed heat', () => {
    expect(recipeLineError(ok({ amount_text: '8 g garlic (2 cloves, halved)', qty: 8, qty_unit: 'g' }))).toBeNull();
    expect(recipeLineError(ok({ amount_text: 'pinch', at_the_end: true }))).toBeNull();
    expect(recipeLineError(ok({ name: 'salt', role: 'salt', qty: '20.0', qty_unit: 'g', salt_pct: 2.5,
      salt_base: 'all', base_g: 800, salt_method: 'brine', base_from: 'lines' }))).toBeNull();
    expect(recipeLineError(ok({ name: 'gochugaru', form: 'dried', brand: 'Taekyung', shu_rating_low: 4000, shu_rating_high: 8000 }))).toBeNull();
  });
});

describe('validateRecipeCreate / validateRecipePatch', () => {
  it('create: a keyed body with a name; server-owned and unknown fields refused', () => {
    expect(validateRecipeCreate(body())).toBeNull();
    expect(validateRecipeCreate(body({ idempotency_key: 'x' }))).toMatch(/idempotency_key/);
    expect(validateRecipeCreate(body({ idempotency_key: undefined }))).toMatch(/idempotency_key/);
    expect(validateRecipeCreate(body({ name: '  ' }))).toMatch(/name/);
    expect(validateRecipeCreate(body({ user_id: 'user_jen' }))).toMatch(/set by the server/);
    expect(validateRecipeCreate(body({ target_ph: '3' }))).toMatch(/unknown field/);
    expect(validateRecipeCreate(body({ tested: true }))).toMatch(/unknown field/);
    expect(validateRecipeCreate(body({ kind: 'sauce' }))).toMatch(/kind must be one of/);
    expect(validateRecipeCreate(body({ link_url: 'javascript:void(0)' }))).toMatch(/http/);
    expect(validateRecipeCreate(body({ recipe_type_id: 'x' }))).toMatch(/recipe_type_id/);
    expect(validateRecipeCreate(body({ notes: '   ' }))).toMatch(/notes cannot be blank/);
    expect(validateRecipeCreate(body({ vessel_size: 1 }))).toMatch(/sent together/);
    expect(validateRecipeCreate(body({ vessel_count: 51 }))).toMatch(/vessel_count/);
    expect(validateRecipeCreate(body({ made_g: 0 }))).toMatch(/made_g/);
    expect(validateRecipeCreate(body({ lines: [{ name: 'x' }, { name: '' }] }))).toMatch(/line 2/);
    expect(validateRecipeCreate(body({ lines: Array.from({ length: 61 }, () => ({ name: 'x' })) }))).toMatch(/at most 60/);
    expect(validateRecipeCreate(body({ kind: 'ferment', link_url: 'https://example.com', notes: 'x',
      keeps: { n: 2, unit: 'month', storage_kind: 'fridge' }, vessel_label: 'quart jar', vessel_size: '1',
      vessel_unit: 'qt', vessel_count: 1, no_salt: true, mash_in_g: 180, made_g: '256.0', lines: [{ name: 'x' }] }))).toBeNull();
  });

  it('the kind vocabulary is the batch-kind vocabulary', () => {
    for (const k of KITCHEN_BATCH_KINDS) expect(validateRecipeCreate(body({ kind: k }))).toBeNull();
  });

  it('patch: presence-sentinel; never the key, the owner or an empty name; lines null is refused', () => {
    expect(validateRecipePatch({})).toMatch(/nothing to update/);
    expect(validateRecipePatch({ name: '' })).toMatch(/cannot be empty/);
    expect(validateRecipePatch({ name: null })).toMatch(/cannot be empty/);
    expect(validateRecipePatch({ idempotency_key: K1 })).toMatch(/cannot be edited/);
    expect(validateRecipePatch({ user_id: 'x' })).toMatch(/cannot be edited/);
    expect(validateRecipePatch({ lines: null })).toMatch(/send \[\]/);
    expect(validateRecipePatch({ link_url: 'data:x' })).toMatch(/http/);
    expect(validateRecipePatch({ link_url: null, keeps: null, notes: null, lines: [] })).toBeNull();
  });

  it('the patch plan keeps absent and null apart, and notes VERBATIM', () => {
    const plan = recipePatchPlan({ notes: '  Target as he wrote it.\n\n**Steps**  ', keeps: null });
    expect(plan.present).toMatchObject({ notes: true, keeps: true, name: false, lines: false, link_url: false });
    expect(plan.value.notes).toBe('  Target as he wrote it.\n\n**Steps**  ');
    expect(plan.value).toMatchObject({ keeps_n: null, keeps_unit: null, keeps_storage_kind: null });
    const lines = recipePatchPlan({ lines: [{ name: ' a ', qty: '5.50', qty_unit: 'g' }, { name: 'b', ordinal: 7 }] }).lines;
    expect(lines).toMatchObject({ ordinal: [1, 7], name: ['a', 'b'], qty: ['5.50', null], at_the_end: [false, false] });
  });
});

// ── GET /api/recipes ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/recipes — the household list', () => {
  it('binds the household (DAVE sees JEN\'s recipes), carries no notes, orders by name', async () => {
    const sql = mockSql([[{ ...RECIPE_ROW, user_id: 'user_jen', notes: undefined }]]);
    const r = await handleRecipeRoute({ sql, ...route('/api/recipes', 'GET') });
    expect(r.status).toBe(200);
    expect(r.body.recipes).toHaveLength(1);
    const c = sql.calls[0];
    expect(c.values).toContainEqual(HOUSEHOLD);
    expect(c.norm).toMatch(/r\.user_id = ANY\(\?\)/);
    expect(c.norm).toMatch(/r\.deleted_at IS NULL/);
    expect(c.norm).not.toMatch(/\bnotes\b/);
    expect(c.norm).not.toMatch(/\bph\b|ph_/i);
    expect(c.norm).toMatch(/ORDER BY lower\(r\.name\), r\.id/);
  });

  it('STRANGER: the same statement with the stranger\'s own ids, so it answers an empty list', async () => {
    const sql = mockSql([[]]);
    const r = await handleRecipeRoute({ sql, ...route('/api/recipes', 'GET', null, STRANGER) });
    expect(r.body).toEqual({ recipes: [] });
    expect(sql.calls[0].values).toContainEqual(STRANGER);
  });

  it('?type_id= narrows by type (a malformed one is ignored, never bound as a uuid)', async () => {
    let sql = mockSql([[]]);
    await handleRecipeRoute({ sql, ...route('/api/recipes', 'GET', null, HOUSEHOLD, { type_id: TYPE }) });
    expect(sql.calls[0].values).toContain(TYPE);
    sql = mockSql([[]]);
    await handleRecipeRoute({ sql, ...route('/api/recipes', 'GET', null, HOUSEHOLD, { type_id: 'x' }) });
    expect(sql.calls[0].values).not.toContain('x');
  });
});

// ── GET /api/recipes/:id ─────────────────────────────────────────────────────────────────────────
describe('GET /api/recipes/:id — recipe detail', () => {
  it('notes verbatim, lines in order, the dated batches made from it — and NEVER a pH', async () => {
    const sql = mockSql(READ.map((x) => [...x]));
    const r = await handleRecipeRoute({ sql, ...route(`/api/recipes/${R1}`, 'GET') });
    expect(r.status).toBe(200);
    expect(r.body.recipe).toMatchObject({ id: R1, notes: 'Steps as written.', lines: [LINE_ROW], batches: [BATCH_ROW] });
    const [row, lines, batches] = sql.calls;
    expect(row.norm).toMatch(/r\.notes/);
    expect(row.values).toContainEqual(HOUSEHOLD);
    expect(lines.norm).toMatch(/ORDER BY ordinal, id/);
    expect(lines.norm).toMatch(/deleted_at IS NULL/);
    // The batch list is an explicit list: no reading, no free-text ending note, no SELECT *.
    expect(batches.norm).not.toMatch(/ph_|\bph\b/i);
    expect(batches.norm).not.toMatch(/outcome_note/);
    expect(batches.norm).not.toMatch(/SELECT \*/);
    expect(batches.norm).toMatch(/b\.recipe_id = \?::uuid/);
    expect(batches.values).toContainEqual(HOUSEHOLD);
  });

  it('STRANGER → 404 (the row read answers nothing), and nothing more is read', async () => {
    const sql = mockSql([[]]);
    const r = await handleRecipeRoute({ sql, ...route(`/api/recipes/${R1}`, 'GET', null, STRANGER) });
    expect(r.status).toBe(404);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].values).toContainEqual(STRANGER);
  });
});

// ── POST /api/recipes ────────────────────────────────────────────────────────────────────────────
describe('POST /api/recipes — keyed create, recipe and lines in ONE statement', () => {
  const full = body({
    kind: 'ferment', recipe_type_id: TYPE, link_url: 'https://example.com/petri', notes: 'Steps.',
    keeps: { n: 2, unit: 'month', storage_kind: 'fridge' },
    lines: [
      { name: 'jalapeño', amount_text: '170 g fresh jalapeño', qty: 170, qty_unit: 'g', form: 'fresh' },
      { name: 'garlic', amount_text: '8 g garlic', qty: 8, qty_unit: 'g', at_the_end: true },
    ],
  });

  it('JEN creates: the type is household-loaded first, then one INSERT…unnest; the owner is the caller', async () => {
    const sql = mockSql([[{ id: TYPE, label: 'Hot sauce' }], [{ id: R1, line_count: 2 }], ...READ.map((x) => [...x])]);
    const r = await handleRecipeRoute({ sql, ...route('/api/recipes', 'POST', full), userId: 'user_jen' });
    expect(r.status).toBe(201);
    expect(r.body.recipe.id).toBe(R1);
    const [typeLoad, write] = sql.calls;
    expect(typeLoad.norm).toMatch(/FROM recipe_type/);
    expect(typeLoad.norm).toMatch(/user_id IS NULL OR user_id = ANY\(\?\)/);
    expect(typeLoad.values).toContainEqual(HOUSEHOLD);
    expect(write.norm).toMatch(/INSERT INTO recipe \(/);
    expect(write.norm).toMatch(/INSERT INTO recipe_ingredient/);
    expect(write.norm).toMatch(/unnest\(/);
    expect(write.norm).not.toMatch(/ON CONFLICT/);
    expect(write.values[0]).toBe('user_jen');
    expect(write.values).toContain(K1);
    expect(write.values).toContain('https://example.com/petri');
    expect(write.values).toContainEqual([1, 2]);
    expect(write.values).toContainEqual(['jalapeño', 'garlic']);
    expect(write.values).toContainEqual([false, true]);
    expect(write.values).toContainEqual(['170', '8']);
    // keeps → its three columns
    expect(write.values).toEqual(expect.arrayContaining([2, 'month', 'fridge']));
  });

  it('a replay (23505 on uq_recipe_idempotency_key) re-reads the recipe under the key → 200 replayed', async () => {
    const sql = mockSql([err('23505', 'uq_recipe_idempotency_key'), [{ id: R1, mine: true }], ...READ.map((x) => [...x])]);
    const r = await handleRecipeRoute({ sql, ...route('/api/recipes', 'POST', body()) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ replayed: true, recipe: { id: R1 } });
    expect(sql.calls[1].norm).toMatch(/idempotency_key = \?::uuid/);
    expect(sql.calls[1].values).toContainEqual(HOUSEHOLD);
  });

  it('a key held outside the household → 409 key_conflict, no payload', async () => {
    const sql = mockSql([err('23505', 'uq_recipe_idempotency_key'), [{ id: R1, mine: false }]]);
    const r = await handleRecipeRoute({ sql, ...route('/api/recipes', 'POST', body(), STRANGER) });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'That key is already in use.', code: 'key_conflict' });
  });

  it('any other 23505 is not a replay', async () => {
    const sql = mockSql([err('23505', 'some_other_index')]);
    await expect(handleRecipeRoute({ sql, ...route('/api/recipes', 'POST', body()) })).rejects.toThrow();
  });

  it('a malformed key, a javascript: link or a blank name → 400 before any query', async () => {
    for (const b of [body({ idempotency_key: 'nope' }), body({ link_url: 'javascript:alert(1)' }), body({ name: '' })]) {
      const sql = mockSql();
      const r = await handleRecipeRoute({ sql, ...route('/api/recipes', 'POST', b) });
      expect(r.status).toBe(400);
      expect(sql.calls).toHaveLength(0);
    }
  });

  it('a STRANGER\'s type (the loader answers nothing) → 400, nothing written', async () => {
    const sql = mockSql([[]]);
    const r = await handleRecipeRoute({ sql, ...route('/api/recipes', 'POST', body({ recipe_type_id: MY_TYPE })) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/type/);
    expect(sql.calls).toHaveLength(1);
  });

  it('a body that is not JSON → 400', async () => {
    const r = await handleRecipeRoute({ sql: mockSql(), ...route('/api/recipes', 'POST'), rawBody: '{not json' });
    expect(r.status).toBe(400);
  });
});

// ── PATCH /api/recipes/:id ───────────────────────────────────────────────────────────────────────
describe('PATCH /api/recipes/:id — presence-sentinel; lines replace in the same statement', () => {
  it('JEN edits DAVE\'s recipe: only the named columns move; the household is bound; lines untouched', async () => {
    const sql = mockSql([[{ id: R1, taken_out: 0, put_in: 0 }], ...READ.map((x) => [...x])]);
    const r = await handleRecipeRoute({ sql, ...route(`/api/recipes/${R1}`, 'PATCH', { name: 'Petri Dish II' }), userId: 'user_jen' });
    expect(r.status).toBe(200);
    const w = sql.calls[0];
    expect(w.norm).toMatch(/UPDATE recipe SET/);
    expect(after(w, 'name = CASE WHEN')).toBe(true);
    expect(after(w, 'notes = CASE WHEN')).toBe(false);
    expect(after(w, 'keeps_n = CASE WHEN')).toBe(false);
    expect(w.values).toContainEqual(HOUSEHOLD);
    expect(w.values).toContain('Petri Dish II');
    // lines: not present → neither the take-out nor the insert arms fire.
    expect(after(w, 'SET deleted_at = now() FROM r WHERE')).toBe(false);
    expect(w.norm).not.toMatch(/\buser_id =(?! ANY)/);
  });

  it('keeps: null clears all three; notes kept verbatim; lines replace the live set', async () => {
    const sql = mockSql([[{ id: R1, taken_out: 3, put_in: 1 }], ...READ.map((x) => [...x])]);
    await handleRecipeRoute({ sql, ...route(`/api/recipes/${R1}`, 'PATCH', {
      keeps: null, notes: '  as written  ', lines: [{ name: 'salt', role: 'salt', amount_text: '5 g' }],
    }) });
    const w = sql.calls[0];
    expect(after(w, 'keeps_n = CASE WHEN')).toBe(true);
    expect(after(w, 'keeps_unit = CASE WHEN')).toBe(true);
    expect(w.values).toContain('  as written  ');
    expect(after(w, 'SET deleted_at = now() FROM r WHERE')).toBe(true);
    expect(w.norm).toMatch(/INSERT INTO recipe_ingredient/);
    expect(w.values).toContainEqual(['salt']);
  });

  it('STRANGER (or a removed recipe) → 404: the UPDATE matched nothing, nothing is read back', async () => {
    const sql = mockSql([[]]);
    const r = await handleRecipeRoute({ sql, ...route(`/api/recipes/${R1}`, 'PATCH', { name: 'x' }, STRANGER) });
    expect(r.status).toBe(404);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].values).toContainEqual(STRANGER);
  });

  it('validation → 400 before any query (link scheme, unknown key, empty body)', async () => {
    for (const b of [{ link_url: 'ftp://x' }, { target_ph: 3 }, {}]) {
      const sql = mockSql();
      expect((await handleRecipeRoute({ sql, ...route(`/api/recipes/${R1}`, 'PATCH', b) })).status).toBe(400);
      expect(sql.calls).toHaveLength(0);
    }
  });
});

// ── DELETE /api/recipes/:id ──────────────────────────────────────────────────────────────────────
describe('DELETE /api/recipes/:id — soft, the recipe and its lines in one statement', () => {
  it('JEN removes: deleted_at on both, household bound, 200 {ok:true}', async () => {
    const sql = mockSql([[{ id: R1 }]]);
    const r = await handleRecipeRoute({ sql, ...route(`/api/recipes/${R1}`, 'DELETE'), userId: 'user_jen' });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    const w = sql.calls[0];
    expect(w.norm).toMatch(/UPDATE recipe SET deleted_at = now\(\)/);
    expect(w.norm).toMatch(/UPDATE recipe_ingredient i SET deleted_at = now\(\)/);
    expect(w.norm).not.toMatch(/DELETE FROM/);
    expect(w.values).toContainEqual(HOUSEHOLD);
  });

  it('STRANGER / already removed → 404', async () => {
    const sql = mockSql([[]]);
    expect((await handleRecipeRoute({ sql, ...route(`/api/recipes/${R1}`, 'DELETE', null, STRANGER) })).status).toBe(404);
  });
});

// ── POST /api/recipes/from-batch/:batchId ────────────────────────────────────────────────────────
describe('POST /api/recipes/from-batch/:batchId — "Save as recipe" (F §1.5)', () => {
  it('ONE statement reads every F §1.5 column: lines, amounts, form, brand, heat, note, order, sitting, vessel, salt facts, mash_in_g, Made', async () => {
    const sql = mockSql([[{ id: R1, line_count: 4, linked: 1 }], ...READ.map((x) => [...x])]);
    const r = await handleRecipeRoute({ sql, ...route(`/api/recipes/from-batch/${BATCH}`, 'POST', { idempotency_key: K1 }) });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ batch_linked: true, recipe: { id: R1 } });
    const w = sql.calls[0];
    for (const col of ['i.label', 'i.qty', 'i.qty_unit', 'i.form', 'i.brand', 'i.shu_rating_low', 'i.shu_rating_high',
      'i.note', 'i.ordinal', 'i.put_up_stage_id', 'i.role', 'i.salt_pct', 'i.salt_base', 'i.base_g', 'i.salt_method',
      'i.base_from', 'v.vessel_label', 'v.vessel_size', 'v.vessel_unit', 'v.vessel_count', 'v.no_salt',
      'sl.mash_in_g', 'sl.amount', 'v.notes', 'v.brine_note', 'v.recipe_ref']) {
      expect(w.norm, col).toContain(col);
    }
    // Made is the put_up rows' amount in g; voided sittings and taken-out lines do not count.
    expect(w.norm).toMatch(/stage_kind = 'put_up'/);
    expect(w.norm).toMatch(/amount_unit = 'g'/);
    expect(w.norm).toMatch(/x\.voids_id = sl\.id/);
    expect(w.norm).toMatch(/i\.deleted_at IS NULL/);
    // "at the end" is sitting membership.
    expect(w.norm).toMatch(/\(i\.put_up_stage_id IS NOT NULL\)/);
    // No reading comes across, and no stage note but "Next time…".
    expect(w.norm).not.toMatch(/ph_reading|ph_read_at|last_ph/);
    expect(w.norm).toMatch(/stage_kind = 'noted'/);
    // The batch is the household's; the owner is the caller; the batch is linked only if it follows none.
    expect(w.values).toContainEqual(HOUSEHOLD);
    expect(w.values).toContain(BATCH);
    expect(w.norm).toMatch(/kb\.recipe_id IS NULL/);
    // The default name is the batch label (no name sent → null bound, COALESCE to b.label).
    expect(after(w, 'SELECT ?::text, COALESCE(')).toBeNull();
  });

  it('a typed name wins over the label; a STRANGER\'s batch → 404', async () => {
    let sql = mockSql([[{ id: R1, line_count: 0, linked: 0 }], ...READ.map((x) => [...x])]);
    const r = await handleRecipeRoute({ sql, ...route(`/api/recipes/from-batch/${BATCH}`, 'POST', { idempotency_key: K1, name: ' Mojo ' }) });
    expect(r.body.batch_linked).toBe(false);
    expect(after(sql.calls[0], 'SELECT ?::text, COALESCE(')).toBe('Mojo');
    sql = mockSql([[{ id: null, line_count: 0, linked: 0 }]]);
    const s = await handleRecipeRoute({ sql, ...route(`/api/recipes/from-batch/${BATCH}`, 'POST', { idempotency_key: K1 }, STRANGER) });
    expect(s.status).toBe(404);
    expect(sql.calls[0].values).toContainEqual(STRANGER);
  });

  it('replay: the same key → 200 replayed; a malformed key → 400', async () => {
    let sql = mockSql([err('23505', 'uq_recipe_idempotency_key'), [{ id: R1, mine: true }], ...READ.map((x) => [...x])]);
    const r = await handleRecipeRoute({ sql, ...route(`/api/recipes/from-batch/${BATCH}`, 'POST', { idempotency_key: K1 }) });
    expect(r).toMatchObject({ status: 200, body: { replayed: true } });
    sql = mockSql();
    expect((await handleRecipeRoute({ sql, ...route(`/api/recipes/from-batch/${BATCH}`, 'POST', { idempotency_key: 'x' }) })).status).toBe(400);
  });
});

// ── types ────────────────────────────────────────────────────────────────────────────────────────
describe('/api/recipes/types — built-ins, then the household\'s; find-or-create; soft delete', () => {
  it('the fifteen built-ins mirror the migration exactly (ids, labels, order)', () => {
    const ddl = readFileSync(resolve(here, '../../migrations/v5-recipes-001/0a-additive-ddl.sql'), 'utf8');
    const rows = [...ddl.matchAll(/\('(7ec1be00-[0-9a-f-]+)', '([^']+)',\s+(\d+)\)/g)].map((m) => ({ id: m[1], label: m[2], sort_order: Number(m[3]) }));
    expect(rows).toEqual(RECIPE_BUILTIN_TYPES.map((t) => ({ ...t })));
    expect(RECIPE_BUILTIN_TYPES.map((t) => t.label)).toEqual([
      'Hot sauce', 'Chili paste', 'Salsa & chutney', 'Chili crisp & oil', 'Glaze & wing sauce', 'Pesto',
      'Jam & preserve', 'Pickle', 'Canned vegetables', 'Canned fruit', 'Fruit leather & snacks', 'Candy',
      'Spice & powder', 'Ferment (kraut, kimchi…)', 'Other',
    ]);
  });

  it('GET lists built-ins and the household\'s live types only', async () => {
    const sql = mockSql([[{ id: TYPE, label: 'Hot sauce', builtin: true }]]);
    const r = await handleRecipeRoute({ sql, ...route('/api/recipes/types', 'GET') });
    expect(r.body.types).toHaveLength(1);
    expect(sql.calls[0].norm).toMatch(/user_id IS NULL OR user_id = ANY\(\?\)/);
    expect(sql.calls[0].norm).toMatch(/deleted_at IS NULL/);
    expect(sql.calls[0].values).toContainEqual(HOUSEHOLD);
  });

  it('POST finds a built-in or household type by lower(btrim(label)) → 200 created:false', async () => {
    const sql = mockSql([[{ how: 'found', id: TYPE, label: 'Hot sauce', sort_order: 10, user_id: null, builtin: true, inserted: false }]]);
    const r = await handleRecipeRoute({ sql, ...route('/api/recipes/types', 'POST', { label: '  hot   SAUCE ' }) });
    expect(r).toEqual({ status: 200, body: { type: { id: TYPE, label: 'Hot sauce', sort_order: 10, user_id: null, builtin: true }, created: false } });
    const w = sql.calls[0];
    expect(w.values).toContain('hot SAUCE');
    expect(w.norm).toMatch(/lower\(btrim\(t\.label\)\) = lower\(\?::text\)/);
    expect(w.norm).toMatch(/ON CONFLICT \(user_id, lower\(btrim\(label\)\)\) WHERE user_id IS NOT NULL AND deleted_at IS NULL DO UPDATE/);
    expect(w.values).toContainEqual(HOUSEHOLD);
  });

  it('POST mints a new type under the caller → 201 created:true; a restored one → 200 restored', async () => {
    let sql = mockSql([[{ how: 'made', id: MY_TYPE, label: 'Shrub', sort_order: 1000, user_id: DAVE, builtin: false, inserted: true }]]);
    let r = await handleRecipeRoute({ sql, ...route('/api/recipes/types', 'POST', { label: 'Shrub' }) });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ created: true, type: { id: MY_TYPE, builtin: false } });
    sql = mockSql([[{ how: 'restored', id: MY_TYPE, label: 'Shrub', sort_order: 1000, user_id: DAVE, builtin: false, inserted: false }]]);
    r = await handleRecipeRoute({ sql, ...route('/api/recipes/types', 'POST', { label: 'Shrub' }) });
    expect(r).toMatchObject({ status: 200, body: { created: false, restored: true } });
    // A concurrent tap's row returned through ON CONFLICT DO UPDATE is not "created".
    sql = mockSql([[{ how: 'made', id: MY_TYPE, label: 'Shrub', sort_order: 1000, user_id: DAVE, builtin: false, inserted: false }]]);
    r = await handleRecipeRoute({ sql, ...route('/api/recipes/types', 'POST', { label: 'Shrub' }) });
    expect(r.status).toBe(200);
  });

  it('POST validation: a label, at most 60 characters; nothing else', () => {
    expect(validateTypeCreate({ label: ' ' })).toMatch(/required/);
    expect(validateTypeCreate({ label: 'x'.repeat(61) })).toMatch(/at most 60/);
    expect(validateTypeCreate({ label: 'Shrub', color: 'red' })).toMatch(/unknown/);
    expect(typeLabelOf('  Wing   glaze ')).toBe('Wing glaze');
  });

  it('DELETE: a built-in → 409 builtin_type; a household type → soft 200; STRANGER → 404', async () => {
    let sql = mockSql([[{ found: 1, builtin: 1, gone: 0 }]]);
    expect(await handleRecipeRoute({ sql, ...route(`/api/recipes/types/${TYPE}`, 'DELETE') }))
      .toMatchObject({ status: 409, body: { code: 'builtin_type' } });
    sql = mockSql([[{ found: 1, builtin: 0, gone: 1 }]]);
    expect(await handleRecipeRoute({ sql, ...route(`/api/recipes/types/${MY_TYPE}`, 'DELETE') })).toEqual({ status: 200, body: { ok: true } });
    expect(sql.calls[0].norm).toMatch(/SET deleted_at = now\(\)/);
    expect(sql.calls[0].norm).toMatch(/t\.user_id IS NOT NULL/);
    sql = mockSql([[{ found: 0, builtin: 0, gone: 0 }]]);
    expect((await handleRecipeRoute({ sql, ...route(`/api/recipes/types/${MY_TYPE}`, 'DELETE', null, STRANGER) })).status).toBe(404);
    expect(sql.calls[0].values).toContainEqual(STRANGER);
  });
});

// ── the batch side: create names a recipe; getBatch reads it back ─────────────────────────────────
describe('POST /api/kitchen-batches — recipe_id (release 4 lifts 1b\'s refusal)', () => {
  const create = (b, h = HOUSEHOLD) => ({ rawPath: '/api/kitchen-batches', method: 'POST', rawBody: JSON.stringify(b), query: {}, userId: DAVE, householdIds: h });

  it('a household recipe: loaded first (live, household-scoped), then written with recipe_ref beside it', async () => {
    const sql = mockSql([[{ id: R1, name: 'Petri Dish Pioneer' }], [{ id: BATCH }], [{ id: BATCH, recipe_id: R1 }]]);
    const r = await handleKitchenRoute({ sql, ...create({ label: 'Petri Dish', recipe_id: R1, recipe_ref: 'card in the drawer', idempotency_key: K1 }) });
    expect(r.status).toBe(201);
    const [load, write] = sql.calls;
    expect(load.norm).toMatch(/FROM recipe WHERE id = \?::uuid AND user_id = ANY\(\?\) AND deleted_at IS NULL/);
    expect(load.values).toContainEqual(HOUSEHOLD);
    expect(write.norm).toMatch(/idempotency_key, recipe_id, recipe_ref/);
    const at = write.norm.indexOf('?::uuid, ?::uuid, ?::text )');
    const i = (write.norm.slice(0, at).match(/\?/g) ?? []).length;
    expect(write.values.slice(i, i + 3)).toEqual([K1, R1, 'card in the drawer']);
  });

  it('a STRANGER\'s recipe (or a removed one) → 400, nothing written', async () => {
    const sql = mockSql([[]]);
    const r = await handleKitchenRoute({ sql, ...create({ label: 'x', recipe_id: R1 }, STRANGER) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/recipe_id/);
    expect(sql.calls).toHaveLength(1);
  });

  it('no recipe_id: no recipe read, both new columns bound NULL', async () => {
    const sql = mockSql([[{ id: BATCH }], [{ id: BATCH }]]);
    await handleKitchenRoute({ sql, ...create({ label: 'x' }) });
    expect(sql.calls[0].norm).toMatch(/INSERT INTO kitchen_batch/);
    const w = sql.calls[0];
    // key, recipe_id, recipe_ref are the INSERT's last three placeholders: …?::uuid, ?::uuid, ?::text )
    const at = w.norm.indexOf('?::uuid, ?::uuid, ?::text )');
    expect(at).toBeGreaterThan(-1);
    const i = (w.norm.slice(0, at).match(/\?/g) ?? []).length;
    expect(w.values.slice(i + 1, i + 3)).toEqual([null, null]);
  });

  it('loadOwnedRecipe: a malformed id is null without a query', async () => {
    const sql = mockSql();
    expect(await loadOwnedRecipe(sql, 'nope', HOUSEHOLD)).toBeNull();
    expect(sql.calls).toHaveLength(0);
  });
});

describe('GET /api/kitchen-batches/:id — the recipe it follows (no notes: his target pH stays on recipe detail)', () => {
  const OPEN = [{ id: BATCH, closed_at: null, suspended_at: null, started_at: '2026-09-28T14:00:00Z' }];
  const get = { rawPath: `/api/kitchen-batches/${BATCH}`, method: 'GET', rawBody: null, query: {}, userId: DAVE, householdIds: HOUSEHOLD };

  it('a batch naming a recipe gets `recipe` (name, keeps line, lines); the read carries no notes', async () => {
    const recipe = { id: R1, name: 'Petri Dish Pioneer', keeps_n: 2, keeps_unit: 'month', keeps_storage_kind: 'fridge', lines: [] };
    const sql = mockSql([OPEN, [{ id: BATCH, recipe_id: R1, shu_est_basis: null }], [], [], [], [recipe]]);
    const r = await handleKitchenRoute({ sql, ...get });
    expect(r.status).toBe(200);
    expect(r.body.recipe).toEqual(recipe);
    const read = sql.calls[5];
    expect(read.norm).toMatch(/FROM recipe r/);
    expect(read.norm).not.toMatch(/\bnotes\b/);
    expect(read.norm).not.toMatch(/ph_|\bph\b/i);
    expect(read.values).toContainEqual(HOUSEHOLD);
  });

  it('a batch naming none: no recipe read, no `recipe` key', async () => {
    const sql = mockSql([OPEN, [{ id: BATCH, recipe_id: null, shu_est_basis: null }], [], [], []]);
    const r = await handleKitchenRoute({ sql, ...get });
    expect(r.body).not.toHaveProperty('recipe');
    expect(sql.calls).toHaveLength(5);
  });
});

// ── the recipe basis for discard-by (V4 §3.1, §3.2, §3.4) ────────────────────────────────────────
describe('recipeUseBy — typed > RECIPE > table > none, only on a matching storage kind', () => {
  const R = { keeps_n: 7, keeps_unit: 'day', keeps_storage_kind: 'fridge' };

  it('applies on the recipe\'s storage kind: days, weeks and months from the put-up day', () => {
    expect(recipeUseBy(R, 'fridge', '2026-10-09')).toEqual({ use_by_target: '2026-10-16', use_by_basis: 'recipe' });
    expect(recipeUseBy({ ...R, keeps_n: 3, keeps_unit: 'week' }, 'fridge', '2026-10-09')).toEqual({ use_by_target: '2026-10-30', use_by_basis: 'recipe' });
    expect(recipeUseBy({ ...R, keeps_n: 2, keeps_unit: 'month' }, 'fridge', '2026-12-31')).toEqual({ use_by_target: '2027-02-28', use_by_basis: 'recipe' });
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(RECIPE_KEEPS_UNITS).toEqual(['day', 'week', 'month']);
  });

  it('does NOT apply on any other storage kind, an unrecorded one, no keeps line, or an unknown put-up date', () => {
    for (const kind of ['deep_freezer', 'fridge_freezer', 'pantry', 'cold_storage', 'other', null]) {
      expect(recipeUseBy(R, kind, '2026-10-09'), String(kind)).toBeNull();
    }
    expect(recipeUseBy(null, 'fridge', '2026-10-09')).toBeNull();
    expect(recipeUseBy({ keeps_n: null, keeps_unit: null, keeps_storage_kind: null }, 'fridge', '2026-10-09')).toBeNull();
    expect(recipeUseBy(R, 'fridge', '2026-10-09', { precision: 'unknown' })).toBeNull();
    expect(recipeUseBy(R, 'fridge', null)).toBeNull();
  });
});

describe('Put it up with a recipe (planPutUp): the basis per row', () => {
  let n = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const put = (rows) => ({ idempotency_key: K1, when: { date: '2026-10-09', precision: 'day' }, method: 'hot_sauce', finish: false, rows });
  const ctx = (recipe) => ({ batchLabel: 'Petri Dish', notSureDay: null, placeKinds: {}, newId, recipe });
  const RECIPE = { name: 'Roll for Initiative', keeps_n: 7, keeps_unit: 'day', keeps_storage_kind: 'fridge' };

  it('recipe applied only on the matching storage kind; the freezer row falls through to the table', () => {
    const plan = planPutUp(put([
      { count: 1, place: { kind: 'fridge', label: 'Kitchen fridge' } },
      { count: 1, place: { kind: 'deep_freezer', label: 'Chest freezer' } },
    ]), ctx(RECIPE));
    expect(plan.jars[0]).toMatchObject({ use_by_target: '2026-10-16', use_by_basis: 'recipe' });
    expect(plan.jars[1].use_by_basis).toBe('table');
    expect(plan.jars[1].use_by_target).not.toBe('2026-10-16');
  });

  it('typed beats recipe (a date, and his explicit "no date")', () => {
    const plan = planPutUp(put([
      { count: 1, place: { kind: 'fridge', label: 'F' }, discard_by: '2026-10-12' },
      { count: 1, place: { kind: 'fridge', label: 'F' }, discard_by: 'none' },
    ]), ctx(RECIPE));
    expect(plan.jars[0]).toMatchObject({ use_by_target: '2026-10-12', use_by_basis: 'typed' });
    expect(plan.jars[1]).toMatchObject({ use_by_target: null, use_by_basis: 'typed' });
  });

  it('recipe beats the table — even where the table has no figure (a raw hot sauce in the fridge)', () => {
    const plan = planPutUp(put([{ count: 1, place: { kind: 'fridge', label: 'F' }, is_raw: true }]), ctx(RECIPE));
    expect(plan.jars[0]).toMatchObject({ use_by_target: '2026-10-16', use_by_basis: 'recipe' });
    const without = planPutUp(put([{ count: 1, place: { kind: 'fridge', label: 'F' }, is_raw: true }]), ctx(null));
    expect(without.jars[0]).toMatchObject({ use_by_target: null, use_by_basis: 'none' });
  });

  it('no recipe (ctx.recipe absent) is exactly the 1b/F behaviour', () => {
    const a = planPutUp(put([{ count: 1, place: { kind: 'deep_freezer', label: 'C' } }]), { ...ctx(null), recipe: undefined });
    expect(a.jars[0].use_by_basis).toBe('table');
  });
});

describe('the Put it up route reads the batch\'s recipe keeps line, household-scoped and live', () => {
  it('meta joins recipe on the batch\'s recipe_id with the household and deleted_at', async () => {
    const OPEN = [{ id: BATCH, closed_at: null, suspended_at: null, started_at: '2026-09-28T14:00:00Z' }];
    // gate, meta; then refuse on a replay read so the test stops before the statement.
    const sql = mockSql([OPEN, [], err('stop', null)]);
    await handleKitchenRoute({ sql, rawPath: `/api/kitchen-batches/${BATCH}/put-up`, method: 'POST', query: {}, userId: DAVE,
      householdIds: HOUSEHOLD, rawBody: JSON.stringify({ idempotency_key: K1, when: { date: '2026-10-09', precision: 'day' },
        method: 'hot_sauce', finish: false, rows: [{ count: 1, place: { kind: 'fridge', label: 'F' } }] }) }).catch(() => {});
    const meta = sql.calls.find((c) => c.norm.includes('not_sure_day'));
    expect(meta.norm).toMatch(/LEFT JOIN recipe rc ON rc\.id = b\.recipe_id AND rc\.user_id = ANY\(\?\) AND rc\.deleted_at IS NULL/);
    expect(meta.norm).toMatch(/rc\.keeps_n, rc\.keeps_unit, rc\.keeps_storage_kind/);
  });
});

describe('after it is written (V4 §3.4): a Move nulls a recipe date unless the storage kind still matches', () => {
  const jar = { method: 'hot_sauce', storage_kind: 'fridge', use_by_basis: 'recipe', use_by_target: '2026-10-16',
    preserved_at: '2026-10-09', preserved_at_precision: 'day', storage_moved_at: null };

  it('a change of storage kind nulls it (basis none) and never re-derives', () => {
    expect(moveUseBy(jar, 'deep_freezer', '2026-10-10')).toEqual({ kindChanged: true, useBy: { use_by_target: null, use_by_basis: 'none' } });
    expect(moveUseBy(jar, 'pantry', '2026-10-10').useBy).toEqual({ use_by_target: null, use_by_basis: 'none' });
  });

  it('a move within the same storage kind (fridge → another fridge) keeps it', () => {
    expect(moveUseBy(jar, 'fridge', '2026-10-10')).toEqual({ kindChanged: false, useBy: null });
  });

  it('a correction at the same place keeps a recipe date (the storage kind still matches)', () => {
    expect(correctionUseBy(jar, { ...jar, is_raw: true })).toBeNull();
  });
});
