// BUG-SEEDDETAIL500-001 — the garden_node columns this handler selects must exist on garden_node.
//
// THE BUG: the germination summary selected `p.name` from public.garden_node. That column does not
// exist — it is `display_name`. Postgres raised, the handler's catch turned it into a 500, and
// EVERY seed packet detail page in prod returned "Internal server error". Measured 2026-08-28
// against live prod: two different seed items 500 (one of them 'True Greek Oregano Seeds', bought
// long before this session), a non-seed item returns 200, and the list endpoint returns 200 —
// the fault is confined to the `category === 'seeds'` branch, which is the only place this table
// is queried. Fix is `p.display_name AS name`, keeping the wire contract that
// InventoryDetail.jsx:306 renders as `{s.name}`.
//
// WHY IT SURVIVED, and why this file is separate from select-columns.test.js: that file is the
// L-081 Phase 1 contract, and scripts/dev-main-schema-audit.py audits the columns it declares
// against prod's information_schema. It declares exactly ONE table — inventory_items — and its
// header says so deliberately, because the auditor cross-products every declared array against
// every declared table. So the second relation this handler touches was audited by NOTHING, and a
// column that does not exist on it sailed past a green audit, a green unit suite and a green
// integration run. This file closes the specific hole; it is NOT wired into the prod auditor (which
// discovers only `select-columns.test.js`), so treat it as a source-level guard, not as coverage.
//
// Static source inspection rather than import: index.js loads @neondatabase/serverless and
// @clerk/backend at module scope and cannot be imported under `npm ci` in CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// The single sql`` template that touches garden_node. Isolated so an assertion about this query
// cannot be satisfied by an identifier belonging to some other statement in the file.
const GARDEN_NODE_SQL = (SRC.match(/sql`[^`]*garden_node[^`]*`/) ?? [''])[0];

// L-081 KEYED contract (Phase 1, keyed form added 2026-08-28). Verified present on
// public.garden_node in prod 2026-08-28 via information_schema.
//
// The keyed form is what makes this file visible to scripts/dev-main-schema-audit.py at all.
// The older `AUDIT_TABLES` form cross-products every collected *COLUMNS array against every
// declared table, which forced one-table-per-file and left every JOINed relation audited by
// nothing — the exact hole this file was written to plug, and which it could not plug while
// the auditor could not see it. Keyed pairs bind columns to ONE relation, so a sibling
// contract for inventory_items can live in select-columns.test.js without either file
// asserting its columns onto the other's table.
const AUDIT_COLUMNS = {
  garden_node: [
    'id',
    'display_name',
    'sown_at',
    'seeds_sown',
    'seeds_germinated',
    'source_inventory_item_id',
    'deleted_at',
  ],
};

// Single source of truth: the assertions below read the same literal the auditor parses, so a
// column can never be audited against prod while the local tests check a different list.
const GARDEN_NODE_COLUMNS = AUDIT_COLUMNS.garden_node;

// Columns that exist on OTHER tables in this handler and would be a plausible mistake here.
// `name` is the one that actually happened; the rest share the same rename history.
const NOT_ON_GARDEN_NODE = ['name', 'variety_id', 'quantity_on_hand', 'category'];

describe('BUG-SEEDDETAIL500-001 — garden_node column contract', () => {
  it('isolates the garden_node query, so the assertions below are not vacuous', () => {
    expect(GARDEN_NODE_SQL).toMatch(/FROM public\.garden_node/);
    expect(GARDEN_NODE_SQL).toMatch(/source_inventory_item_id/);
  });

  it('selects display_name (aliased to name), never a bare p.name', () => {
    expect(GARDEN_NODE_SQL).toMatch(/p\.display_name\s+AS\s+name/i);
    // The regression itself. `p.name` does not exist on this table and 500s the whole endpoint.
    expect(GARDEN_NODE_SQL).not.toMatch(/\bp\.name\b/);
  });

  it('references no column that is absent from garden_node', () => {
    // Every p.<ident> in the query must be a real column. This is the assertion that would have
    // caught the original defect without anyone knowing to look for `name` specifically.
    const referenced = [...GARDEN_NODE_SQL.matchAll(/\bp\.([a-z_][a-z0-9_]*)\b/gi)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    const unknown = [...new Set(referenced)].filter((c) => !GARDEN_NODE_COLUMNS.includes(c));
    expect(unknown).toEqual([]);
  });

  it('does not reach for columns that belong to the inventory_items side', () => {
    for (const c of NOT_ON_GARDEN_NODE) {
      expect(GARDEN_NODE_SQL).not.toMatch(new RegExp(`\\bp\\.${c}\\b`));
    }
  });

  it('keeps the wire contract InventoryDetail renders', () => {
    // The alias is load-bearing: src/pages/InventoryDetail.jsx:306 renders {s.name} for each sowing.
    // Dropping the alias would fix the 500 and silently blank the sowing labels instead.
    const page = readFileSync(resolve(__dirname, '../../src/pages/InventoryDetail.jsx'), 'utf8');
    expect(page).toMatch(/sowings\.map/);
    expect(page).toMatch(/\{s\.name\}/);
  });
});
