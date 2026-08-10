// V4-COMPOSEPOST-002 — static SELECT-column contract for the harvests read model.
//
// WHY THIS FILE EXISTS: the `L-081 Schema Audit (dev)` CI job passed green on commit 89df744f and
// evaluated NONE of that commit's changed lines. `scripts/dev-main-schema-audit.py` Phase 1 reads only
// `lambda/**/select-columns.test.js`, and exactly three existed (plants, projects, varieties) — none
// for harvests. Its own docstring is explicit: "Column refs buried in SELECT/WHERE/SET/
// jsonb_build_object/RETURNING are NOT audited here." The entire lambda delta of that commit was two
// columns added to a SELECT, so the audit ran, passed, and was structurally blind to it — and the
// green check was then cited in the project-state ledger as evidence the change was covered.
//
// A vacuous gate is worse than an absent one, because it gets cited. This file enrols
// lambda/harvests in Phase 1 so the audit has something to check, and pins the columns the compose
// surface depends on.
//
// Static source inspection for the same reason as the sibling files: lambda/harvests/index.js imports
// @neondatabase/serverless + @clerk/backend at module load, so it cannot be imported under `npm ci`
// in CI without the handler's runtime deps.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct — same decomment guard as the sibling files,
// so deleting live code and leaving `// was: e.created_at` behind cannot satisfy an assertion.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
const PROJECTOR = decomment(readFileSync(resolve(__dirname, 'aggregate.js'), 'utf8'));

// L-081 schema-audit declared contract (scripts/dev-main-schema-audit.py Phase 1): the prod relation
// every `*_COLUMNS` array in this file must exist in. ONE table, deliberately — the auditor
// cross-products every collected array against every declared table, so listing two relations here
// would demand that `unit` exist on event_log and `event_type` on harvest_log. The harvest_log
// assertions below are therefore named *_FIELDS, which the collector's `_COLUMNS` pattern ignores;
// they stay live as vitest assertions without entering the audit contract.
const AUDIT_TABLES = ['event_log'];

// Columns the ENTRIES read model selects from event_log. created_at/created_by are the compose
// surface's whole basis: event_date is date-grained (482 of 504 live rows sit at exactly 08:00 ET, a
// DST-safe date-at-noon encoding) so it cannot order two picks within a day, and created_by is what
// keeps one household member's batch out of another member's composer.
const EVENT_LOG_COLUMNS = [
  'id', 'event_type', 'event_date', 'created_at', 'created_by', 'plant_id', 'notes', 'project_id',
];

const HARVEST_LOG_FIELDS = [
  'id', 'quantity', 'unit', 'quality_rating', 'weight_grams', 'weight_estimated', 'weight_basis',
];

describe('harvests read model — SELECT column contract (L-081 Phase 1)', () => {
  it('declares exactly one prod relation, as the auditor requires', () => {
    expect(AUDIT_TABLES).toEqual(['event_log']);
  });

  it('selects every event_log column the read model and the compose surface depend on', () => {
    for (const col of EVENT_LOG_COLUMNS) {
      expect(SRC, `event_log.${col} missing from the entries SELECT`).toMatch(new RegExp(`\\be\\.${col}\\b`));
    }
  });

  it('selects every harvest_log column the read model exposes', () => {
    for (const col of HARVEST_LOG_FIELDS) {
      expect(SRC, `harvest_log.${col} missing from the entries SELECT`).toMatch(new RegExp(`\\bh\\.${col}\\b`));
    }
  });

  // BUG-COMPOSETOTALS-001 guard. created_since must narrow ENTRIES ONLY. If it ever leaks into the
  // aggregates or weight query, the season totals silently become a 24-hour window and the compose
  // surface publishes a per-crop figure a small fraction of the truth — which is the defect this
  // parameter was introduced to fix.
  it('applies created_since to the entries query and to nothing else', () => {
    // The predicate names the param twice by construction (null-guard, then comparison), so count
    // the CLAUSE, not the references — there must be exactly one, in the entries WHERE.
    const clause = /AND \(\$\{createdSince\}::timestamptz IS NULL OR e\.created_at >= \$\{createdSince\}::timestamptz\)/g;
    const hits = SRC.match(clause) ?? [];
    expect(hits, 'the created_since predicate must appear exactly once — in the entries query').toHaveLength(1);
    // Two references, both inside that one clause: anything more means it leaked to another query.
    expect((SRC.match(/\$\{createdSince\}/g) ?? []).length).toBe(2);
  });

  // The wire shape is listed in TWO places on purpose (the SELECT and the explicit field list in
  // projectEntry), and BUG-HARVWEIGHTWIRE-001 happened because one was updated and the other was not.
  it('projects created_at and created_by onto the wire', () => {
    expect(PROJECTOR).toMatch(/created_at:/);
    expect(PROJECTOR).toMatch(/created_by:/);
  });

  it('coerces the numeric weight column rather than shipping the driver’s string', () => {
    expect(PROJECTOR).toMatch(/weight_grams:.*Number\(/);
  });
});
