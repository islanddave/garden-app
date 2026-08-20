// V4-COVEREDNOTMODELLED-001 — the backfill reproduces the name-match, proven per row.
//
// migrations/v4-loccovered-001 replaces daily-plan/handler.js's name-matching coverage arm
// (`l.name in ('Stable','House')`) with an editable locations.covered flag. The entire safety
// argument for that swap is ONE claim: 0b-data.sql writes, for every existing location, exactly
// what the name-match computes for it — so the reader returns byte-identical classifications on the
// day the flag goes live and every change after that is Dave ticking a box.
//
// This file makes that claim executable, and does it SEMANTICALLY rather than textually. A text
// diff between two SQL fragments proves they are spelled the same; it does not prove they classify
// `Yard - Stable` as exposed (they must — `IN` is exact, not a substring match) or that they agree
// on the NULL type_label case (they must — NULL is a MEANING here, "unknown", and collapsing it to
// false is precisely the BUG-NOLOCOUTDOOR-001 bug). So the arms are READ FROM 0b-data.sql ON DISK
// and interpreted against real location rows.
//
// WHY AN INTERPRETER RATHER THAN A TRANSCRIPTION: restating the CASE in JS would make this a THIRD
// implementation of the predicate, and a guard that can drift from the thing it guards is worth
// nothing. `armsOf` parses the file; it does not restate it. Edit 0b and this test changes with it.
//
// FIXTURES ARE MEASURED, NOT INVENTED. The 21 prod and 13 staging rows below are the live
// `(name, type_label)` pairs read from both environments on 2026-08-20 — the exact population the
// backfill will run against. Synthetic rows cover the arms live data does not reach.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BACKFILL = readFileSync(join(here, '..', '..', 'migrations', 'v4-loccovered-001', '0b-data.sql'), 'utf8');
const HANDLER = readFileSync(join(here, 'handler.js'), 'utf8');

// SQL line comments only. The CASE we want lives after the header block, and `--` inside it would
// otherwise be parsed as an arm.
const decomment = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

const LITERAL = { true: true, false: false, null: null };

// Parse the arms of a CASE expression into an ordered list. Handles exactly the three shapes the
// coverage predicate uses; anything else throws rather than being silently skipped, because a
// silently-skipped arm is a guard that passes while missing the thing it was written for.
function armsOf(sql) {
  const m = decomment(sql).match(/CASE\b([\s\S]*?)\bEND\b/i);
  if (!m) throw new Error('no CASE expression found — this guard has gone blind');
  const body = m[1].replace(/\s+/g, ' ').trim();
  const arms = [];
  const re = /WHEN\s+(?:l\.)?(\w+)\s+(IN\s*\(([^)]*)\)|IS\s+NULL|IS\s+NOT\s+NULL)\s+THEN\s+(\w+)|ELSE\s+(\w+)/gi;
  let seen = 0;
  let mm;
  while ((mm = re.exec(body)) !== null) {
    seen += mm[0].length;
    if (mm[5] !== undefined) { arms.push({ op: 'else', value: LITERAL[mm[5].toLowerCase()] }); continue; }
    const col = mm[1].toLowerCase();
    const value = LITERAL[mm[4].toLowerCase()];
    if (value === undefined) throw new Error(`unparsed THEN literal: ${mm[4]}`);
    if (/^IN/i.test(mm[2])) {
      arms.push({ op: 'in', col, set: mm[3].split(',').map((s) => s.trim().replace(/^'|'$/g, '')), value });
    } else {
      arms.push({ op: /NOT/i.test(mm[2]) ? 'notnull' : 'isnull', col, value });
    }
  }
  // Non-vacuity: a regex that matched nothing would leave `arms` empty and every assertion below
  // would compare undefined to undefined and pass.
  if (seen < body.length * 0.5) throw new Error(`CASE only ${seen}/${body.length} chars parsed — arms were dropped`);
  return arms;
}

function evaluate(arms, row) {
  for (const a of arms) {
    if (a.op === 'else') return a.value;
    const v = row[a.col];
    if (a.op === 'in' && v != null && a.set.includes(v)) return a.value;
    if (a.op === 'isnull' && v == null) return a.value;
    if (a.op === 'notnull' && v != null) return a.value;
  }
  return undefined;
}

// The legacy predicate, pinned as a literal. This is a HISTORICAL FACT — what handler.js's cov
// lateral computed at 3a07d2273d6181e4d7da76f7a0f3744e26d57212 — not a restatement of the backfill.
// It is what the backfill has to reproduce, so it must NOT be derived from the backfill.
const legacy = (row) =>
  ['Stable', 'House'].includes(row.name) ? true
    : ['shelf', 'rack', 'tray'].includes(row.type_label) ? true
      : row.type_label == null ? null
        : false;

const loc = (name, type_label) => ({ name, type_label });

// Live prod, 21 rows, 2026-08-20.
const PROD = [
  loc('Stable', 'zone'), loc('House', 'zone'), loc('Deck', 'zone'), loc('Drive', 'zone'),
  loc('Pasture', 'zone'), loc('Yard', 'zone'),
  loc('Bag Area', 'area'), loc('Drive-Shade', 'area'), loc('In-Ground', 'area'),
  loc('Legacy Pasture In-Ground', 'area'), loc('Pasture-Shade', 'area'), loc('Trough', 'area'),
  loc('Yard - Back', 'area'), loc('Yard - Front', 'area'), loc('Yard - Stable', 'area'),
  loc('Indoor Rack', 'rack'),
  loc('Shelf 1', 'shelf'), loc('Shelf 2', 'shelf'), loc('Shelf 3', 'shelf'),
  loc('Shelf 4', 'shelf'), loc('Shelf 5', 'shelf'),
];

// Live staging, 13 rows, 2026-08-20. Overlaps prod but is NOT a subset — it carries two `tray` rows
// prod has never had, which are the only live exercise the tray arm gets anywhere.
const STAGING = [
  loc('Deck', 'zone'), loc('House', 'zone'), loc('Indoor Rack', 'rack'),
  loc('Left Tray', 'tray'), loc('Right Tray', 'tray'),
  loc('Pasture', 'zone'), loc('Stable', 'zone'), loc('Steps', 'zone'),
  loc('Shelf 1', 'shelf'), loc('Shelf 2.1', 'shelf'), loc('Shelf 3', 'shelf'),
  loc('Shelf 4', 'shelf'), loc('Shelf 5', 'shelf'),
];

// Arms live data does not reach, plus the two near-misses that a sloppier predicate would get wrong.
const SYNTHETIC = [
  loc('Low Tunnel Bed', null),          // NULL type_label -> unknown, NOT false
  loc('Cold Frame', 'bed'),             // unrecognised type_label -> exposed
  loc('Stables', 'zone'),               // near-miss on the name arm: plural is NOT Stable
  loc('The House', 'zone'),             // near-miss: substring is NOT an IN match
  loc('house', 'zone'),                 // case matters — SQL IN on text is case-sensitive
  loc('Shelf 9', 'Shelf'),              // type_label case matters too
];

const ALL = [...PROD, ...STAGING, ...SYNTHETIC];

describe('V4-COVEREDNOTMODELLED-001 — 0b backfill reproduces the name-match', () => {
  it('parses the real CASE out of 0b-data.sql (non-vacuity)', () => {
    const arms = armsOf(BACKFILL);
    expect(arms.length).toBe(4);
    expect(arms.map((a) => a.op)).toEqual(['in', 'in', 'isnull', 'else']);
    // The two magic sets, read from the file rather than assumed.
    expect(arms[0]).toMatchObject({ col: 'name', set: ['Stable', 'House'], value: true });
    expect(arms[1]).toMatchObject({ col: 'type_label', set: ['shelf', 'rack', 'tray'], value: true });
  });

  it('agrees with the legacy predicate on every live prod row', () => {
    for (const row of PROD) {
      expect(evaluate(armsOf(BACKFILL), row), `prod row ${row.name}`).toBe(legacy(row));
    }
  });

  it('agrees with the legacy predicate on every live staging row', () => {
    for (const row of STAGING) {
      expect(evaluate(armsOf(BACKFILL), row), `staging row ${row.name}`).toBe(legacy(row));
    }
  });

  it('agrees on the arms live data does not reach, incl. both name near-misses', () => {
    for (const row of SYNTHETIC) {
      expect(evaluate(armsOf(BACKFILL), row), `synthetic row ${row.name}`).toBe(legacy(row));
    }
  });

  it('preserves NULL as a distinct third state, never collapsing it to false', () => {
    // The BUG-NOLOCOUTDOOR-001 invariant, restated at the backfill. `toBe(null)` and not a falsy
    // check: `false` would pass a truthiness assertion and mean "open to the sky", which is the
    // exact misclassification that fix existed to remove.
    const v = evaluate(armsOf(BACKFILL), loc('Low Tunnel Bed', null));
    expect(v).toBe(null);
    expect(v).not.toBe(false);
  });

  it('classifies the measured prod population exactly 8 covered / 13 exposed', () => {
    // The census this row was opened to establish, pinned so a silent reclassification of the whole
    // garden cannot ship as a green diff.
    const arms = armsOf(BACKFILL);
    const covered = PROD.filter((r) => evaluate(arms, r) === true);
    expect(covered.length).toBe(8);
    expect(PROD.filter((r) => evaluate(arms, r) === false).length).toBe(13);
    expect(covered.map((r) => r.name).sort()).toEqual(
      ['House', 'Indoor Rack', 'Shelf 1', 'Shelf 2', 'Shelf 3', 'Shelf 4', 'Shelf 5', 'Stable']);
  });

  it('handler.js states its coverage source — legacy name-match OR the flag, never neither', () => {
    // Always-asserting across the migration boundary, so it cannot go quietly vacuous the day the
    // reader changes. Pre-apply the handler carries the name arm; post-apply it carries the
    // flag-first arm. A handler carrying NEITHER has lost its coverage derivation entirely, which
    // would silently rain-credit every planting in the garden.
    const flat = decomment(HANDLER).replace(/\s+/g, ' ');
    const legacyArm = /when l\.name in \('Stable','House'\) then true/i.test(flat);
    const flagArm = /when l\.covered is not null then l\.covered/i.test(flat);
    expect(legacyArm || flagArm, 'handler.js has no recognisable coverage arm').toBe(true);
    // And the two must not coexist: the flag arm makes the name arm dead code that would still
    // fire for rows Dave has not yet stated, which is the ambiguity this row exists to remove.
    expect(legacyArm && flagArm, 'handler.js carries BOTH arms — the swap is half-done').toBe(false);
  });
});
