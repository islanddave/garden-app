// V3-RELEASENOTES-001 — latestReleases() caps to the most recent N (newest-first input),
// and the seeded public/releases.json is well-formed + ordered newest-first.
import { describe, it, expect } from 'vitest';
import { latestReleases } from '../pages/ReleaseNotes.jsx';
import data from '../../public/releases.json';
import latest from '../../public/releases-latest.json';
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

// V4-PERFTHEMEA-001. The version probe (useAppUpdate) and the What's-New dot (useWhatsNew) read
// releases-latest.json; ReleaseNotes reads the full releases.json. Splitting one source of truth
// into two files buys ~139 KB per probe and costs exactly one new failure mode: they disagree.
// scripts/add-release.mjs writes both in one step and scripts/check-release-version.py asserts the
// same equality in CI — this is the vitest-side copy, so a hand-edit is caught by whichever gate
// runs first rather than by Dave's phone silently staying on an old bundle.
describe('public/releases-latest.json seed', () => {
  it('is a single OBJECT, not the array (that shape is what the consumers discriminate on)', () => {
    expect(Array.isArray(latest)).toBe(false);
    expect(typeof latest).toBe('object');
    expect(latest).not.toBeNull();
  });
  it('deep-equals releases.json[0]', () => {
    expect(latest).toEqual(data[0]);
  });
  it('carries the current package.json version', () => {
    expect(latest.version).toBe(pkg.version);
  });
  it('is small enough to be worth the split — under 4 KB raw', () => {
    // Not a byte ratchet, a sanity floor: the whole point is that this file does not grow with the
    // release history. If it ever crosses this it has stopped being a single entry.
    expect(JSON.stringify(latest).length).toBeLessThan(4096);
  });
});
