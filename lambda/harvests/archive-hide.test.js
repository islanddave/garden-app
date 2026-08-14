// V4-ARCHIVEHIDE-001 (L3) — harvests on ARCHIVED plantings must not be loaded by the Harvests page.
//
// Three read models share one page (entries, aggregates, weight totals) and a predicate present in
// two of them is the shape that makes a season total silently disagree with the rows under it, so
// every assertion below is a COUNT of three rather than a "contains".
//
// AXIS: archived_at, not deleted_at — orthogonal columns. The `LEFT JOIN ... AND gn.deleted_at IS
// NULL` on each query is deliberately NOT the place for the new predicate (a LEFT JOIN ON clause
// would NULL the planting columns and keep the harvest in every total), which the last `it` pins.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

const count = (re) => (SRC.match(re) || []).length;

describe('harvests Lambda — archived plantings are excluded from the read models (L3)', () => {
  it('all three read models carry the archived anti-join', () => {
    expect(count(/NOT EXISTS \(\s*SELECT 1 FROM public\.garden_node gna\s*WHERE gna\.id = e\.plant_id AND gna\.archived_at IS NOT NULL\s*\)/g)).toBe(3);
  });

  // The carve-out and the leak are ONE predicate, so they are pinned together: `${plant} IS NOT NULL
  // OR NOT EXISTS(...)` suppresses the filter exactly when the caller named a planting, which is
  // PlantingDetail's own harvest list (src/pages/PlantingDetail.jsx) — the deliberate route to an
  // archived planting. Any rewrite that drops the gate silently blanks that page.
  it('the filter is gated off when ?plant= names one planting (the deliberate route)', () => {
    expect(count(/AND \(\$\{plant\}::uuid IS NOT NULL OR NOT EXISTS \(/g)).toBe(3);
  });

  it('still filters when ?plant= is absent — the gate is not a blanket bypass', () => {
    // The plain `plant IS NULL OR e.plant_id = plant` scoping predicate must survive alongside it;
    // collapsing the two into one is how the aggregate leak silently re-opens.
    expect(count(/AND \(\$\{plant\}::uuid IS NULL OR e\.plant_id = \$\{plant\}::uuid\)/g)).toBe(3);
  });

  it('the predicate is in the WHERE clause, not on the LEFT JOIN (which would keep the row)', () => {
    expect(SRC).not.toMatch(/LEFT JOIN garden_node gn ON gn\.id = e\.plant_id AND gn\.archived_at/);
    expect(count(/LEFT JOIN garden_node gn ON gn\.id = e\.plant_id AND gn\.deleted_at IS NULL/g)).toBe(3);
  });
});
