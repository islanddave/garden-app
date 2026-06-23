// V3-LOGMANY-001 — GET /api/locations returns { locations, locations_with_path }
// (an object), but LogMany/ScopeChecklist consume a bare array. normalizeLocations
// unwraps either shape so the "By space" tab cannot crash on `locations.find`.
import { describe, it, expect } from 'vitest';
import { normalizeLocations } from '../pages/LogMany.jsx';

describe('LogMany.normalizeLocations', () => {
  it('unwraps the {locations:[...]} object shape (the real /api/locations contract)', () => {
    const obj = { locations: [{ id: 'a' }, { id: 'b' }], locations_with_path: [] };
    const out = normalizeLocations(obj);
    expect(Array.isArray(out)).toBe(true);
    expect(out.map(l => l.id)).toEqual(['a', 'b']);
  });
  it('passes a bare array through unchanged', () => {
    const arr = [{ id: 'x' }];
    expect(normalizeLocations(arr)).toBe(arr);
  });
  it('returns [] for null/undefined/garbage (never a non-array)', () => {
    for (const v of [null, undefined, 42, 'nope', {}]) {
      const out = normalizeLocations(v);
      expect(Array.isArray(out)).toBe(true);
      expect(typeof out.find).toBe('function'); // the exact crash guard
    }
  });
});
