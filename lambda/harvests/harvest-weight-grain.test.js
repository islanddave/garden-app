// V4-HARVGRAIN-001 — the weight merge at FOUR grains, tested by calling it.
//
// WHY THIS FILE EXISTS AT ALL. The change it guards is "add two members to a GROUPING SETS clause",
// which reads as a one-line SQL edit and is not: the merge that consumed the old two-level rowset
// keyed on `crop_slug` ALONE, so every incoming variety row would have re-set() its crop's entry and
// the LAST variety's grams would have silently replaced the crop total. On live prod that is tomato
// rendering Cherry Falls' 763 g in place of 27,712 g — a 36x understatement of the ONE number this
// surface already got right, with nothing thrown, nothing logged, and no way to tell from the
// response that it happened.
//
// The sibling static file (harvest-weight-aggregates.test.js) pins the SQL's shape, which is all it
// can do: lambda/harvests/index.js imports neon/clerk/aws and cannot be imported under the root
// vitest run. A regex over source text cannot check a Map key. That is why applyWeights lives in
// aggregate.js — so THIS file can hand it a rowset and read what comes back.
//
// The rowset fixtures are the real GROUPING SETS output shape: one row per grouping set, with the
// grouped-away columns NULL and a GROUPING() bit per dimension saying which. A fixture that instead
// invented a `level: 'variety'` field would test a projection nobody ships.
import { describe, it, expect } from 'vitest';
import { computeAggregates, applyWeights, shapeWeightRow } from './aggregate.js';

// One weight row. `lvl` is the grain, and it drives the three GROUPING() bits exactly as Postgres
// would: a column is NULL and its bit is 1 precisely when the grouping set rolled it up.
function wrow(lvl, { crop = null, variety = null, planting = null, m = 0, e = 0, mc = 0, ec = 0, uw = 0 } = {}) {
  const bits = {
    total:    { is_total: 1, varieties_rolled_up: 1, plantings_rolled_up: 1 },
    crop:     { is_total: 0, varieties_rolled_up: 1, plantings_rolled_up: 1 },
    variety:  { is_total: 0, varieties_rolled_up: 0, plantings_rolled_up: 1 },
    planting: { is_total: 0, varieties_rolled_up: 0, plantings_rolled_up: 0 },
  }[lvl];
  return {
    crop_slug: lvl === 'total' ? null : crop,
    variety_id: lvl === 'total' || lvl === 'crop' ? null : variety,
    gn_id: lvl === 'planting' ? planting : null,
    ...bits,
    measured_grams: m, estimated_grams: e, measured_count: mc, estimated_count: ec, unweighed_count: uw,
  };
}

// The live tomato shape in miniature: one big-fruited variety that is mostly weighed, one currant
// type with many more picks and a fraction of the grams. These are the two varieties whose real
// ordering the alphabetical sort inverted.
const TOMATO_ROWS = [
  wrow('total', { m: 9000, e: 500, mc: 27, ec: 3 }),
  wrow('crop', { crop: 'tomato', m: 9000, e: 500, mc: 27, ec: 3 }),
  wrow('variety', { crop: 'tomato', variety: 'v-moskvich', m: 8200, e: 33, mc: 26, ec: 1 }),
  wrow('variety', { crop: 'tomato', variety: 'v-cherryfalls', m: 800, e: 467, mc: 1, ec: 2 }),
  wrow('planting', { crop: 'tomato', variety: 'v-moskvich', planting: 'gn-1', m: 8200, e: 33, mc: 26, ec: 1 }),
  wrow('planting', { crop: 'tomato', variety: 'v-cherryfalls', planting: 'gn-2', m: 800, e: 467, mc: 1, ec: 2 }),
];

const tomatoAggregates = () => ({
  crops: [{
    crop_type_slug: 'tomato',
    crop_name: 'Tomato',
    varieties: [
      { variety_id: 'v-cherryfalls', variety_name: 'Cherry Falls' },
      { variety_id: 'v-moskvich', variety_name: 'Moskvich Heirloom' },
    ],
  }],
  first_pick: [
    { plant_id: 'gn-1', planting_name: 'Moskvich bed', crop_type_slug: 'tomato', first_pick_date: '2026-07-04' },
    { plant_id: 'gn-2', planting_name: 'Cherry Falls pot', crop_type_slug: 'tomato', first_pick_date: '2026-06-28' },
  ],
});

describe('THE REGRESSION — variety rows must not overwrite the crop total', () => {
  it('the crop total survives variety expansion (a crop-only Map key would show 1,267 g here)', () => {
    const agg = tomatoAggregates();
    applyWeights(agg, TOMATO_ROWS);
    // 9,500 g, not Cherry Falls' 1,267 g and not Moskvich's 8,233 g. This is the assertion the
    // change existed to make un-breakable: it fails on any merge that lands a variety row on the
    // crop key, whichever variety happens to come last in the rowset.
    expect(agg.crops[0].weight.grams).toBe(9500);
    expect(agg.crops[0].weight.measured).toBe(27);
  });

  it('the crop total is byte-identical with and without the variety/planting rows present', () => {
    // The strongest form of the same guard: adding grouping-set MEMBERS must not perturb a member
    // that already existed. If a future merge ever derives the crop total from the rows under it
    // instead of reading the (crop) row, this catches the moment it stops agreeing.
    const before = tomatoAggregates();
    applyWeights(before, TOMATO_ROWS.filter((r) => r.varieties_rolled_up === 1));
    const after = tomatoAggregates();
    applyWeights(after, TOMATO_ROWS);
    expect(after.crops[0].weight).toEqual(before.crops[0].weight);
    expect(after.weight).toEqual(before.weight);
  });

  it('the last variety in the rowset does not win — order is not load-bearing', () => {
    const forward = tomatoAggregates();
    applyWeights(forward, TOMATO_ROWS);
    const reversed = tomatoAggregates();
    applyWeights(reversed, [...TOMATO_ROWS].reverse());
    expect(reversed.crops[0].weight).toEqual(forward.crops[0].weight);
    expect(reversed.crops[0].varieties.map((v) => [v.variety_id, v.weight.grams]))
      .toEqual(forward.crops[0].varieties.map((v) => [v.variety_id, v.weight.grams]));
  });

  it('the variety rows sum to the crop row', () => {
    const agg = tomatoAggregates();
    applyWeights(agg, TOMATO_ROWS);
    const sum = agg.crops[0].varieties.reduce((n, v) => n + v.weight.grams, 0);
    expect(sum).toBe(agg.crops[0].weight.grams);
  });
});

describe('the three discriminators, one per NULL-bearing dimension', () => {
  it('a (crop, NULL-cultivar) row is not read as the crop row', () => {
    // Structurally identical to the (crop) row — same crop_slug, same NULL variety_id — and told
    // apart ONLY by varieties_rolled_up. Reading is_total alone puts both on the crop key and the
    // survivor is whichever came last.
    const agg = { crops: [{ crop_type_slug: 'beet', crop_name: 'Beet', varieties: [{ variety_id: null, variety_name: null }] }], first_pick: [] };
    applyWeights(agg, [
      wrow('crop', { crop: 'beet', m: 2900, mc: 5 }),
      wrow('variety', { crop: 'beet', variety: null, m: 2900, mc: 5 }),
    ]);
    expect(agg.crops[0].weight.grams).toBe(2900);
    // …and the cultivar-less bucket still finds its own weight, via the same __novar__ sentinel
    // computeAggregates keys it with.
    expect(agg.crops[0].varieties[0].weight.grams).toBe(2900);
  });

  it('the grand total and the unattributed bucket are not confused (both have a NULL crop_slug)', () => {
    const agg = { crops: [], other: [{ project_id: 'p1' }], first_pick: [] };
    applyWeights(agg, [
      wrow('total', { m: 500, mc: 2 }),
      // The unattributed bucket: no cultivar, so no crop_slug, at every level.
      { ...wrow('crop', { crop: null, m: 120, mc: 1 }), crop_slug: null },
    ]);
    expect(agg.weight.grams).toBe(500);
    // aggregates.other carries the picks and deliberately carries no weight — folding 120 g of
    // plantless harvest into a crop that did not produce it is the failure this drops it to avoid.
    expect(agg.other[0].weight).toBeUndefined();
  });

  it('an absent weight row yields a zeroed object, never undefined', () => {
    const agg = { crops: [{ crop_type_slug: 'kale', crop_name: 'Kale', varieties: [{ variety_id: 'v1', variety_name: 'Lacinato' }] }], first_pick: [{ plant_id: 'gn-9' }] };
    applyWeights(agg, []);
    for (const w of [agg.weight, agg.crops[0].weight, agg.crops[0].varieties[0].weight, agg.first_pick[0].weight]) {
      expect(w).toEqual(shapeWeightRow(null));
    }
  });
});

describe('per-planting weight rides first_pick[]', () => {
  it('each planting row carries its own grams, keyed on plant_id', () => {
    const agg = tomatoAggregates();
    applyWeights(agg, TOMATO_ROWS);
    const byPlant = Object.fromEntries(agg.first_pick.map((f) => [f.plant_id, f.weight.grams]));
    expect(byPlant).toEqual({ 'gn-1': 8233, 'gn-2': 1267 });
  });
});

describe('B3 — ordering is by yield, with name as the tie-break', () => {
  it('the heavier variety outranks the one with more picks', () => {
    const agg = tomatoAggregates();
    applyWeights(agg, TOMATO_ROWS);
    // Alphabetically Cherry Falls precedes Moskvich Heirloom, and by PICK COUNT it wins outright.
    // By weight it does not, and weight is the only axis the two are comparable on.
    expect(agg.crops[0].varieties.map((v) => v.variety_name)).toEqual(['Moskvich Heirloom', 'Cherry Falls']);
  });

  it('crops are ordered by weight, heaviest first', () => {
    const agg = {
      crops: [
        { crop_type_slug: 'arugula', crop_name: 'Arugula', varieties: [] },
        { crop_type_slug: 'tomato', crop_name: 'Tomato', varieties: [] },
      ],
      first_pick: [],
    };
    applyWeights(agg, [
      wrow('crop', { crop: 'arugula', e: 300, ec: 4 }),
      wrow('crop', { crop: 'tomato', m: 9500, mc: 30 }),
    ]);
    expect(agg.crops.map((c) => c.crop_type_slug)).toEqual(['tomato', 'arugula']);
  });

  it('weightless rows keep a deterministic name order rather than Map order', () => {
    // They all compare equal at 0 grams, so without the tie-break the surface would re-order itself
    // between requests for no reason the reader can see.
    const agg = {
      crops: [
        { crop_type_slug: 'thyme', crop_name: 'Thyme', varieties: [] },
        { crop_type_slug: 'basil', crop_name: 'Basil', varieties: [] },
        { crop_type_slug: 'dill', crop_name: 'Dill', varieties: [] },
      ],
      first_pick: [],
    };
    applyWeights(agg, []);
    expect(agg.crops.map((c) => c.crop_name)).toEqual(['Basil', 'Dill', 'Thyme']);
  });

  it('a weighed crop always outranks an unweighed one, whatever its name', () => {
    const agg = {
      crops: [
        { crop_type_slug: 'arugula', crop_name: 'Arugula', varieties: [] },
        { crop_type_slug: 'zucchini', crop_name: 'Zucchini', varieties: [] },
      ],
      first_pick: [],
    };
    applyWeights(agg, [wrow('crop', { crop: 'zucchini', m: 4000, mc: 9 })]);
    expect(agg.crops.map((c) => c.crop_type_slug)).toEqual(['zucchini', 'arugula']);
  });
});

describe('applyWeights composes with the real computeAggregates output', () => {
  it('merges onto the shape the aggregates pass actually produces', () => {
    // The fixtures above hand-build the aggregate shape; this one proves the field names they
    // assume are the ones computeAggregates emits (crops[].crop_type_slug, varieties[].variety_id,
    // first_pick[].plant_id). A rename on either side would otherwise pass every test above.
    const rows = [
      { day_key: '2026-07-20', plant_id: 'gn-1', gn_id: 'gn-1', project_id: 'p1', crop_slug: 'tomato', crop_name: 'Tomato', variety_id: 'v-moskvich', variety_name: 'Moskvich Heirloom', harvest_log_id: 'h1', quantity: 3, unit: 'count' },
      { day_key: '2026-07-21', plant_id: 'gn-2', gn_id: 'gn-2', project_id: 'p1', crop_slug: 'tomato', crop_name: 'Tomato', variety_id: 'v-cherryfalls', variety_name: 'Cherry Falls', harvest_log_id: 'h2', quantity: 40, unit: 'count' },
    ];
    const agg = applyWeights(computeAggregates(rows), TOMATO_ROWS);
    expect(agg.crops[0].weight.grams).toBe(9500);
    expect(agg.crops[0].varieties.map((v) => v.weight.grams)).toEqual([8233, 1267]);
    expect(agg.first_pick.every((f) => f.weight.grams > 0)).toBe(true);
  });
});
