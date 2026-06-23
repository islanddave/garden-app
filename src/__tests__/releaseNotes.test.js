// V3-RELEASENOTES-001 — latestReleases() caps to the most recent N (newest-first input),
// and the seeded public/releases.json is well-formed + ordered newest-first.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { latestReleases } from '../pages/ReleaseNotes.jsx';

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
  const data = JSON.parse(readFileSync(new URL('../../public/releases.json', import.meta.url), 'utf8'));
  it('is a non-empty array', () => {
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });
  it('newest entry is the current prod version 2.11.0', () => {
    expect(data[0].version).toBe('2.11.0');
  });
  it('every entry has a version and at least one highlight', () => {
    for (const r of data) {
      expect(typeof r.version).toBe('string');
      expect(Array.isArray(r.highlights) && r.highlights.length > 0).toBe(true);
    }
  });
});
