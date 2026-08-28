// Unit tests for the pre-publish content assertion.
//
// The control exists because two prior public-output defects on this project were location
// disclosures, and the only fail-closed check on this path covered image BYTES — the text going to
// a public Page was inspected by nothing.
import { describe, it, expect } from 'vitest';
import { assertPublishSafe, parseForbiddenTerms } from './contentAssertion.js';

describe('assertPublishSafe — coordinates', () => {
  it('passes ordinary garden prose', () => {
    const r = assertPublishSafe({ caption: 'First ripe Tie-Dye tomato of the year, 3.5 lbs off one plant' });
    expect(r.safe).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('blocks a decimal-degree pair in the caption', () => {
    const r = assertPublishSafe({ caption: 'shot at 42.4712, -72.6009 this morning' });
    expect(r.safe).toBe(false);
    expect(r.violations[0]).toMatchObject({ kind: 'coordinates', field: 'caption' });
  });

  it('blocks a coordinate pair that arrives through ALT TEXT, not just the caption', () => {
    const r = assertPublishSafe({ caption: 'fine', altTexts: ['bed at 42.4712 / -72.6009'] });
    expect(r.safe).toBe(false);
    expect(r.violations[0].field).toBe('alt[0]');
  });

  it.each([
    ['semicolon separator', '42.4712; -72.6009'],
    ['slash separator', '42.4712/-72.6009'],
    ['no minus on longitude', '42.4712, 72.6009'],
    ['more precision', '42.47123456, -72.60091234'],
  ])('still catches %s', (_label, text) => {
    expect(assertPublishSafe({ caption: text }).safe).toBe(false);
  });

  // The precision floor is the point: 4dp is ~11 m, which is what makes a coordinate a disclosure.
  // Coarser numbers are ordinary measurements and must not be blocked, or the control becomes noise
  // and gets turned off.
  it.each([
    ['two-decimal measurements', 'yield was 42.47, 72.60 lbs across the beds'],
    ['a single coordinate-looking number', 'the row is 42.4712 metres long'],
    ['weights with units', '3.5, 4.2 lbs'],
    ['a date-like pair', '2026.08, 2026.09'],
  ])('does NOT block %s', (_label, text) => {
    expect(assertPublishSafe({ caption: text }).safe).toBe(true);
  });

  it('rejects out-of-range values that merely look like coordinates', () => {
    // 191 is not a latitude; this is a measurement pair, not a location.
    expect(assertPublishSafe({ caption: '191.4712, -72.6009' }).safe).toBe(true);
  });
});

describe('assertPublishSafe — configured terms', () => {
  it('blocks a configured term, case-insensitively', () => {
    const r = assertPublishSafe({ caption: 'over at Mathews Road today', forbiddenTerms: ['mathews road'] });
    expect(r.safe).toBe(false);
    expect(r.violations[0].kind).toBe('forbidden_term');
  });

  // The violation must never echo the term — a log line about a leak that quotes the secret IS the
  // leak. Only the index is reported.
  it('never echoes the matched term in the violation detail', () => {
    const secret = 'Mathews Road';
    const r = assertPublishSafe({ caption: `at ${secret}`, forbiddenTerms: [secret] });
    expect(JSON.stringify(r.violations)).not.toContain(secret);
    expect(r.violations[0].detail).toMatch(/term #0/);
  });

  it('respects word boundaries rather than bare substrings', () => {
    // "conway" inside "conwayite" is not a mention of the town.
    expect(assertPublishSafe({ caption: 'the conwayite mineral', forbiddenTerms: ['conway'] }).safe).toBe(true);
    expect(assertPublishSafe({ caption: 'up in Conway today', forbiddenTerms: ['conway'] }).safe).toBe(false);
  });

  it('treats a term as DATA — regex metacharacters cannot throw or over-match', () => {
    expect(() => assertPublishSafe({ caption: 'anything', forbiddenTerms: ['a.*b', '(', '[x'] })).not.toThrow();
    expect(assertPublishSafe({ caption: 'axxb here', forbiddenTerms: ['a.*b'] }).safe).toBe(true);
    expect(assertPublishSafe({ caption: 'a.*b literally', forbiddenTerms: ['a.*b'] }).safe).toBe(false);
  });

  // "configured with no terms" and "found nothing" must be distinguishable, or a caller reports a
  // control that never ran as a control that passed.
  it('reports WHICH checks ran, so a silent no-op is visible', () => {
    expect(assertPublishSafe({ caption: 'x' }).checksRun).toEqual(['coordinates']);
    expect(assertPublishSafe({ caption: 'x', forbiddenTerms: ['y'] }).checksRun).toEqual(['coordinates', 'terms']);
    // Blank entries do not count as a configured list.
    expect(assertPublishSafe({ caption: 'x', forbiddenTerms: ['', '  '] }).checksRun).toEqual(['coordinates']);
  });

  it('the coordinate check runs even with no terms configured', () => {
    const r = assertPublishSafe({ caption: '42.4712, -72.6009', forbiddenTerms: [] });
    expect(r.safe).toBe(false);
  });
});

describe('parseForbiddenTerms', () => {
  it('parses a JSON array', () => {
    expect(parseForbiddenTerms('["a","b"]')).toEqual(['a', 'b']);
  });
  it('treats absent or blank as an empty list', () => {
    expect(parseForbiddenTerms(undefined)).toEqual([]);
    expect(parseForbiddenTerms('')).toEqual([]);
    expect(parseForbiddenTerms('   ')).toEqual([]);
  });
  // null, NOT [] — a malformed value must be distinguishable from "nothing configured", or a typo
  // in the env silently downgrades the control while still reporting success.
  it('returns null for malformed config rather than degrading to empty', () => {
    expect(parseForbiddenTerms('not json')).toBeNull();
    expect(parseForbiddenTerms('{"a":1}')).toBeNull();
    expect(parseForbiddenTerms('"a string"')).toBeNull();
  });
  it('drops blank entries but keeps the list', () => {
    expect(parseForbiddenTerms('["a","","  ","b"]')).toEqual(['a', 'b']);
  });
});
