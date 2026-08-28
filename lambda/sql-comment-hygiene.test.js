import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

// Guard against the L-086-class bug: a JS `//` comment placed INSIDE a SQL template
// ships literal `//` to Postgres (SQL line comments are `--`), 500-ing at runtime
// while vitest/vite stay green (static + mock never hit a real DB).
// Caught in household-mode review 2026-05-20 (inventory-items UPDATE SET block).
const here = dirname(fileURLToPath(import.meta.url));

// The FILES list this guard used to carry was hand-maintained and had drifted to 10 of the
// fleet's 103 handler files, while its commit message claimed it was "fleet-wide". A hand list
// is the wrong shape: it fails OPEN for every file nobody remembered to add, and silently, since
// an unlisted file simply produces no test. Enumerate instead — a new handler is covered the day
// it lands. The vacuity floors below are what keep the enumeration honest.
function walk(dir, out = [], { includeTests = false } = {}) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out, { includeTests });
    else if (entry.endsWith('.js') && (includeTests || !entry.endsWith('.test.js'))) out.push(p);
  }
  return out;
}

// tests/integration/** IS IN SCOPE, and learning that cost a red dev.
//
// This guard was written for the L-086 bug and then failed to catch a textbook instance of it on
// 2026-08-28: a `//` comment placed between INSERT and VALUES inside a directSql template, which
// Postgres rejected with 42601 "syntax error at or near //". It missed it three separate ways —
//   1. it walked only lambda/, and the offender was in tests/integration/;
//   2. it skipped *.test.js by construction, and every integration file ends in .int.test.js;
//   3. its matcher required `sql` NOT preceded by a word character, so `directSql` — the tagged
//      template the entire integration harness uses — could never match at all.
// Any one of the three would have been enough to hide it. This is the guards-fail-by-altitude
// pattern: the rule was right and simply was not looking where the code was.
//
// Integration files are exactly where this hazard is LEAST likely to be caught by anything else:
// they are the only place in the tree that sends hand-written SQL to a real Postgres, and they do
// not run in the unit suite, so a broken statement here is invisible until CI.
//
// OVERLAP, DELIBERATE AND BOUNDED — see src/__tests__/sqlTemplateComments.test.js, written the same
// day for the same incident. That file is the better `//` guard and should be treated as the
// primary one: it walks four roots (lambda, src, tests, scripts) rather than two, matches more tag
// shapes including `db.query`, and requires a template body to OPEN with a SQL verb rather than
// merely contain one — a distinction that cost it 19 false positives to discover and that this
// file's looser "contains" filter has not had to face only because its walk is narrower.
// What is NOT duplicated, and is the reason this widening still earns its place, is the SECOND
// describe block below: a `${...}` placeholder inside a `--` SQL comment, which JavaScript
// interpolates even though Postgres ignores the comment, throwing ReferenceError at runtime for a
// binding that no longer exists. That hazard is checked nowhere else, and until this walk was
// widened it was checked nowhere in the integration suite at all.
const INTEGRATION_DIR = join(here, '..', 'tests', 'integration');
const FILES = [
  ...walk(here),
  ...walk(INTEGRATION_DIR, [], { includeTests: true }),
].map((p) => relative(here, p)).sort();

// Two call shapes carry SQL in this fleet and BOTH are template literals, so both hazards below
// apply to both:
//   1. `sql`...`` — the neon tagged template (48 files).
//   2. `pg.query(`...`)` — node-postgres with positional $n params (daily-plan/handler.js).
// The old matcher only knew shape 1, so daily-plan/handler.js could not be matched AT ALL even
// though it was the file that produced the 2026-08-07 placeholder incident's sibling hazards.
//
// Shape 1 matches any identifier ENDING in sql/Sql/SQL — `sql`, and also `directSql`, which is the
// tag the whole integration harness uses. It was previously anchored as `(?<![\w`])sql` , i.e. `sql`
// with nothing word-like before it, so `directSql` was unmatchable: the `s` is preceded by `t`. The
// guard therefore reported zero templates for every integration file and passed on all of them,
// which is the worst possible failure for an enumerating guard — silent, and indistinguishable
// from clean. Leading `[\w$]*` is the optional prefix; the lookbehind moved to the START of the
// identifier and still excludes a preceding backtick, which is what keeps JS prose like
// "calls `sql`..." from being read as a query.
// Bodies are a non-backtick run (a template literal carrying SQL never contains a literal
// backtick). Then keep only bodies that look like SQL, which stops a two-backtick span inside
// ordinary prose from being treated as a query.
const SQL_TEMPLATE_RES = [/(?<![\w$`])[\w$]*[sS][qQ][lL]`([^`]*)`/g, /\.query\(\s*`([^`]*)`/g];
function sqlTemplates(src) {
  const out = [];
  for (const re of SQL_TEMPLATE_RES) {
    let m;
    while ((m = re.exec(src)) !== null) {
      const body = m[1];
      if (/\b(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(body)) out.push(body);
    }
  }
  return out;
}

const SRC = new Map(FILES.map((rel) => [rel, readFileSync(join(here, rel), 'utf-8')]));

// A guard that enumerates its own inputs can go green by covering NOTHING: break the walk and
// every `it` below simply stops existing; break the regexes and each one runs against an empty
// template list and passes. Both failure modes are invisible in a passing suite. Three guards
// written on 2026-08-07 were green-but-not-covering in exactly this way, so this fleet-wide
// rewrite pins its own coverage to measured floors (103 files / 50 with SQL / 395 templates as
// of cc4c7369) rather than trusting that it found anything.
describe('guard coverage is not vacuous', () => {
  // Floors re-measured 2026-08-28 after tests/integration/** and the `directSql` shape were added:
  // 183 files / 108 with SQL / 1531 templates, up from 103 / 50 / 395. Set below measured so normal
  // churn passes, but high enough that losing either half of the walk — or the identifier-prefix in
  // the matcher — reds this file instead of quietly reporting a clean fleet.
  it('walks the whole handler fleet AND the integration suite', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(165);
  });

  it('extracts SQL from both call shapes across the fleet', () => {
    const withSql = FILES.filter((rel) => sqlTemplates(SRC.get(rel)).length > 0);
    const total = FILES.reduce((n, rel) => n + sqlTemplates(SRC.get(rel)).length, 0);
    expect(withSql.length).toBeGreaterThanOrEqual(95);
    expect(total).toBeGreaterThanOrEqual(1350);
  });

  // Separate floor for the integration half. Without it, deleting the second walk would drop
  // FILES by 49 and could still clear a single combined floor on handler growth alone — the
  // integration suite would silently leave coverage again, exactly as it was before 2026-08-28.
  it('covers the integration suite specifically, not just the handlers', () => {
    const integ = FILES.filter((rel) => rel.includes(`tests${sep}integration`));
    const integWithSql = integ.filter((rel) => sqlTemplates(SRC.get(rel)).length > 0);
    expect(integ.length).toBeGreaterThanOrEqual(40);
    expect(integWithSql.length).toBeGreaterThanOrEqual(38);
  });

  // Named individually because each proves a specific past gap is closed: daily-plan/handler.js
  // is the `pg.query(` shape the old matcher could not see, locations/index.js is a file the
  // hand list omitted while it was being changed, and cascade-sweep is the file that shipped the
  // 42601 to dev on 2026-08-28 — it uses `directSql`, which the old matcher could not see at all.
  it.each([
    'daily-plan/handler.js', 'locations/index.js', 'events/index.js', 'projects/index.js',
    join('..', 'tests', 'integration', 'cascade-sweep.int.test.js'),
  ])('still matches SQL in %s', (rel) => {
    expect(FILES).toContain(rel);
    expect(sqlTemplates(SRC.get(rel)).length).toBeGreaterThan(0);
  });
});

describe('SQL template comment hygiene', () => {
  for (const rel of FILES) {
    it(`${rel}: no '//' inside any SQL template`, () => {
      const offenders = sqlTemplates(SRC.get(rel)).filter((t) => t.includes('//'));
      expect(offenders, `'//' found inside a SQL template in ${rel} (use '--' for SQL comments, or move the comment to JS scope)`).toEqual([]);
    });
  }
});

// The sibling hazard, and a nastier one: a template placeholder inside a `--` SQL comment.
//
// The `--` makes it a comment to POSTGRES, but the template literal is evaluated by JAVASCRIPT
// first — so the placeholder still interpolates. Write a now-deleted binding's name in a comment
// explaining why you deleted it and you get ReferenceError at runtime, on every request down that
// path. Hit live 2026-08-07 while removing `movedType` for BUG-CACHEGATE-001: the explanatory
// comment named the very binding it had just removed.
//
// Nothing else catches it. `node --check` is a syntax check and does not resolve scope; ESLint is
// configured without no-undef here (verified — reintroducing the fault produced zero lint output);
// and every static-source test reads the file as TEXT, so the placeholder is just characters to
// them. Only actually executing the route fails, which means CI integration tests or prod.
//
// A placeholder in a comment is never load-bearing, so this bans the shape outright rather than
// trying to decide which identifiers are still in scope.
describe('SQL template placeholder hygiene', () => {
  for (const rel of FILES) {
    it(`${rel}: no template placeholder inside a '--' SQL comment`, () => {
      const offenders = [];
      for (const t of sqlTemplates(SRC.get(rel))) {
        for (const line of t.split('\n')) {
          const c = line.indexOf('--');
          if (c === -1) continue;
          // Only the comment tail. A placeholder BEFORE the `--` on the same line is real SQL.
          if (/\$\{/.test(line.slice(c))) offenders.push(line.trim());
        }
      }
      expect(offenders,
        `a template placeholder appears inside a '--' comment in ${rel}. Postgres ignores the ` +
        'comment but JavaScript still interpolates it, so a stale or deleted binding throws ' +
        'ReferenceError at runtime while every static check stays green. Describe the binding in ' +
        'prose instead of reproducing its placeholder.').toEqual([]);
    });
  }
});
