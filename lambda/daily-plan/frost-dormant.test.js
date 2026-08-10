// BUG-FROSTDORMANT-001 — dormant plantings must never reach the frost exposure set.
//
// Dave, 2026-08-10: dormant stock is in temp/humidity-controlled bins and "never need that treatment".
//
// THE DEFECT. handler.js builds one plan per Space and then evaluates frost for that Space:
//   generatePlan({ plantings: rows, ... })   <- filters dormant INTERNALLY (engine.js:387)
//   summarize(rows, ...)                     <- got the SAME UNFILTERED rows
// engine.js:387 is `if(p.status==='dormant' || c.dormant_skip){ dormant.push(...); continue; }` and it
// fires before the cold bucket at :493 — but that guard lives inside the engine and does not travel
// with the array. So the frost path, a genuinely outbound alert (FROST_ALERT_ENABLED="true" in prod,
// SNS topic emails the owner), classified dormant plantings for cold protection.
//
// WHY IT WAS INVISIBLE, and why that is thin cover rather than safety: of the four live dormant
// plantings, three sit in a `hardy` band and skip inside frostClass; the fourth (Christmas Cactus,
// tropical/tender) was excluded ONLY by a literal location-name match. Move it to a differently-named
// location — which is precisely what "they are in temp/humidity controlled bins right now" describes —
// and it enters the next frost alert. The cold bucket is also 0 all summer, so nothing would have
// surfaced this until the first cold night.
//
// Source-text guard, matching this directory's house pattern (status-care.test.js): the handler cannot
// be imported here — each Lambda is zipped per-directory with its own package.json and CI installs the
// ROOT manifest only, so an import that resolves locally CANNOT resolve in CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HANDLER = readFileSync(resolve(__dirname, 'handler.js'), 'utf8');

// Comment-strip before asserting on source. A guard that matches raw text is defeated by deleting the
// live code and leaving it in a comment — and this file's own header quotes the very predicate it
// asserts, so an unstripped match here would pass on the prose above.
const CODE = HANDLER
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))   // keep `https://` intact
  .join('\n');

describe('BUG-FROSTDORMANT-001 — frost exposure excludes dormant', () => {
  it('summarize() is NOT called with the unfiltered per-space rows', () => {
    // The exact defect shape. If this ever matches again, the leak is back.
    expect(CODE).not.toMatch(/summarize\(\s*rows\s*,/);
  });

  it('summarize() receives a filtered set', () => {
    expect(CODE).toMatch(/summarize\(\s*careRows\s*,/);
  });

  it('the filter uses the ENGINE predicate — status dormant OR cadence dormant_skip', () => {
    // Parity with engine.js:387 matters more than the filter merely existing: a status-only filter
    // would silently diverge for cadence-declared dormancy (c.dormant_skip), which is the same class
    // of bug one layer down.
    const m = CODE.match(/careRows\s*=\s*rows\.filter\(([\s\S]{0,400}?)\}\);/);
    expect(m).toBeTruthy();
    expect(m[1]).toMatch(/status\s*===\s*'dormant'/);
    expect(m[1]).toMatch(/dormant_skip/);
  });

  it('resolveCadence is available to build that predicate (not re-implemented)', () => {
    expect(CODE).toMatch(/require\(['"]\.\/engine['"]\)/);
    expect(CODE).toMatch(/resolveCadence/);
  });
});
