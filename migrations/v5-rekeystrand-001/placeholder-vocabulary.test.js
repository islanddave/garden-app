// BUG-REKEYSTRANDSPROFILE-001 — the placeholder exclusion must keep describing the placeholder.
//
// Dave decided 2026-09-21 that a stranded app placeholder is not a strand. gates.yml recognises one by
// PROPERTY: _basis equals the create path's label AND the row carries no key beyond the create path's
// own keys. Both halves are copies of NEW_CULTIVAR_PROFILE (lambda/varieties/index.js), and nothing at
// runtime ties them together:
//   - add a key to NEW_CULTIVAR_PROFILE and every new placeholder reads as research, so each
//     VarietyPicker correction reds the guard again — the noise Dave ruled out;
//   - rename its _basis and the same happens for every placeholder at once.
// rehearse_local.py proves the SQL's semantics on a real Postgres, but it runs by hand. This file runs
// in CI and pins the COUPLING, so a change to either side fails at the commit that makes it.
//
// Division of labour: this file = the two artifacts agree. rehearse_local.py = the predicate behaves.
// gates.yml = the live data.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import yaml from 'js-yaml';

const DIR = dirname(fileURLToPath(import.meta.url));
const GATES = yaml.load(readFileSync(join(DIR, 'gates.yml'), 'utf8'));
const VARIETIES_SRC = readFileSync(join(DIR, '..', '..', 'lambda', 'varieties', 'index.js'), 'utf8');

/** NEW_CULTIVAR_PROFILE evaluated from the Lambda's source text (the module is not importable here). */
function placeholder() {
  const m = VARIETIES_SRC.match(/^const NEW_CULTIVAR_PROFILE = (\{[\s\S]*?^\});/m);
  expect(m, 'NEW_CULTIVAR_PROFILE not found in lambda/varieties/index.js').toBeTruthy();
  return vm.runInNewContext(`(${m[1]})`);
}

/** The placeholder clause of one gate: the label it tests and the key list it strips. */
function clause(phase, name) {
  const g = GATES[phase].find((x) => x.name === name);
  expect(g, `${phase}/${name} is missing from gates.yml`).toBeTruthy();
  const hits = [...g.sql.matchAll(
    /profile->>'_basis' IS DISTINCT FROM '([^']+)'\s+OR \(cp\.profile - ARRAY\[([^\]]*)\]\) <> '\{\}'::jsonb/g)];
  expect(hits, `${phase}/${name} must carry the placeholder clause exactly once`).toHaveLength(1);
  const keys = [...hits[0][2].matchAll(/'([^']+)'/g)].map((k) => k[1]);
  return { label: hits[0][1], keys };
}

const guard = () => clause('post', 'post_no_rekey_stranded_care_profile');
const pre = () => clause('pre', 'pre_rekey_strands_exist_before_the_decision');

describe('v5-rekeystrand-001 — the placeholder exclusion matches NEW_CULTIVAR_PROFILE', () => {
  it('strips exactly the keys the create path writes — no more, no fewer', () => {
    // More would hide research written under that key; fewer would count every placeholder.
    expect([...guard().keys].sort()).toEqual(Object.keys(placeholder()).sort());
  });

  it("tests the create path's own _basis label", () => {
    expect(guard().label).toBe(placeholder()._basis);
  });

  it('the pre gate measures what the guard counts', () => {
    expect(pre()).toEqual(guard());
  });
});
