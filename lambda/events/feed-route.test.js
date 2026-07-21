// V3-FEED-001 regression guard — paginated /api/events/feed. Static-source per L-072 (DB-free).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

// Bound the slice by the NEXT route handler, never by a fixed character count. The original
// `slice(i, i + 1800)` was a byte-count guess, and measured 2026-07-21 the feed route is 2940 chars
// — so the window was TRUNCATING the route by ~1100 chars, not overrunning it. (A prior handoff
// recorded the opposite, that it ran 4 lines into the harvest-summary comment; that was measured and
// is false. Correcting it here so the next reader doesn't re-derive it.)
// Both directions are bugs, in opposite ways: truncation makes an assertion fail once its target
// moves past the cutoff (loud, but a false alarm), while overrun makes assertions silently match
// FOREIGN code (quiet, and a false pass). A route-bounded window has neither failure mode and stops
// tracking file growth. harvest-ready.test.js already uses this next-marker pattern; this aligns.
function feedBlock(src) {
  const i = src.indexOf("rawPath === '/api/events/feed'");
  if (i === -1) return '';
  // First route handler declared after feed. Falls back to end-of-file if feed is ever last.
  const next = src.indexOf("if (rawPath === '/api/events/", i + 1);
  return src.slice(i, next === -1 ? undefined : next);
}

describe('events Lambda — V3-FEED-001 /api/events/feed', () => {
  it('routes GET /api/events/feed', () => {
    expect(SRC).toMatch(/rawPath === '\/api\/events\/feed' && method === 'GET'/);
  });
  const b = feedBlock(SRC);
  it('is household-scoped and excludes deleted + archived', () => {
    expect(b).toMatch(/pp\.created_by = ANY\(\$\{householdIds\}\)/);
    expect(b).toMatch(/e\.deleted_at IS NULL/);
    expect(b).toMatch(/pp\.archived_at IS NULL/);
  });
  it('supports project_id / event_type / from / to filters (null-guarded, cast-safe)', () => {
    expect(b).toMatch(/\$\{fProject\}::uuid IS NULL OR e\.project_id = \$\{fProject\}::uuid/);
    expect(b).toMatch(/\$\{fType\}::text IS NULL OR e\.event_type = \$\{fType\}::text/);
    expect(b).toMatch(/\$\{fFrom\}::timestamptz IS NULL OR e\.event_date >= \$\{fFrom\}::timestamptz/);
    expect(b).toMatch(/\$\{fTo\}::timestamptz IS NULL OR e\.event_date <= \$\{fTo\}::timestamptz/);
  });
  it('paginates via LIMIT/OFFSET and caps the page at 100', () => {
    expect(b).toMatch(/LIMIT \$\{limit\} OFFSET \$\{offset\}/);
    expect(b).toMatch(/Math\.min\(parseInt\(qp\.limit \?\? '30', 10\) \|\| 30, 100\)/);
    expect(b).toMatch(/has_more: rows\.length === limit/);
  });
  it('carries batch item_count + forward-looking critter linkage', () => {
    expect(b).toMatch(/eb\.item_count/);
    expect(b).toMatch(/cs\.source_event_id = e\.id AND cs\.deleted_at IS NULL/);
    expect(b).toMatch(/cs\.species_id AS critter_species_id/);
  });
});
