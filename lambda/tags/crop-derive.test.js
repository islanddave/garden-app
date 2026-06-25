import { describe, it, expect } from 'vitest';
import { computeDerivedTags, humanizeLifecycle, VALID_LIFECYCLE } from './crop-derive.js';

const CROP_TYPES = {
  pepper: { slug: 'pepper', display_name: 'Pepper', default_lifecycle: 'tender_perennial' },
  basil: { slug: 'basil', display_name: 'Basil', default_lifecycle: 'annual' },
  beet: { slug: 'beet', display_name: 'Beet', default_lifecycle: 'biennial' },
};

describe('humanizeLifecycle', () => {
  it('title-cases underscored values', () => {
    expect(humanizeLifecycle('tender_perennial')).toBe('Tender Perennial');
    expect(humanizeLifecycle('annual')).toBe('Annual');
  });
});

describe('computeDerivedTags', () => {
  it('typed cultivar -> type: + lifecycle: (lifecycle wins over crop default)', () => {
    const out = computeDerivedTags({ crop_type_slug: 'pepper', lifecycle: 'annual' }, CROP_TYPES);
    expect(out).toEqual([
      { facet: 'type', slug: 'pepper', label: 'Pepper' },
      { facet: 'lifecycle', slug: 'annual', label: 'Annual' },
    ]);
  });
  it('falls back to crop_types.default_lifecycle when cultivar.lifecycle is null', () => {
    const out = computeDerivedTags({ crop_type_slug: 'pepper', lifecycle: null }, CROP_TYPES);
    expect(out).toContainEqual({ facet: 'lifecycle', slug: 'tender_perennial', label: 'Tender Perennial' });
    expect(out).toContainEqual({ facet: 'type', slug: 'pepper', label: 'Pepper' });
  });
  it('untyped cultivar (no crop_type_slug, no lifecycle) -> empty desired set', () => {
    expect(computeDerivedTags({ crop_type_slug: null, lifecycle: null }, CROP_TYPES)).toEqual([]);
  });
  it('drifted crop_type_slug (absent from map) -> no type tag, no throw', () => {
    const out = computeDerivedTags({ crop_type_slug: 'ghost_crop', lifecycle: 'annual' }, CROP_TYPES);
    expect(out).toEqual([{ facet: 'lifecycle', slug: 'annual', label: 'Annual' }]);
  });
  it('off-vocabulary lifecycle is dropped (whitelist)', () => {
    const out = computeDerivedTags({ crop_type_slug: 'basil', lifecycle: 'weird-value' }, CROP_TYPES);
    expect(out).toEqual([{ facet: 'type', slug: 'basil', label: 'Basil' }]);
  });
  it('lifecycle-only (no crop type) still derives a lifecycle tag', () => {
    expect(computeDerivedTags({ crop_type_slug: null, lifecycle: 'perennial' }, CROP_TYPES))
      .toEqual([{ facet: 'lifecycle', slug: 'perennial', label: 'Perennial' }]);
  });
  it('null cultivar -> empty', () => {
    expect(computeDerivedTags(null, CROP_TYPES)).toEqual([]);
  });
  it('VALID_LIFECYCLE is the 4-value vocabulary', () => {
    expect(VALID_LIFECYCLE).toEqual(['annual', 'perennial', 'biennial', 'tender_perennial']);
  });
});
