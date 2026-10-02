// Put-Up R2a (contract 6, amendment C3) — the shape of GET /api/kitchen-batches/line-search, arm by arm.
//
// The planting arm gains `succession_order` and `sown_at`, typed as GET /api/plants?view=picker sends them,
// so the door can tell three same-named plantings apart with plantingWaveLabel. Everything else about the
// answer is frozen: every earlier key, its order, the other four arms, the ORDER BY and the ranking. Under
// the mock driver no SQL runs, so "the shape" is read where it is decided: each arm's own SELECT list, as
// the route sends it. What the database does with it is the integration lane's.
//
// The ranking and the route's scoping are pinned in batchBuilder.test.js and fermentRoutes.test.js, which
// this change leaves as they were.
//
// MUTATIONS: drop `gn.succession_order` (or `gn.sown_at`) from the planting arm → "the planting arm's keys"
// reds; move either ahead of an existing key → the same test reds on the order; wrap `gn.sown_at` in a cast
// or a to_char → "as the planting chooser sends them" reds; add a key to another arm → that arm's row reds.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineSearch, rankHits, LINE_SEARCH_LIMIT } from './lineSearch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOUSEHOLD = ['user_dave', 'user_jen'];
const PLANT = 'dddddddd-1111-2222-3333-444444444444';
const PLANT_B = 'dddddddd-2222-2222-3333-444444444444';

// The five arms are issued together (Promise.all), in the order the handler lists them.
function mockSql(queue = [[], [], [], [], []]) {
  const calls = [];
  const fn = (strings, ...values) => {
    const text = strings.raw.join(' ? ');
    calls.push({ text, norm: text.replace(/\s+/g, ' ').trim(), values });
    return Promise.resolve(queue[calls.length - 1] ?? []);
  };
  fn.calls = calls;
  return fn;
}

// One arm's SELECT list as [{ key, expr }], split at the commas that sit outside every parenthesis and
// ended at the arm's own FROM (a sub-select's FROM is inside one). `key` is the name the row carries:
// the alias, or the bare column's name.
function selectList(norm) {
  expect(norm.startsWith('SELECT ')).toBe(true);
  const items = [];
  let depth = 0;
  let item = '';
  let closed = false;
  for (let i = 'SELECT '.length; i < norm.length; i += 1) {
    const ch = norm[i];
    if (depth === 0 && norm.startsWith(' FROM ', i)) { items.push(item); closed = true; break; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth === 0 && ch === ',') { items.push(item); item = ''; continue; }
    item += ch;
  }
  expect(closed, 'the SELECT list never reached its FROM').toBe(true);
  return items.map((raw) => {
    const expr = raw.trim();
    const alias = expr.match(/ AS ([a-z_]+)$/);
    return { key: alias ? alias[1] : expr.replace(/^[a-z_]+\./, ''), expr };
  });
}
const keysOf = (call) => selectList(call.norm).map((c) => c.key);

async function arms() {
  const sql = mockSql();
  await lineSearch(sql, { q: 'megatron' }, HOUSEHOLD);
  expect(sql.calls).toHaveLength(5);
  return sql.calls;
}

describe('line search — each arm selects exactly these keys, in this order', () => {
  it('the planting arm\'s keys: the nine it had, then succession_order and sown_at', async () => {
    const [plantings] = await arms();
    expect(plantings.norm).toContain('FROM garden_node gn');
    expect(keysOf(plantings)).toEqual([
      'plant_id', 'label', 'crop_type_slug', 'variety_id', 'variety_name', 'status', 'ended', 'recent_at',
      'recent_picks',
      'succession_order', 'sown_at',
    ]);
  });

  it.each([
    [1, 'FROM preservation_log p', ['preservation_log_id', 'label', 'method', 'crop_type_slug', 'variety_id',
      'quantity_value', 'quantity_unit', 'package_count', 'remaining_count', 'remaining_amount', 'stock_mode',
      'storage_kind', 'crop_name', 'recent_at']],
    [2, 'FROM pantry_item pit', ['pantry_item_id', 'label', 'crop_type_slug', 'plant_id', 'place_label', 'recent_at']],
    [3, 'FROM crop_types ct', ['crop_type_slug', 'label']],
    [4, 'FROM cultivar cv', ['variety_id', 'label', 'crop_type_slug']],
  ])('arm %i (%s) is as it was', async (i, from, keys) => {
    const calls = await arms();
    expect(calls[i].norm).toContain(from);
    expect(keysOf(calls[i])).toEqual(keys);
  });

  it('the planting arm still orders by name then id, capped per arm', async () => {
    const [plantings] = await arms();
    expect(plantings.norm).toMatch(/ORDER BY gn\.display_name, gn\.id LIMIT \?$/);
    expect(plantings.values[plantings.values.length - 1]).toBe(LINE_SEARCH_LIMIT);
  });
});

describe('line search — succession_order and sown_at are typed as the planting chooser sends them', () => {
  // GET /api/plants?view=picker selects the two columns bare, so each reaches the wire as the driver
  // serialises it. The same two bare columns here are the same wire types by construction, and that is
  // what lets the door call plantingWaveLabel({ name, succession_order, sown_at }) unchanged.
  it('both are bare garden_node columns here: no cast, no to_char, no alias', async () => {
    const [plantings] = await arms();
    const list = selectList(plantings.norm);
    expect(list.find((c) => c.key === 'succession_order').expr).toBe('gn.succession_order');
    expect(list.find((c) => c.key === 'sown_at').expr).toBe('gn.sown_at');
  });

  it('and bare in the chooser\'s own projection, which is the type this one copies', () => {
    const plants = readFileSync(resolve(__dirname, '../plants/index.js'), 'utf8');
    const at = plants.indexOf("view === 'picker'");
    expect(at, 'the picker projection was not found in lambda/plants/index.js').toBeGreaterThan(-1);
    const end = plants.indexOf('FROM public.garden_node gp', at);
    expect(end).toBeGreaterThan(at);
    expect(plants.slice(at, end)).toMatch(/\n\s*gp\.sown_at, gp\.succession_order,\n/);
  });
});

describe('line search — what the route answers', () => {
  const row = (over = {}) => ({
    plant_id: PLANT, label: 'Megatron', crop_type_slug: 'pepper', variety_id: 'v1', variety_name: 'Megatron',
    status: 'growing', ended: false, recent_at: '2026-05-01T00:00:00.000Z', recent_picks: [],
    succession_order: 2, sown_at: '2026-04-01T00:00:00.000Z', ...over,
  });

  it('a planting row reaches the body as the driver gave it, the two new keys included', async () => {
    const first = row();
    const second = row({ plant_id: PLANT_B, succession_order: null, sown_at: null, recent_at: '2026-06-01T00:00:00.000Z' });
    const sql = mockSql([[first, second], [], [], [], []]);
    const res = await lineSearch(sql, { q: 'Megatron' }, HOUSEHOLD);
    expect(res.status).toBe(200);
    expect(res.body.plantings).toEqual([first, second]);
    expect(Object.keys(res.body.plantings[0])).toEqual([
      'plant_id', 'label', 'crop_type_slug', 'variety_id', 'variety_name', 'status', 'ended', 'recent_at',
      'recent_picks', 'succession_order', 'sown_at',
    ]);
    // Same-named plantings: both are exact matches, so they are told apart only by what the row carries.
    expect(res.body.hits).toEqual([
      { ...second, kind: 'planting', key: `planting:${PLANT_B}`, tier: 'exact', group: 'live' },
      { ...first, kind: 'planting', key: `planting:${PLANT}`, tier: 'exact', group: 'live' },
    ]);
  });

  it('the body\'s keys and their order are unchanged', async () => {
    const res = await lineSearch(mockSql(), { q: 'megatron' }, HOUSEHOLD);
    expect(Object.keys(res.body)).toEqual(['plantings', 'put_ups', 'pantry_items', 'crops', 'varieties', 'hits', 'resolved_crop']);
  });

  it('a planting with neither (an older Lambda, a stand-in) still ranks: the two keys are never required', () => {
    const hits = rankHits('megatron', { plantings: [{ plant_id: PLANT, label: 'Megatron', ended: false, recent_at: null }] });
    expect(hits).toEqual([{ plant_id: PLANT, label: 'Megatron', ended: false, recent_at: null, kind: 'planting', key: `planting:${PLANT}`, tier: 'exact', group: 'live' }]);
  });
});
