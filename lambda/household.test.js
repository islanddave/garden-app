// household.js unit tests — Household Mode scope helper (V2 multi-user bridge).
// Verifies fail-closed behavior: unset/empty/whitespace env -> [userId] (byte-identical
// to single-user behavior), and the comma-split / trim / drop-empty parsing.

import { describe, it, expect, afterEach } from 'vitest';
import { householdScope, householdActive } from './household.js';

const ENV_KEY = 'GARDEN_HOUSEHOLD_IDS';
const ORIG = process.env[ENV_KEY];

afterEach(() => {
  if (ORIG === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIG;
});

function setEnv(v) {
  if (v === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = v;
}

describe('householdScope — fail-closed single-user reversibility', () => {
  it('unset env -> [userId]', () => {
    setEnv(undefined);
    expect(householdScope('user_A')).toEqual(['user_A']);
  });

  it('empty string -> [userId]', () => {
    setEnv('');
    expect(householdScope('user_A')).toEqual(['user_A']);
  });

  it('whitespace-only -> [userId]', () => {
    setEnv('   ');
    expect(householdScope('user_A')).toEqual(['user_A']);
  });

  it('commas-only / empty segments -> [userId]', () => {
    setEnv(',, ,');
    expect(householdScope('user_A')).toEqual(['user_A']);
  });
});

describe('householdScope — populated env widens the set', () => {
  it('"a,b" -> ["a","b"]', () => {
    setEnv('a,b');
    expect(householdScope('user_A')).toEqual(['a', 'b']);
  });

  it('" a , b ,," -> ["a","b"] (trims + drops empties)', () => {
    setEnv(' a , b ,,');
    expect(householdScope('user_A')).toEqual(['a', 'b']);
  });

  it('single populated id -> [that id] (does NOT fall back to userId)', () => {
    setEnv('only_owner');
    expect(householdScope('user_A')).toEqual(['only_owner']);
  });
});

describe('householdActive — true only when >1 id', () => {
  it('unset -> false', () => {
    setEnv(undefined);
    expect(householdActive()).toBe(false);
  });

  it('single id -> false', () => {
    setEnv('a');
    expect(householdActive()).toBe(false);
  });

  it('two ids -> true', () => {
    setEnv('a,b');
    expect(householdActive()).toBe(true);
  });

  it('whitespace-padded two ids -> true', () => {
    setEnv(' a , b ');
    expect(householdActive()).toBe(true);
  });

  it('one real + empty segments -> false', () => {
    setEnv('a,,');
    expect(householdActive()).toBe(false);
  });
});
