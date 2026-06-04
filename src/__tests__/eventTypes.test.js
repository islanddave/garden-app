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

  it('excludes exactly the 7 expected types (3 needs-input + 4 HS-1)', () => {
    expect([...BATCH_EXCLUDED_TYPES].sort()).toEqual(
      ['cutting_taken', 'divided', 'first_harvest', 'fruit_set', 'hand_pollinated', 'harvest', 'photo'],
    );
  });

  it('HS-1: divided, cutting_taken, hand_pollinated, fruit_set are NOT batch types', () => {
    for (const t of ['divided', 'cutting_taken', 'hand_pollinated', 'fruit_set']) {
      expect(BATCH_EVENT_TYPES.includes(t), `${t} should be excluded`).toBe(false);
    }
  });

  it('surfaces the 12 genuinely-bulk new types', () => {
    for (const t of ['caged', 'staked', 'mesh_netting', 'trellised', 'pinched', 'deadheaded',
      'weeded', 'relocated', 'animal_damage', 'heat_damage', 'frost_damage', 'soil_amended']) {
      expect(BATCH_EVENT_TYPES.includes(t), `${t} should be batchable`).toBe(true);
    }
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
