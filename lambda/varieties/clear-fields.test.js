// V4-EDITCOMPLETE-001 — validateClear unit tests.
// `clear` is the only channel that can return a cultivar column to NULL. It is therefore also the
// only channel that can DESTROY a value, so its allowlist and its ambiguity rule are load-bearing:
// a permissive validator here would let a client blank display_name, which no edit surface may do.

import { describe, it, expect } from 'vitest';
import { validateClear, CLEARABLE_FIELDS } from './validate.js';

describe('validateClear — legacy callers are untouched', () => {
  it('accepts an absent clear (every pre-V4-EDITCOMPLETE-001 caller)', () => {
    expect(validateClear(undefined, {})).toBeNull();
    expect(validateClear(null, {})).toBeNull();
  });

  it('accepts an empty array', () => {
    expect(validateClear([], {})).toBeNull();
  });
});

describe('validateClear — allowlist', () => {
  it('accepts every field the edit surface can clear', () => {
    expect(validateClear(CLEARABLE_FIELDS, {})).toBeNull();
  });

  // display_name is the identity every planting row, harvest chip and picker option renders.
  it('refuses to clear name', () => {
    expect(validateClear(['name'], {})).toMatch(/cannot be cleared/);
  });

  it('refuses to clear system columns', () => {
    for (const k of ['id', 'created_by', 'created_at', 'updated_at', 'deleted_at', 'model_version']) {
      expect(validateClear([k], {}), `${k} should not be clearable`).toMatch(/cannot be cleared/);
    }
  });

  it('refuses an unknown field (a typo must 400, not silently no-op)', () => {
    expect(validateClear(['care_note'], {})).toMatch(/cannot be cleared/);
  });

  it('refuses a non-array', () => {
    expect(validateClear('care_notes', {})).toMatch(/must be an array/);
    expect(validateClear({ care_notes: true }, {})).toMatch(/must be an array/);
  });

  it('refuses a non-string entry', () => {
    expect(validateClear([42], {})).toMatch(/cannot be cleared/);
  });
});

describe('validateClear — ambiguity', () => {
  // Resolving this silently — either way — is the failure mode the whole item exists to remove.
  it('refuses a key that is both set and cleared', () => {
    expect(validateClear(['care_notes'], { care_notes: 'x' })).toMatch(/both cleared and set/);
  });

  it('allows clearing a key whose body value is explicitly null', () => {
    expect(validateClear(['care_notes'], { care_notes: null })).toBeNull();
  });

  it('allows clearing one key while setting a different one', () => {
    expect(validateClear(['care_notes'], { soil_notes: 'x' })).toBeNull();
  });
});

describe('CLEARABLE_FIELDS', () => {
  // 31 -> 36 (V5-VARIETYFACTSEDIT-001): origin_country, origin_region, breeding_system,
  // breeding_source, scoville_source.
  it('covers the 36 user-owned columns and excludes name', () => {
    expect(CLEARABLE_FIELDS).toHaveLength(36);
    expect(CLEARABLE_FIELDS).not.toContain('name');
    expect(new Set(CLEARABLE_FIELDS).size).toBe(CLEARABLE_FIELDS.length);
  });

  // dtm_basis is on public.cultivar with a live CHECK, but the Lambda neither reads nor writes it
  // and nothing renders it (V4-MATURITYBASIS-001). Offering a clear for an invisible field would be
  // its own trap, so its absence here is deliberate rather than an oversight.
  it('excludes dtm_basis until it has a read path', () => {
    expect(CLEARABLE_FIELDS).not.toContain('dtm_basis');
  });

  // No edit surface owns these two, and variety_rank is half of the open-pollinated CHECK
  // (chk_plant_varieties_op_requires_cultivar): clearing it on an open_pollinated row is a 23514.
  it('excludes breeding_confidence and variety_rank', () => {
    expect(CLEARABLE_FIELDS).not.toContain('breeding_confidence');
    expect(CLEARABLE_FIELDS).not.toContain('variety_rank');
  });
});
