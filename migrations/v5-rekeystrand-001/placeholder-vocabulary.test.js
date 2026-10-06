// BUG-REKEYSTRANDSPROFILE-001 — the placeholder exclusion must keep describing the placeholder.
//
// Dave decided 2026-09-21 that a stranded app placeholder is not a strand, and on 2026-10-06 ("Teach
// the check about mixes") that a named mix's birth profile is not one either. gates.yml recognises
// each by PROPERTY: _basis equals a create path's label AND the row carries no key beyond the create
// paths' own keys. The labels and the key list are copies of two handler constants —
// NEW_CULTIVAR_PROFILE (lambda/varieties/index.js) and BLEND_PROFILE (lambda/varieties/blend.js) —
// and nothing at runtime ties them together:
//   - add a key to either constant and every new row of that kind reads as research, so each
//     VarietyPicker correction (or each mix whose planting is re-keyed) reds the guard again — the
//     noise Dave ruled out;
//   - rename a _basis and the same happens for every row of that kind at once;
//   - add a label to the gate that no create path writes and research filed under it is hidden.
// rehearse_local.py proves the SQL's semantics on a real Postgres, but it runs by hand. This file runs
// in CI and pins the COUPLING, so a change to either side fails at the commit that makes it.
//
// Division of labour: this file = the artifacts agree. rehearse_local.py = the predicate behaves.
// tests/integration/variety-blend.int.test.js = it behaves for a mix the ROUTE made. gates.yml = the
// live data.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import yaml from 'js-yaml';

const DIR = dirname(fileURLToPath(import.meta.url));
const GATES = yaml.load(readFileSync(join(DIR, 'gates.yml'), 'utf8'));
const VARIETIES = join(DIR, '..', '..', 'lambda', 'varieties');
const VARIETIES_SRC = readFileSync(join(VARIETIES, 'index.js'), 'utf8');
const BLEND_SRC = readFileSync(join(VARIETIES, 'blend.js'), 'utf8');

/** A profile constant evaluated from the Lambda's source text (the modules are not importable here). */
function constant(src, declaration, file) {
  const m = src.match(new RegExp(`^${declaration} = (\\{[\\s\\S]*?^\\});`, 'm'));
  expect(m, `${declaration} not found in lambda/varieties/${file}`).toBeTruthy();
  return vm.runInNewContext(`(${m[1]})`);
}
const placeholder = () => constant(VARIETIES_SRC, 'const NEW_CULTIVAR_PROFILE', 'index.js');
const mixProfile = () => constant(BLEND_SRC, 'export const BLEND_PROFILE', 'blend.js');

/** The placeholder clause of one gate: the labels it tests and the key list it strips. */
function clause(phase, name) {
  const g = GATES[phase].find((x) => x.name === name);
  expect(g, `${phase}/${name} is missing from gates.yml`).toBeTruthy();
  // ((<label> AND <label> ...) OR (<bare-row test>)) — every label its own IS DISTINCT FROM.
  const hits = [...g.sql.matchAll(
    /\(\((cp\.profile->>'_basis' IS DISTINCT FROM '[^']+'(?:\s+AND cp\.profile->>'_basis' IS DISTINCT FROM '[^']+')*)\)\s+OR \(cp\.profile - ARRAY\[([^\]]*)\]\) <> '\{\}'::jsonb\)/g)];
  expect(hits, `${phase}/${name} must carry the placeholder clause exactly once`).toHaveLength(1);
  const labels = [...hits[0][1].matchAll(/IS DISTINCT FROM '([^']+)'/g)].map((l) => l[1]);
  const keys = [...hits[0][2].matchAll(/'([^']+)'/g)].map((k) => k[1]);
  // No other mention of _basis anywhere in the gate: a label tested outside the clause would not be pinned.
  expect(g.sql.match(/_basis' IS/g), `${phase}/${name} tests _basis outside the clause`).toHaveLength(labels.length);
  return { labels, keys };
}

const guard = () => clause('post', 'post_no_rekey_stranded_care_profile');
const pre = () => clause('pre', 'pre_rekey_strands_exist_before_the_decision');

describe('v5-rekeystrand-001 — the placeholder exclusion matches NEW_CULTIVAR_PROFILE and BLEND_PROFILE', () => {
  it('strips exactly the keys the create paths write — no more, no fewer', () => {
    // More would hide research written under that key; fewer would count every placeholder.
    expect([...guard().keys].sort()).toEqual(Object.keys(placeholder()).sort());
  });

  it('a mix is born with the same keys as a new cultivar, so one key list serves both labels', () => {
    // The gate strips ONE list for both labels. If a mix's birth profile gains a key the placeholder
    // lacks (or the reverse), the list is wrong for one of them and this is the commit that says so.
    expect(Object.keys(mixProfile()).sort()).toEqual(Object.keys(placeholder()).sort());
    expect([...guard().keys].sort()).toEqual(Object.keys(mixProfile()).sort());
  });

  it("tests each create path's own _basis label — both of them, and no other", () => {
    const { labels } = guard();
    expect(placeholder()._basis).not.toBe(mixProfile()._basis);
    expect([...labels].sort()).toEqual([placeholder()._basis, mixProfile()._basis].sort());
  });

  it('the pre gate measures what the guard counts', () => {
    expect(pre()).toEqual(guard());
  });
});
