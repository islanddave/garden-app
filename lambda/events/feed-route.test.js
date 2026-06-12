// V3-FEED-001 regression guard — paginated /api/events/feed. Static-source per L-072 (DB-free).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

function feedBlock(src) {
  const i = src.indexOf("rawPath === '/api/events/feed'");
  return i === -1 ? '' : src.slice(i, i + 1800);
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
