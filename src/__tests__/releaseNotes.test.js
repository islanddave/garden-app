// V3-RELEASENOTES-001 — latestReleases() caps to the most recent N (newest-first input),
// and the seeded public/releases.json is well-formed + ordered newest-first.
import { describe, it, expect } from 'vitest';
import { latestReleases } from '../pages/ReleaseNotes.jsx';
import data from '../../public/releases.json';
import pkg from '../../package.json';

describe('latestReleases', () => {
  const mk = n => Array.from({ length: n }, (_, i) => ({ version: `9.0.${n - i}` }));
  it('returns at most 10 entries', () => {
    expect(latestReleases(mk(25)).length).toBe(10);
  });
  it('keeps newest-first order (slice from the front)', () => {
    const list = [{ version: 'a' }, { version: 'b' }, { version: 'c' }];
    expect(latestReleases(list, 2).map(r => r.version)).toEqual(['a', 'b']);
  });
  it('tolerates non-array input', () => {
    for (const v of [null, undefined, {}, 5]) expect(latestReleases(v)).toEqual([]);
  });
});

describe('public/releases.json seed', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });
  it('newest entry matches the current package.json version (add-release ritual invariant)', () => {
    expect(data[0].version).toBe(pkg.version);
  });
  it('every entry has a version and at least one highlight', () => {
    for (const r of data) {
      expect(typeof r.version).toBe('string');
      expect(Array.isArray(r.highlights) && r.highlights.length > 0).toBe(true);
    }
  });
});
