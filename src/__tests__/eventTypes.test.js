// V3-EVENT-008 — canonical event-type module (src/lib/eventTypes.js) contract tests.
// Pure data + one builder fn; no DOM. Covers: META completeness, derived batch list,
// HS-1 exclusions, and buildSecondaryGroups behavior.
import { describe, it, expect } from 'vitest';
import {
  EVENT_TYPES,
  EVENT_TYPE_META,
  REQUIRED_META_FIELDS,
  BATCH_EXCLUDED_TYPES,
  BATCH_EVENT_TYPES,
  buildSecondaryGroups,
  CATEGORY_ORDER,
  PLANTING_REQUIRED_TYPES,
  PLANTING_EXEMPT_TYPES,
  requiresPlanting,
  PLANT_REDUCTION_EVENT_TYPES,
  SELECTABLE_EVENT_TYPES,
} from '../lib/eventTypes.js';

const isRaw = (s) => /^[a-z_]+$/.test(s);

describe('EVENT_TYPES master soft-enum', () => {
  it('has no duplicate values', () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });
  it('is non-empty', () => {
    expect(EVENT_TYPES.length).toBeGreaterThan(0);
  });
});

describe('EVENT_TYPE_META completeness', () => {
  // V4-ICON-001 dropped `emoji`: the glyph is `event.<value>` in the icon registry, which is
  // SVG-backed for all 51 values. A META field would be a second source of the same glyph.
  it('REQUIRED_META_FIELDS is exactly [label, category]', () => {
    expect(REQUIRED_META_FIELDS).toEqual(['label', 'category']);
  });

  it('every EVENT_TYPES value has a META entry', () => {
    for (const v of EVENT_TYPES) {
      expect(EVENT_TYPE_META[v], `missing META for ${v}`).toBeTruthy();
    }
  });

  it('every META entry has all required fields, each a non-empty string', () => {
    for (const v of EVENT_TYPES) {
      const meta = EVENT_TYPE_META[v];
      for (const field of REQUIRED_META_FIELDS) {
        expect(typeof meta[field], `${v}.${field} type`).toBe('string');
        expect(meta[field].length, `${v}.${field} empty`).toBeGreaterThan(0);
      }
    }
  });

  it('no META label leaks raw snake_case (the no-META fallback never fires in practice)', () => {
    for (const v of EVENT_TYPES) {
      expect(isRaw(EVENT_TYPE_META[v].label), `${v} label is raw`).toBe(false);
    }
  });

  it('META has no orphan keys not in EVENT_TYPES', () => {
    for (const k of Object.keys(EVENT_TYPE_META)) {
      expect(EVENT_TYPES.includes(k), `orphan META key: ${k}`).toBe(true);
    }
  });
});

describe('BATCH_EVENT_TYPES (derived)', () => {
  it('equals EVENT_TYPES minus BATCH_EXCLUDED_TYPES, master order preserved', () => {
    expect(BATCH_EVENT_TYPES).toEqual(
      EVENT_TYPES.filter((t) => !BATCH_EXCLUDED_TYPES.includes(t)),
    );
  });

  it('excludes exactly the 9 expected types (3 needs-input + 3 HS-1 + 1 non-reward + 2 reduction)', () => {
    // V4-WATERMATH-001 F0 added moisture_check: a per-plant JUDGEMENT ("this one is still damp"),
    // the opposite of a scope-wide assertion. Bulk-logging "none of these 500 need water" without
    // touching them fabricates an observation and lets one tap suppress the whole water bar.
    // V4-LOSSEVENT-001 added failed + given_away: each carries a PER-PLANTING quantity (harvest's
    // disqualifier) and, worse, an invisible side effect — one "lost 3" across a 500-planting scope
    // would decrement 500 plantings and accrue 1500 to qty_lost.
    expect([...BATCH_EXCLUDED_TYPES].sort()).toEqual(
      ['cutting_taken', 'divided', 'failed', 'first_harvest', 'given_away', 'hand_pollinated',
        'harvest', 'moisture_check', 'photo'],
    );
  });

  it('HS-1: divided, cutting_taken, hand_pollinated are NOT batch types (fruit_set+flowering freed V4-EVENTSEL-002)', () => {
    for (const t of ['divided', 'cutting_taken', 'hand_pollinated']) {
      expect(BATCH_EVENT_TYPES.includes(t), `${t} should be excluded`).toBe(false);
    }
    for (const t of ['fruit_set', 'flowering']) {
      expect(BATCH_EVENT_TYPES.includes(t), `${t} should now be batch-eligible`).toBe(true);
    }
  });

  it('surfaces the 12 genuinely-bulk new types', () => {
    for (const t of ['caged', 'staked', 'mesh_netting', 'trellised', 'pinched', 'deadheaded',
      'weeded', 'relocated', 'animal_damage', 'heat_damage', 'frost_damage', 'soil_amended']) {
      expect(BATCH_EVENT_TYPES.includes(t), `${t} should be batchable`).toBe(true);
    }
  });
});

describe('achievement-arc milestone vocab (V010 spec §5/§6 precondition #7)', () => {
  // These event types are the children of the Full Circle, Overwintered, and
  // The Long Keeper arcs (plus garlic's clonal Full Circle loop). A long arc
  // won't reveal a missing/removed child for many earn-rate cycles, so this is a
  // build-time guard (spec §7 coverage/arc-integrity).
  const ARC_MILESTONE_TYPES = [
    'seed_saved',          // Full Circle (true-seed crops)
    'cloves_saved',        // garlic's parallel Full Circle (clonal, NOT seed)
    'overwinter_survived', // Overwintered
    'scape_cut',           // The Long Keeper
    'cured',               // The Long Keeper
  ];

  it('every arc milestone type is in the master enum with a complete META entry', () => {
    for (const t of ARC_MILESTONE_TYPES) {
      expect(EVENT_TYPES.includes(t), `${t} missing from EVENT_TYPES`).toBe(true);
      const meta = EVENT_TYPE_META[t];
      expect(meta, `${t} missing META`).toBeTruthy();
      for (const f of REQUIRED_META_FIELDS) {
        expect(typeof meta[f], `${t}.${f}`).toBe('string');
        expect(meta[f].length, `${t}.${f} empty`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps seed_saved and cloves_saved distinct (clonal vs sexual — never aliased)', () => {
    expect(EVENT_TYPES.includes('seed_saved')).toBe(true);
    expect(EVENT_TYPES.includes('cloves_saved')).toBe(true);
  });
});

describe('buildSecondaryGroups', () => {
  it('omits primary values and groups the rest by META category', () => {
    const groups = buildSecondaryGroups(['watering', 'fertilizing']);
    const flat = groups.flatMap(([, types]) => types.map((t) => t.value));
    expect(flat).not.toContain('watering');
    expect(flat).not.toContain('fertilizing');
    expect(flat).toContain('sowing');
  });

  it('accepts a Set as primaryValues', () => {
    const groups = buildSecondaryGroups(new Set(['watering']));
    const flat = groups.flatMap(([, types]) => types.map((t) => t.value));
    expect(flat).not.toContain('watering');
  });

  it('restricts to a provided value list (e.g. BATCH_EVENT_TYPES)', () => {
    const groups = buildSecondaryGroups(['watering', 'fertilizing', 'observation', 'pruning'], BATCH_EVENT_TYPES);
    const flat = groups.flatMap(([, types]) => types.map((t) => t.value));
    // None of the HS-1 / needs-input excluded types should appear.
    for (const t of BATCH_EXCLUDED_TYPES) expect(flat).not.toContain(t);
    // Every batch-eligible non-primary type should appear exactly once.
    const expected = BATCH_EVENT_TYPES.filter(
      (t) => !['watering', 'fertilizing', 'observation', 'pruning'].includes(t),
    );
    expect(flat.sort()).toEqual([...expected].sort());
  });

  // V4-ICON-001: the emitted record is { value, label } — `value` doubles as the glyph key
  // (<Icon name={`event.${value}`} />), so an `emoji` on the record would be a second, drifting
  // source of the same glyph. Asserted absent, not merely unused.
  it('each emitted entry carries value/label from META and no emoji', () => {
    const groups = buildSecondaryGroups(['watering']);
    for (const [, types] of groups) {
      for (const t of types) {
        expect(t).toHaveProperty('value');
        expect(t.label).toBe(EVENT_TYPE_META[t.value].label);
        expect(t, `${t.value} re-grew an emoji field`).not.toHaveProperty('emoji');
      }
    }
  });
});

describe('V4-EVENTSEL-001 — taxonomy fix + explicit category order', () => {
  it('rain is Environmental, not Care', () => {
    expect(EVENT_TYPE_META.rain.category).toBe('Environmental');
  });
  it('every EVENT_TYPE_META category is present in CATEGORY_ORDER', () => {
    const cats = new Set(Object.values(EVENT_TYPE_META).map((m) => m.category));
    for (const c of cats) expect(CATEGORY_ORDER, `category ${c} not in CATEGORY_ORDER`).toContain(c);
  });
  it('buildSecondaryGroups returns categories in CATEGORY_ORDER', () => {
    const order = buildSecondaryGroups(['watering']).map(([cat]) => cat);
    const expected = CATEGORY_ORDER.filter((c) => order.includes(c));
    expect(order).toEqual(expected);
  });
});

describe('V4-LOSSUI-001 — the reduction types are SELECTABLE now that the capture panel exists', () => {
  it('both are real EVENT_TYPES values, so the API and the feed know them', () => {
    expect(EVENT_TYPES).toContain('failed');
    expect(EVENT_TYPES).toContain('given_away');
  });

  // V4-LOSSUI-001 — INVERTED, WITH REASONING, NOT DELETED.
  //
  // V4-LOSSEVENT-001 asserted the opposite: `SELECTABLE_EVENT_TYPES omits exactly those two while
  // the capture panel is unbuilt`. That test was correct for its premise, and the premise has a
  // name — "no capture panel collects the required quantity + reason, so a picker entry would 400
  // every time" (the CATCH_UP_EDITOR_SHIPPED shape). The panel now exists
  // (components/PlantReductionFields.jsx, wired into EventNew as a REQUIRED panel that gates Save),
  // so the premise is gone and the assertion has to move with it.
  //
  // What it must NOT become is nothing. Deleting it would leave the app free to drift back to a
  // creation list that silently drops a type. So it keeps asserting the same PROPERTY — that the
  // creation list and the vocabulary agree — from the other side, and it is paired with a render
  // assertion in EventNew.reduction.test.jsx that the panel is actually there for both types
  // (selectability without a panel is exactly the state this file used to forbid).
  it('SELECTABLE_EVENT_TYPES no longer drops anything — the creation list IS the vocabulary', () => {
    expect(EVENT_TYPES.filter((t) => !SELECTABLE_EVENT_TYPES.includes(t))).toEqual([]);
    expect(SELECTABLE_EVENT_TYPES).toEqual(EVENT_TYPES);
    // Named explicitly, because these two are the ones the gate was ever about.
    for (const t of PLANT_REDUCTION_EVENT_TYPES) expect(SELECTABLE_EVENT_TYPES).toContain(t);
  });

  it("'failed' the EVENT TYPE is not 'failed' the STATUS — nothing maps one onto the other", () => {
    // plants.status already has a 'failed' member. The collision is real and Dave named the event
    // type anyway; what makes it safe is that a reduction never writes status (asserted against
    // the shipped SQL in lambda/events/plant-reduction.test.js) and that the two live in different
    // vocabularies entirely. Recorded here so a future reader does not "unify" them.
    expect(EVENT_TYPE_META.failed.label).not.toMatch(/status/i);
  });
});

describe('V4-EVENTSEL-001 — Dave-approved taxonomy taste-calls', () => {
  it('weeded is Environmental (moved off the lone Care More-panel row, Dave 2026-07-07)', () => expect(EVENT_TYPE_META.weeded.category).toBe('Environmental'));
  it('caged is Growth & Training', () => expect(EVENT_TYPE_META.caged.category).toBe('Growth & Training'));
  it('animal_damage is Environmental', () => expect(EVENT_TYPE_META.animal_damage.category).toBe('Environmental'));
});

describe('V4-PLANTREQUIRED-001 — planting-requirement partition (D2 matrix)', () => {
  it('REQUIRED and EXEMPT are disjoint', () => {
    const overlap = [...PLANTING_REQUIRED_TYPES].filter((t) => PLANTING_EXEMPT_TYPES.includes(t));
    expect(overlap).toEqual([]);
  });
  it('REQUIRED ∪ EXEMPT covers exactly EVENT_TYPES (nothing unclassified, nothing invented)', () => {
    const union = new Set([...PLANTING_REQUIRED_TYPES, ...PLANTING_EXEMPT_TYPES]);
    expect(union.size).toBe(EVENT_TYPES.length);
    for (const t of EVENT_TYPES) expect(union.has(t), `${t} unclassified`).toBe(true);
  });
  it('every REQUIRED type is a real EVENT_TYPES value (no stale entry)', () => {
    for (const t of PLANTING_REQUIRED_TYPES) expect(EVENT_TYPES, `${t} not in EVENT_TYPES`).toContain(t);
  });
  it('requiresPlanting matches the REQUIRED set; false for exempt + unknown types', () => {
    expect(requiresPlanting('harvest')).toBe(true);
    expect(requiresPlanting('watering')).toBe(true);
    expect(requiresPlanting('observation')).toBe(false);
    expect(requiresPlanting('weeded')).toBe(false);
    expect(requiresPlanting('flag_issue')).toBe(false); // not in the vocabulary — has its own gate
    expect(requiresPlanting('')).toBe(false);
  });
  it('classifies the spec §3 D2 anchor cases (data-validated: weeded/uncover zero-planting; harvest/watering predicate on a plant)', () => {
    expect(PLANTING_EXEMPT_TYPES).toEqual(expect.arrayContaining(['rain', 'weeded', 'uncover', 'observation', 'photo', 'other']));
    expect([...PLANTING_REQUIRED_TYPES]).toEqual(expect.arrayContaining(['harvest', 'first_harvest', 'watering', 'transplant', 'flowering']));
  });
});
