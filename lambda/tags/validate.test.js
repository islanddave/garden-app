import { describe, it, expect } from 'vitest';
import {
  slugify, validateTagCreate, validateTagPatch, validateEntityTagCreate, isAdmin,
  VALID_USER_FACETS, VALID_ENTITY_TYPES,
} from './validate.js';

describe('slugify', () => {
  it('lowercases, trims, collapses whitespace/punctuation, strips edges', () => {
    expect(slugify('Peppers')).toBe('peppers');
    expect(slugify('  Peppers ')).toBe('peppers');
    expect(slugify('Hot Peppers!')).toBe('hot-peppers');
    expect(slugify("Jen's bed #2")).toBe('jen-s-bed-2');
  });
  it('"Peppers"/"peppers"/" peppers " all collapse to one slug', () => {
    const a = slugify('Peppers'), b = slugify('peppers'), c = slugify(' peppers ');
    expect(a).toBe(b); expect(b).toBe(c);
  });
  it('caps length and rejects empties', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('a'.repeat(100)).length).toBe(60);
  });
});

describe('validateTagCreate', () => {
  it('accepts group/freeform with a label', () => {
    expect(validateTagCreate({ facet: 'group', label: 'Houseplants' })).toBeNull();
    expect(validateTagCreate({ facet: 'freeform', label: 'trial-2026', visibility: 'private' })).toBeNull();
  });
  it('rejects derived/structured facets (type/lifecycle/location)', () => {
    for (const f of ['type', 'lifecycle', 'location']) {
      expect(validateTagCreate({ facet: f, label: 'x' })).toMatch(/facet must be one of/);
    }
  });
  it('requires a label and a non-empty slug', () => {
    expect(validateTagCreate({ facet: 'group' })).toMatch(/label is required/);
    expect(validateTagCreate({ facet: 'group', label: '!!!' })).toMatch(/alphanumeric/);
  });
  it('rejects bad visibility', () => {
    expect(validateTagCreate({ facet: 'group', label: 'x', visibility: 'public' })).toMatch(/visibility/);
  });
  it('VALID_USER_FACETS is exactly group+freeform+issue (issue added V4-FLAG-001)', () => {
    expect(VALID_USER_FACETS).toEqual(['group', 'freeform', 'issue']);
  });
});

describe('validateTagPatch', () => {
  it('requires at least one of label/visibility', () => {
    expect(validateTagPatch({})).toMatch(/nothing to update/);
  });
  it('accepts a label or visibility change', () => {
    expect(validateTagPatch({ label: 'Annuals' })).toBeNull();
    expect(validateTagPatch({ visibility: 'private' })).toBeNull();
  });
  it('rejects an empty/unsluggable label', () => {
    expect(validateTagPatch({ label: '   ' })).toMatch(/alphanumeric/);
  });
});

describe('validateEntityTagCreate', () => {
  it('requires tag_id, valid entity_type, entity_id', () => {
    expect(validateEntityTagCreate({ tag_id: 't', entity_type: 'plant', entity_id: 'e' })).toBeNull();
    expect(validateEntityTagCreate({ entity_type: 'plant', entity_id: 'e' })).toMatch(/tag_id/);
    expect(validateEntityTagCreate({ tag_id: 't', entity_type: 'bogus', entity_id: 'e' })).toMatch(/entity_type/);
    expect(validateEntityTagCreate({ tag_id: 't', entity_type: 'plant' })).toMatch(/entity_id/);
  });
  it('VALID_ENTITY_TYPES matches the live CHECK', () => {
    expect(VALID_ENTITY_TYPES).toEqual(['plant', 'cultivar', 'location', 'project']);
  });
});

describe('isAdmin (fail-closed)', () => {
  it('returns false when ADMIN_CLERK_SUBS is unset or empty', () => {
    expect(isAdmin('user_1', {})).toBe(false);
    expect(isAdmin('user_1', { ADMIN_CLERK_SUBS: '' })).toBe(false);
    expect(isAdmin('user_1', { ADMIN_CLERK_SUBS: '   ' })).toBe(false);
  });
  it('matches a listed sub only', () => {
    expect(isAdmin('user_1', { ADMIN_CLERK_SUBS: 'user_1,user_2' })).toBe(true);
    expect(isAdmin('user_9', { ADMIN_CLERK_SUBS: 'user_1,user_2' })).toBe(false);
  });
});
