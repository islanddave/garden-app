// BUG-BLANKNAME-001 — the fleet guard.
//
// THE CLASS: a PUT that binds the display name as `COALESCE(${body.name ?? null}, display_name)`
// is protected against NULL and NOTHING ELSE. Every client in this app sends a TRIMMED string, so
// an emptied name box does not send NULL — it sends `''`. Empty string is not NULL: it sails past
// the COALESCE, past a NOT NULL constraint, and overwrites the name.
//
// WHY IT MATTERS BEYOND COSMETICS: on `locations` the name is a CARE-ENGINE INPUT.
// lambda/daily-plan/handler.js derives `covered` partly from `l.name in ('Stable','House')`.
// Measured on prod at authoring time: Stable carries 20 live plantings and House 6. Blanking either
// silently reclassifies 26 plantings as OUTDOOR — they begin taking rain credit under a roof and
// drop out of the frost pass's covered exclusion. Nothing 500s and nothing logs.
//
// FOUND BY A FLEET SWEEP, NOT BY THE TICKET. The ticket was written against `locations` and
// `projects`. Sweeping every handler for the binding turned up two more the ticket never named:
// `plants` (no guard at all, and garden_node.display_name is NULLABLE so not even a constraint
// stands behind it) and `varieties` (a guard that existed but did not run on the PUT — its
// validateBody gated the required-check and the blank-check on ONE `requireName` flag, and the PUT
// passes requireName:false so it could omit the key, which silently disabled both).
//
// THIS FILE IS THE RATCHET. It is derived FROM DISK, in the posture of
// clear-channel-coverage.test.js, so a newly added handler is covered the day it lands rather than
// the day someone remembers to add a row.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const lambdaDirs = () => readdirSync(here, { withFileTypes: true })
  .filter(e => e.isDirectory() && existsSync(join(here, e.name, 'index.js')))
  .map(e => e.name)
  .sort();

// Line comments stripped so a binding quoted in an explanatory block does not count as live, and so
// a handler cannot satisfy the guard by describing it in prose.
const strip = src => src.split('\n').map(l => l.replace(/--.*$/, '').replace(/\/\/.*$/, '')).join('\n');

const readAll = d => {
  const idx = strip(readFileSync(join(here, d, 'index.js'), 'utf8'));
  const val = existsSync(join(here, d, 'validate.js'))
    ? strip(readFileSync(join(here, d, 'validate.js'), 'utf8')) : '';
  return idx + '\n' + val;
};

// The vulnerable binding: the display name bound through COALESCE off the request body.
const COALESCE_NAME = /COALESCE\(\s*\$\{\s*body\.name\b/;

// The guard, in either of its two legitimate spellings — inline in the handler, or in a sibling
// validate.js. Both must test the value for blankness while treating null/absent as a no-op, so
// both are anchored on the `!= null` half: that is the part that keeps the existing partial-update
// grammar working, and a guard without it is the over-broad form rejected below.
const HAS_GUARD = /body\.name\s*!=\s*null\s*&&\s*\(\s*typeof\s+body\.name\s*!==\s*'string'\s*\|\|\s*!\s*body\.name\.trim\(\)\s*\)/;

describe('BUG-BLANKNAME-001: every handler that COALESCE-binds body.name refuses a blank one', () => {
  const dirs = lambdaDirs();
  const withNameBinding = dirs.filter(d => COALESCE_NAME.test(readAll(d)));

  // THE NON-EMPTY SANITY ASSERTION. Without it, a refactor that renames `body` or reformats the
  // binding across lines turns this whole file into a vacuous pass that still reports green.
  // Assert the shape of the world before asserting anything about it.
  it('finds the COALESCE-name handler set (guards against an empty match)', () => {
    expect(dirs.length).toBeGreaterThanOrEqual(20);
    // The four found by the sweep. If any stops matching, the sweep has gone blind rather than the
    // binding having been removed — a fixed handler still carries its COALESCE, plus a guard.
    expect(withNameBinding).toEqual(
      expect.arrayContaining(['locations', 'plants', 'projects', 'varieties']));
    expect(withNameBinding.length).toBeGreaterThanOrEqual(4);
  });

  for (const d of lambdaDirs()) {
    if (!COALESCE_NAME.test(readAll(d))) continue;
    it(`${d} binds body.name through COALESCE and must refuse a blank name`, () => {
      expect(readAll(d),
        `${d} binds body.name through COALESCE but never rejects a blank string. COALESCE guards ` +
        "NULL, not ''; the client sends a trimmed string, so an emptied box overwrites the name. " +
        'Add the guard (see lambda/locations/index.js) or, if the name is genuinely free-form, say ' +
        'so here with a reason.')
        .toMatch(HAS_GUARD);
    });
  }

  it.each(['locations', 'plants', 'projects'])(
    '%s keeps the two name checks distinct — required on create, non-blank on update', (d) => {
      // The design decision, made executable, and the assertion this file got WRONG on its first
      // pass: `if (!body.name)` is not itself the bug. On a CREATE path it is exactly right, and all
      // three of these handlers legitimately use it there for a genuinely required field.
      //
      // The bug is using that broad form as the UPDATE path's blank check, where it also catches
      // `name: null` — the existing no-op grammar of a partial-update PUT that every current caller
      // depends on — and converts working requests into 400s.
      //
      // Rather than slice the PUT block out by hand (this codebase has been bitten four times by
      // static-source tests anchored on non-unique tokens), the distinction is asserted through the
      // ERROR EACH FORM RETURNS, which is unambiguous and position-independent: the broad form must
      // always answer 'name is required' (create semantics), and 'name cannot be blank' must never
      // be reached through it.
      const src = readAll(d);
      for (const m of src.matchAll(/if\s*\(\s*!\s*body\.name\s*\)\s*(?:return\s*)?resp\(400,\s*\{\s*error:\s*'([^']*)'/g)) {
        expect(m[1], `${d}: the broad !body.name form is answering '${m[1]}'. On a create path it ` +
          "must answer 'name is required'; a blank check must use the narrow != null form so a " +
          'legitimate name:null on a partial update stays a no-op.')
          .toBe('name is required');
      }
      // And the narrow form must be the one carrying the blank message.
      expect(src).toMatch(/body\.name\s*!=\s*null[\s\S]{0,120}name cannot be blank/);
    });

  it('varieties separates "required" from "non-blank" so the PUT still gets the blank check', () => {
    // The subtlest of the four and the reason a fleet sweep was worth writing. One condition gated
    // on requireName meant the PUT (requireName:false, so the key may be omitted) skipped BOTH
    // checks. Absence and emptiness are different questions; only the first is optional.
    const val = strip(readFileSync(join(here, 'varieties', 'validate.js'), 'utf8'));
    expect(val).toMatch(/requireName\s*&&\s*body\.name\s*==\s*null/);
    expect(val, 'the blank check must NOT sit behind requireName — that is the original defect')
      .not.toMatch(/requireName\s*&&\s*\(\s*!\s*body\.name/);
  });
});
