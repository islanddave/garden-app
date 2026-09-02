// V5-HEATRESPONSEDISPLAY-001 — the standing guard on the disposition that was REJECTED.
//
// heat_response ships as DISPLAY PROSE and nothing else. Wiring it into a watering or care threshold
// was considered and refused on measured grounds, and those grounds do not expire. Measured
// read-only against prod care_profile on 2026-09-02, over the 193 rows that carry the key:
//   • 59 of 193 (31%) carry no numeric °F threshold at all — nothing to parse;
//   • among those that do, the leading hot threshold is 95x37, 85x31, 88x20, 90x18, 80x13 (plus a
//     65 and a 70) — five-plus conflicting numbers against a single HOT_F = 88;
//   • 23 rows express a COLD-direction threshold in the SAME FIELD ("<55F night", "below 50F"), and
//     to a regex those read identically to a hot one. A naive hot-branch mis-fires on every one of
//     them, which is the failure that makes wiring this worse than doing nothing;
//   • blast radius would be ~143 live plantings, unmeasured.
// (The V101 plan quotes 81/188 and a four-cold-threshold count from a differently-defined pass; the
// figures above are this file's own measurement and the disagreement is definitional. Both point
// the same way, and the cold-threshold hazard is LARGER on this reading, not smaller.)
//
// The corpus is curated horticulture written for a human reader. A future session that reads one of
// these strings, sees ">85F daily", and thinks "that is a threshold, I can parse that" is the exact
// move this file exists to stop — so the test names the reason, not just the rule.
//
// It also pins the cabbage correction at the source, because that string is the reason the
// display disposition needed a data fix before it could ship.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(resolve(__dirname, f), 'utf8');

const CORPUS = JSON.parse(read('cadence-data-v2.json'));
const byVariety = CORPUS.by_variety ?? {};
const entries = Object.entries(byVariety);

const heatStrings = entries
  .map(([name, e]) => [name, e?.heat_response])
  .filter(([, v]) => typeof v === 'string' && v.length > 0);

describe('heat_response is display prose, never an engine input', () => {
  it('the corpus still carries the prose this feature surfaces (harness guard)', () => {
    expect(entries.length).toBeGreaterThan(100);
    expect(heatStrings.length).toBeGreaterThan(100);
  });

  // MUTATION: add `heat_response` to any threshold read in engine.js / cadence resolution -> RED.
  // Source-text over the whole engine directory rather than a behavioural assertion, because there
  // is no behaviour to assert until someone wires it, and by then the guard is too late.
  it('no daily-plan module reads heat_response at all', () => {
    const modules = readdirSync(__dirname).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
    expect(modules.length).toBeGreaterThan(5);          // harness guard: the sweep found something
    for (const f of modules) {
      const src = read(f);
      expect(`${f}: ${src.includes('heat_response')}`).toBe(`${f}: false`);
      expect(`${f}: ${src.includes('heatResponse')}`).toBe(`${f}: false`);
    }
  });

  // The evidence behind the rejection, re-derived from the corpus itself so it cannot rot into
  // folklore. If a future corpus edit made the strings uniformly parseable, this would go red and
  // the rejection would deserve a fresh look — which is the correct outcome, not a nuisance.
  it('the strings are not uniformly parseable, which is why parsing them was refused', () => {
    // A meaningful share carry no number at all. Bounded rather than pinned to today's count so an
    // ordinary corpus edit does not turn this red — the finding is "many", not "exactly N".
    const withNumericF = heatStrings.filter(([, v]) => /\d{2,3}\s*F/i.test(v));
    expect(heatStrings.length - withNumericF.length).toBeGreaterThan(heatStrings.length * 0.2);

    // The one that actually bites. COLD-direction thresholds live in the SAME FIELD as hot ones
    // ("<55F night", "below 50F") and read identically to a regex, so a hot-branch fires on them.
    const cold = heatStrings.filter(([, v]) => /(<|below|under)\s*\d{2,3}\s*F/i.test(v));
    expect(cold.length).toBeGreaterThan(0);
  });
});

describe('the cabbage correction is pinned at the source', () => {
  const cabbage = entries.filter(([, e]) => e?.crop === 'cabbage');

  it('there is a cabbage entry to guard (harness guard)', () => {
    expect(cabbage.length).toBeGreaterThan(0);
  });

  // MUTATION: restore ">85F daily; heat causes bolting; afternoon shade" -> RED.
  //
  // Cabbage bolting is VERNALIZATION: sustained COLD on a plant past its juvenile stem diameter,
  // expressed later when it warms. Heat does not cause it — heat loosens the head and raises the
  // split risk, and the right move is to cut. The old string sent a reader to shade a plant that
  // wanted harvesting, and V5-HEATRESPONSEDISPLAY-001 is what puts these strings in front of a
  // reader for the first time.
  //
  // Stated by MEANING, not by literal string, so a paraphrase does not walk through: any cabbage
  // entry that mentions bolting must also name the cold cause. Cabbage only — broccoli
  // (">85F may bolt/button") and the leafy greens genuinely do bolt in heat and are untouched.
  it('no cabbage entry attributes bolting to heat', () => {
    for (const [name, e] of cabbage) {
      const v = e?.heat_response ?? '';
      if (!/bolt/i.test(v)) continue;
      expect(`${name}: ${v}`).toMatch(/cold/i);
    }
  });

  it('the corrected string still carries the practical instruction, not just the correction', () => {
    for (const [, e] of cabbage) {
      const v = e?.heat_response ?? '';
      if (!/bolt/i.test(v)) continue;
      expect(v).toMatch(/harvest/i);
      expect(v).toMatch(/split/i);
    }
  });
});
