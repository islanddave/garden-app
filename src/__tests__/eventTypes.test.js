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
  it('REQUIRED_META_FIELDS is exactly [label, emoji, category]', () => {
    expect(REQUIRED_META_FIELDS).toEqual(['label', 'emoji', 'category']);
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

  it('no META label leaks raw snake_case (no 📌 fallback in practice)', () => {
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

  it('excludes exactly the 6 expected types (3 needs-input + 3 HS-1; flowering+fruit_set freed)', () => {
    expect([...BATCH_EXCLUDED_TYPES].sort()).toEqual(
      ['cutting_taken', 'divided', 'first_harvest', 'hand_pollinated', 'harvest', 'photo'],
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

  it('each emitted entry carries value/label/emoji from META', () => {
    const groups = buildSecondaryGroups(['watering']);
    for (const [, types] of groups) {
      for (const t of types) {
        expect(t).toHaveProperty('value');
        expect(t.label).toBe(EVENT_TYPE_META[t.value].label);
        expect(t.emoji).toBe(EVENT_TYPE_META[t.value].emoji);
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

describe('V4-EVENTSEL-001 — Dave-approved taxonomy taste-calls', () => {
  it('weeded is Environmental (moved off the lone Care More-panel row, Dave 2026-07-07)', () => expect(EVENT_TYPE_META.weeded.category).toBe('Environmental'));
  it('caged is Growth & Training', () => expect(EVENT_TYPE_META.caged.category).toBe('Growth & Training'));
  it('animal_damage is Environmental', () => expect(EVENT_TYPE_META.animal_damage.category).toBe('Environmental'));
});
