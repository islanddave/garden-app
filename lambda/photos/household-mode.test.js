// HOUSEHOLD-MODE static-source guard (photos Lambda) — uploaded_by -> created_by SWITCH.
// Photos previously scoped by uploaded_by = ${userId}; Household Mode switches the SCOPE
// FILTERS to created_by = ANY(${householdIds}) (created_by is canonical, populated).
// uploaded_by survives ONLY as a display/INSERT column. Static-source (L-072), DB-free.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

// A SCOPE FILTER NAMED IN A COMMENT IS NOT A SCOPE FILTER.
// The census below was already exact (toBe(23), after the `>= 10 against 23` vacuity was fixed) —
// but it counted matches in RAW source, so the count could be held at 23 by prose.
// MUTATION that this closes: rewrite the container auto-promote arm's
// `AND created_by = ANY(${householdIds})` to `AND TRUE -- dropped: created_by = ANY(${householdIds})`
// — a live cross-household featured-photo WRITE — and all 9 tests passed. The same deletion
// WITHOUT the trailing comment reddened the census, which is what made the mechanism unambiguous.
// `//` stripping is URL-safe (`[^:]` guard); `--` requires surrounding space so a JS decrement
// is never mistaken for a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const CODE = decomment(SRC);

describe('photos Lambda — Household Mode uploaded_by -> created_by switch', () => {
  it('imports householdScope + computes householdIds', () => {
    // V4-SPACEPHOTO-001: match householdScope among a NAMED-IMPORT LIST, not as the sole import —
    // the handler now also pulls loadOwnedSpace/warnRejectedFk (same loosening as plants/
    // inventory-items did at V4-AUTHZSWEEP-001). The invariant is that householdScope is imported
    // from the per-dir copy, not that it is alone in the braces.
    expect(SRC).toMatch(/import \{[^}]*\bhouseholdScope\b[^}]*\} from '\.\/household\.js'/);
    expect(SRC).toMatch(/const householdIds = householdScope\(userId\)/);
  });

  it('NO uploaded_by scope filter remains (only INSERT column survives)', () => {
    // view-url SELECT, both LIST SELECTs, and the re-tag UPDATE guard all switched.
    expect(SRC).not.toMatch(/uploaded_by = \$\{userId\}/);
    expect(SRC).not.toMatch(/p\.uploaded_by = \$\{userId\}/);
    // The INSERT column list still names uploaded_by (display/author column).
    // `[,)]` not `)`: V4-PHOTOBULK-001 appended capture-metadata columns after created_by, so
    // created_by is no longer the LAST column. That was incidental to this guard — the invariant
    // is that uploaded_by and created_by are both still bound, not their position in the list.
    expect(CODE).toMatch(/uploaded_by, created_by[,)]/);
  });

  it('scope filters + cross-entity featured-photo guards use created_by = ANY(${householdIds})', () => {
    // EXACT, not >=. The floor was `>= 10` against a real population of 23 — it licensed the
    // deletion of THIRTEEN scope filters, each one a cross-household photo read or write, while
    // reporting green. Proven by mutation: rewrite 13 of the 23 `created_by = ANY(${householdIds})`
    // conjuncts to `TRUE` (leaving exactly 10) and every test in this file passed. A census whose
    // floor sits below its own population is not a census.
    //
    // Adding a legitimately-new scoped site is a deliberate change: bump this number in the same
    // commit. That cost is the point — it is what makes a REMOVED site impossible to miss.
    // The regex matches every qualified form (p./pp./ph./bare), so this is the whole population.
    const matches = CODE.match(/created_by = ANY\(\$\{householdIds\}\)/g) ?? [];
    expect(matches.length,
      'photos/index.js household-scope site count changed. A DROP is a cross-tenant leak; an ADD ' +
      'needs this count bumped deliberately.').toBe(23); // 23 at d9afab95
  });

  it('UPDATE locations auto-promote arm carries the ownership predicate (BUG-PHOTOLOCAUTHZ-001)', () => {
    // INVERTED 2026-07-28. The old assertion pinned this arm OPEN ("backfill-gated, out of
    // scope") — but locations has 0 NULL created_by across all 29 live rows (W0.2-r1
    // locations-census), so there is no backfill gate and the missing predicate was a
    // cross-tenant featured-photo write. The arm must now match its 3 siblings.
    const locIdx = CODE.indexOf('UPDATE locations');
    expect(locIdx).toBeGreaterThan(-1);
    const block = CODE.slice(locIdx, locIdx + 400);
    expect(block).toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
    expect(block).toMatch(/featured_photo_id IS NULL/);
    expect(block).toMatch(/deleted_at IS NULL/);
  });

  it('INSERT still binds uploaded_by + created_by = ${userId}', () => {
    const insIdx = CODE.indexOf('INSERT INTO photos');
    // Window widened 600 -> 1200: the INSERT grew by 8 capture-metadata columns
    // (V4-PHOTOBULK-001) and the old window no longer reached the end of the statement, so the
    // householdIds negative assertion below was scanning a truncated block.
    const block = CODE.slice(insIdx, insIdx + 1200);
    expect(block).toMatch(/uploaded_by, created_by[,)]/);
    expect(block).not.toMatch(/householdIds/);
  });

  it('no array spread (42P18 guard)', () => {
    expect(SRC).not.toMatch(/\$\{\.\.\.householdIds\}/);
  });
});

// BEHAVIOR-LEVEL guard (BUG-PHOTOLOCAUTHZ-001) — executes the REAL autoPromoteFeatured against a
// recording fake of the Neon tagged-template `sql` (the lambda/events/critterAward.test.js pattern)
// and asserts the SQL it actually EMITS, not just the source text. index.js cannot be imported here
// (its @aws-sdk/@clerk/@neondatabase imports are per-Lambda deps, not installed at the repo root),
// so the function source is extracted verbatim and instantiated — same executed code, zero deps.
// The true end-to-end check (row actually protected in Postgres) is Wave-4 staging smoke.
function extractFunction(src, header) {
  const start = src.indexOf(header);
  if (start === -1) return null;
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

function makeSql() {
  const calls = [];
  const sql = (strings, ...values) => {
    calls.push({ text: strings.join('¶'), values });
    return Promise.resolve([]);
  };
  sql.calls = calls;
  return sql;
}

describe('autoPromoteFeatured — locations arm behavior (BUG-PHOTOLOCAUTHZ-001)', () => {
  const fnSrc = extractFunction(SRC, 'async function autoPromoteFeatured');

  it('function source extracted (guard for the extraction itself)', () => {
    expect(fnSrc).toBeTruthy();
    expect(fnSrc).toMatch(/UPDATE locations/);
  });

  it('a location-linked photo emits ONE locations UPDATE that carries the ownership predicate AND binds householdIds', async () => {
    const autoPromoteFeatured = new Function(`return (${fnSrc});`)();
    const sql = makeSql();
    const householdIds = ['user_dave', 'user_jen'];
    await autoPromoteFeatured(sql, { id: 'photo-1', location_id: 'loc-1' }, householdIds);
    const locCalls = sql.calls.filter((c) => c.text.includes('UPDATE locations'));
    expect(locCalls).toHaveLength(1);
    // The emitted statement must guard ownership...
    expect(locCalls[0].text).toMatch(/created_by = ANY\(/);
    // ...and actually BIND the household ids as a parameter (not merely mention them).
    expect(locCalls[0].values).toContainEqual(householdIds);
    // Sibling invariants preserved on the same emitted statement.
    expect(locCalls[0].text).toMatch(/featured_photo_id IS NULL/);
    expect(locCalls[0].text).toMatch(/deleted_at IS NULL/);
  });

  it('location-only photo fires ONLY the locations arm (no cross-arm writes)', async () => {
    const autoPromoteFeatured = new Function(`return (${fnSrc});`)();
    const sql = makeSql();
    await autoPromoteFeatured(sql, { id: 'photo-2', location_id: 'loc-9' }, ['user_dave']);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].text).toContain('UPDATE locations');
  });
});
