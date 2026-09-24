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

// EVERY sql`` template that touches garden_node — `matchAll`, not the non-global `.match` this
// file shipped with. That returned only the FIRST such template, which was fine while there was
// exactly one and silently wrong the moment there were two: V4-SEEDLINK-001's ownership gate sits
// ABOVE the germination summary in index.js, so under the old form it would have BECOME
// GARDEN_NODE_SQL and broken the isolation assertion, while a second query added BELOW would have
// escaped the contract entirely. Neither is what this file intends — it intends "no column this
// handler reads off garden_node is absent from garden_node", which is a claim about all of them.
const GARDEN_NODE_SQLS = [...SRC.matchAll(/sql`[^`]*garden_node[^`]*`/g)].map((m) => m[0]);

// The germination summary — the query BUG-SEEDDETAIL500-001 actually occurred in. Isolated by the
// predicate only it carries, so the display_name assertions below cannot be satisfied by the
// ownership gate's SQL (which selects no name at all) nor drift onto it if the order changes.
// V5-SEEDSTAB-001 slice 3: it was isolated by `source_inventory_item_id`, which sown_from now shares —
// and sown_from sits beside it in one Promise.all, so "the first one that mentions it" stopped naming
// one query. `seeds_sown IS NOT NULL` is the germination read's alone.
const GERMINATION_SQL = GARDEN_NODE_SQLS.find((s) => /seeds_sown\s+IS\s+NOT\s+NULL/.test(s)) ?? '';
// V5-SEEDSTAB-001 slice 3 — sown_from, the plantings sown from the packet: the one garden_node read
// that joins the container and tests archived_at (sown-from.test.js holds its WHERE to the plants
// Lambda's). Isolated by that archive clause.
const SOWN_FROM_SQL = GARDEN_NODE_SQLS.find((s) => /\bp\.archived_at\s+IS\s+NULL/.test(s)) ?? '';

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
    // V4-SEEDLINK-001 — the /source-plant ownership gate's predicate column. Verified present on
    // public.garden_node in prod 2026-09-02 via information_schema, like every entry above it.
    'created_by',
    // V5-SEEDSTAB-001 slice 3 — sown_from: the planting's status for its link, its container for the
    // ownership arms, and archived_at for the Archive-Hiding Rule. Verified present on
    // public.garden_node in prod AND staging 2026-09-23 via information_schema.
    'status',
    'container_id',
    'archived_at',
  ],
  // V5-SEEDSTAB-001 slice 3 — the first container read in this directory: sown_from LEFT JOINs it for
  // the plants Lambda's ownership arm, container-deleted gate and archived-container clause. Declared
  // here so the joined relation is audited (Phase 4 census). Verified present on public.container in
  // prod AND staging 2026-09-23 via information_schema.
  container: [
    'id',
    'created_by',
    'deleted_at',
    'archived_at',
  ],
};

// Single source of truth: the assertions below read the same literal the auditor parses, so a
// column can never be audited against prod while the local tests check a different list.
const GARDEN_NODE_COLUMNS = AUDIT_COLUMNS.garden_node;

// Columns that exist on OTHER tables in this handler and would be a plausible mistake here.
// `name` is the one that actually happened; the rest share the same rename history.
const NOT_ON_GARDEN_NODE = ['name', 'variety_id', 'quantity_on_hand', 'category'];

describe('BUG-SEEDDETAIL500-001 — garden_node column contract', () => {
  it('isolates the garden_node queries, so the assertions below are not vacuous', () => {
    // Two of them since V4-SEEDLINK-001: the germination summary and the /source-plant ownership
    // gate. A floor rather than an equality — a third garden_node query should be covered by the
    // sweeps below on the day it lands, not fail this file until someone bumps a number.
    expect(GARDEN_NODE_SQLS.length).toBeGreaterThanOrEqual(2);
    for (const q of GARDEN_NODE_SQLS) expect(q).toMatch(/FROM public\.garden_node/);
    expect(GERMINATION_SQL, 'the germination summary must still be findable').toBeTruthy();
  });

  it('selects display_name (aliased to name), never a bare p.name', () => {
    expect(GERMINATION_SQL).toMatch(/p\.display_name\s+AS\s+name/i);
    // The regression itself. `p.name` does not exist on this table and 500s the whole endpoint.
    // Asserted over EVERY garden_node query, not just the one it happened in: the column is absent
    // from the table, so reaching for it anywhere is the same 500.
    for (const q of GARDEN_NODE_SQLS) expect(q).not.toMatch(/\bp\.name\b/);
  });

  it('references no column that is absent from garden_node', () => {
    // Every p.<ident> in every garden_node query must be a real column. This is the assertion that
    // would have caught the original defect without anyone knowing to look for `name` specifically.
    const referenced = GARDEN_NODE_SQLS.flatMap(
      (q) => [...q.matchAll(/\bp\.([a-z_][a-z0-9_]*)\b/gi)].map((m) => m[1]),
    );
    expect(referenced.length).toBeGreaterThan(0);
    const unknown = [...new Set(referenced)].filter((c) => !GARDEN_NODE_COLUMNS.includes(c));
    expect(unknown).toEqual([]);
  });

  it('does not reach for columns that belong to the inventory_items side', () => {
    for (const q of GARDEN_NODE_SQLS) {
      for (const c of NOT_ON_GARDEN_NODE) {
        expect(q).not.toMatch(new RegExp(`\\bp\\.${c}\\b`));
      }
    }
  });

  it('keeps the wire contract InventoryDetail renders', () => {
    // The alias is load-bearing: src/pages/InventoryDetail.jsx:306 renders {s.name} for each sowing.
    // Dropping the alias would fix the 500 and silently blank the sowing labels instead.
    const page = readFileSync(resolve(__dirname, '../../src/pages/InventoryDetail.jsx'), 'utf8');
    expect(page).toMatch(/sowings\.map/);
    expect(page).toMatch(/\{s\.name\}/);
  });

  // ── V5-SEEDSTAB-001 slice 3 — sown_from, the second garden_node read on the detail GET ───────────
  it('isolates sown_from as its own statement, distinct from the germination summary', () => {
    expect(SOWN_FROM_SQL, 'the sown_from read must still be findable').toBeTruthy();
    expect(SOWN_FROM_SQL).not.toBe(GERMINATION_SQL);
    expect(GERMINATION_SQL).not.toMatch(/archived_at/);
    expect(SOWN_FROM_SQL).not.toMatch(/seeds_sown/);
  });

  it('sown_from selects display_name as name (the same alias, the same 500 if it slips) and a link\'s four fields', () => {
    expect(SOWN_FROM_SQL).toMatch(/SELECT\s+p\.id,\s*p\.display_name\s+AS\s+name,\s*p\.sown_at,\s*p\.status\s+FROM\s+public\.garden_node\s+p\b/i);
    const page = readFileSync(resolve(__dirname, '../../src/pages/InventoryDetail.jsx'), 'utf8');
    // The page renders exactly those: the link target, the name, the date and the status words.
    expect(page).toMatch(/sown_from\.map/);
    expect(page).toMatch(/\/plantings\/\$\{p\.id\}/);
    expect(page).toMatch(/\{p\.name\}/);
    expect(page).toMatch(/p\.sown_at/);
    expect(page).toMatch(/statusLabel\(p\.status\)/);
  });

  it('every container column a garden_node read reaches for (pp.<col>) is a real container column', () => {
    // The garden_node sweep above cannot see these: `\bp\.` never matches inside `pp.`. The contract is
    // what Phase 1 audits against prod, so a pp.<col> missing from it is a column nothing checks.
    const referenced = [...new Set(GARDEN_NODE_SQLS.flatMap(
      (q) => [...q.matchAll(/\bpp\.([a-z_][a-z0-9_]*)\b/gi)].map((m) => m[1]),
    ))].sort();
    expect(referenced).toEqual([...AUDIT_COLUMNS.container].sort());
    // Joined as the plants Lambda joins it, so pp is the planting's own container and nothing else.
    expect(SOWN_FROM_SQL).toMatch(/LEFT\s+JOIN\s+public\.container\s+pp\s+ON\s+pp\.id\s*=\s*p\.container_id/);
  });

  it('declares its contract in the one shape scripts/dev-main-schema-audit.py can read', () => {
    // The auditor's own regexes (_AUDIT_COLUMNS_DECL, _AUDIT_COLUMNS_PAIR, the quoted-identifier
    // collector), run over this file: what it will audit against prod must be exactly the literal the
    // assertions above use. The terminating `};` is mandatory — without it the auditor skips the block.
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const decl = self.match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
    expect(decl, 'AUDIT_COLUMNS literal not found by the auditor pattern').toBeTruthy();
    // The match must stop at the block's OWN `};`, not run on to the next one in the file.
    expect(decl[1]).not.toMatch(/\bconst\b/);
    const pairs = [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)];
    expect(pairs.map((m) => m[1]).sort()).toEqual(Object.keys(AUDIT_COLUMNS).sort());
    for (const [, table, body] of pairs) {
      const cols = [...body.matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1]);
      expect(cols, table).toEqual(AUDIT_COLUMNS[table]);
    }
  });
});
