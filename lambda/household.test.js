// household.js unit tests — Household Mode scope helper (V2 multi-user bridge).
// Verifies fail-closed behavior: unset/empty/whitespace env -> [userId] (byte-identical
// to single-user behavior), and the comma-split / trim / drop-empty parsing.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { householdScope, householdActive, householdGate } from './household.js';

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

describe('householdScope — membership-gated widening (leak-free)', () => {
  it('member requester: "a,b" + requester "a" -> ["a","b"]', () => {
    setEnv('a,b');
    expect(householdScope('a')).toEqual(['a', 'b']);
  });

  it('member requester: " a , b ,," + requester "b" -> ["a","b"] (trims + drops empties)', () => {
    setEnv(' a , b ,,');
    expect(householdScope('b')).toEqual(['a', 'b']);
  });

  it('NON-member requester: "a,b" + requester "user_X" -> ["user_X"] (no leak)', () => {
    setEnv('a,b');
    expect(householdScope('user_X')).toEqual(['user_X']);
  });

  it('single id + that same requester -> [that id]', () => {
    setEnv('only_owner');
    expect(householdScope('only_owner')).toEqual(['only_owner']);
  });

  it('single id + different requester -> [requester] (no leak)', () => {
    setEnv('only_owner');
    expect(householdScope('user_A')).toEqual(['user_A']);
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

describe('householdGate — SEC-13a: only a listed household member gets past any handler', () => {
  let warn;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });
  const denials = () => warn.mock.calls.map((c) => JSON.parse(c[0]));
  const FORBIDDEN = { status: 403, body: { error: 'Forbidden' } };

  it('SEC-13a: each member of the list is admitted (null) and nothing is logged', () => {
    setEnv('user_abc,user_def');
    expect(householdGate('user_abc')).toBeNull();
    expect(householdGate('user_def')).toBeNull();
    expect(denials()).toEqual([]);
  });

  it('SEC-13a: a verified caller outside the list gets the generic 403, and the reason goes to the log only', () => {
    setEnv('user_abc,user_def');
    expect(householdGate('user_stranger')).toEqual(FORBIDDEN);
    expect(denials()).toEqual([{ msg: 'household-membership-denied', userId: 'user_stranger', reason: 'non-member' }]);
  });

  it('SEC-13a: membership is exact — a prefix, suffix, substring of the raw value, case variant or padded id is refused', () => {
    setEnv('user_abc,user_def');
    for (const sub of ['user_ab', 'abc', 'ser_abc', 'user_abcd', 'c,user_d', 'user_abc,user_def', 'USER_ABC', ' user_abc', 'user_abc ']) {
      expect(householdGate(sub), JSON.stringify(sub)).toEqual(FORBIDDEN);
    }
  });

  it('SEC-13a: a missing or non-string subject is refused', () => {
    setEnv('user_abc,user_def');
    for (const sub of ['', null, undefined, 42, ['user_abc'], { toString: () => 'user_abc' }]) {
      expect(householdGate(sub)).toEqual(FORBIDDEN);
    }
  });

  it('SEC-13a: fails closed — an unset, empty, blank or separators-only list admits nobody (env-missing)', () => {
    for (const v of [undefined, '', '   ', ' , ,']) {
      setEnv(v);
      expect(householdGate('user_abc'), JSON.stringify(v)).toEqual(FORBIDDEN);
    }
    expect(denials().map((d) => d.reason)).toEqual(['env-missing', 'env-missing', 'env-missing', 'env-missing']);
  });

  it('SEC-13a: entries are trimmed and empty segments dropped, as householdScope parses them', () => {
    setEnv(' user_abc ,, user_def ');
    expect(householdGate('user_def')).toBeNull();
  });

  it('SEC-13a: a one-entry list admits its one member (the >= 2 rule is env_parity\'s, at deploy)', () => {
    setEnv('user_abc');
    expect(householdGate('user_abc')).toBeNull();
    expect(householdGate('user_def')).toEqual(FORBIDDEN);
  });

  it('SEC-13a: the body names nothing — not the list, its size or the reason — and is a fresh object each call', () => {
    setEnv('user_abc,user_def');
    const first = householdGate('user_x');
    expect(JSON.stringify(first.body)).toBe('{"error":"Forbidden"}');
    first.body.error = 'mutated';
    setEnv(undefined);
    expect(householdGate('user_x').body).toEqual({ error: 'Forbidden' });
  });
});
