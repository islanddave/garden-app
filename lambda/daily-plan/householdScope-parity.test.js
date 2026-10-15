// BUG-AUTHZLAMBDA-001 — householdScope.js (CJS, this Lambda) against lambda/household.js (ESM, canonical).
//
// household-copies-sync.test.js holds every household.js copy byte-identical, but this Lambda is CJS and
// cannot take one, so its rule is a restatement. This file is the sync check a restatement needs: the same
// env and owner matrix through both, equal answers for every non-blank owner, and the one deliberate
// difference (a blank owner) pinned as exactly that difference.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { householdScope } from '../household.js';
import mirror from './householdScope.js';

const { householdIds, householdOf, spaceScope } = mirror;

afterEach(() => { vi.unstubAllEnvs(); });

const ENVS = [
  undefined, '', '   ', ',', ' , ,',
  'user_dave', ' user_dave ',
  'user_dave,user_jen', ' user_dave , user_jen ', 'user_dave,,user_jen,', 'user_jen,user_dave',
  'user_dave,user_jen,user_third',
];
const OWNERS = ['user_dave', 'user_jen', 'user_stranger', 'user_dave ', 'USER_DAVE'];
const BLANKS = [null, undefined, '', ' ', '\t'];

const withEnv = (env) => {
  vi.unstubAllEnvs();
  if (env === undefined) vi.stubEnv('GARDEN_HOUSEHOLD_IDS', undefined);
  else vi.stubEnv('GARDEN_HOUSEHOLD_IDS', env);
};

describe('householdScope.js mirrors lambda/household.js householdScope()', () => {
  it('equal answers over the whole env x owner matrix', () => {
    let n = 0;
    for (const env of ENVS) {
      withEnv(env);
      for (const owner of OWNERS) {
        expect(householdOf(owner), `env=${JSON.stringify(env)} owner=${JSON.stringify(owner)}`).toEqual(householdScope(owner));
        expect(spaceScope(owner).members).toEqual(householdScope(owner));
        n += 1;
      }
    }
    expect(n).toBe(ENVS.length * OWNERS.length);
  });

  it('reads the env exactly as household.js does (split, trim, drop empties)', () => {
    for (const env of ENVS) {
      withEnv(env);
      // householdScope of a sub that is in no list returns [sub]; one that is in it returns the list.
      const raw = householdIds();
      if (raw.length) expect(householdScope(raw[0])).toEqual(raw);
      else expect(householdScope('user_dave')).toEqual(['user_dave']);
    }
  });

  it('the ONE deliberate difference: a blank owner gets the empty set, where householdScope returns [owner]', () => {
    for (const env of ENVS) {
      withEnv(env);
      for (const blank of BLANKS) {
        expect(householdOf(blank), `env=${JSON.stringify(env)} owner=${JSON.stringify(blank)}`).toEqual([]);
        expect(spaceScope(blank)).toEqual({ owner: null, members: [], degraded: null });
      }
    }
    // ...and that is a real difference, not a coincidence of the matrix.
    withEnv('user_dave,user_jen');
    expect(householdScope('')).toEqual(['']);
  });

  it('spaceScope names why a Space narrowed to its owner, and is silent for a full household', () => {
    const cases = [
      [undefined, 'user_dave', 'env-missing'],
      ['  ', 'user_dave', 'env-missing'],
      ['user_dave', 'user_dave', 'env-single-entry'],
      ['user_jen,user_x', 'user_dave', 'owner-not-in-household'],
      ['user_dave,user_jen', 'user_dave', null],
      ['user_dave,user_jen', 'user_jen', null],
    ];
    for (const [env, owner, degraded] of cases) {
      withEnv(env);
      expect(spaceScope(owner).degraded, `env=${JSON.stringify(env)} owner=${owner}`).toBe(degraded);
      expect(spaceScope(owner).owner).toBe(owner);
    }
  });
});
