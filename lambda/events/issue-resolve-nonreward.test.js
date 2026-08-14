// BUG-ISSUERESOLVECOUNT-001 — the issue_resolve_count evaluator must respect the
// NON_REWARD_EVENT_TYPES partition.
//
// THE ITEM WAS ALREADY FIXED when this guard was written (present at dev e2a8a867, one line, in
// lambda/events/index.js). What was NOT present was anything that would notice it going away. The
// resolved_set CTE is the LAST reward path that reads flagged-and-resolved rows, its contract is
// the partition's ("ZERO xp, ZERO streak credit, ZERO total_events"), and it grants xp through the
// xp_grants CTE downstream — so a silent regression here pays out real rewards for a moisture_check.
// Its sibling grant paths are all guarded (critter-nonreward.test.js sweeps the whole partition at
// the critter award); this one had no guard at all, which is the gap this file closes.
//
// LATENT EITHER WAY: EventNew sets flagged_as_issue only for flag_issue, and prod carries zero
// non-reward flagged rows (measured 2026-08-14), so neither the defect nor the fix moves an
// existing count. The exposure is the direct-API path and the next event type to ship.
//
// Static-source: lambda/events/index.js imports @neondatabase/@clerk/@aws-sdk at module load and is
// not importable from repo root — the house convention for this directory.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NON_REWARD_EVENT_TYPES } from './eventTypes.generated.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A predicate NAMED IN A COMMENT is not that predicate, and this one is named at length in the
// rationale block sitting inside the very CTE being asserted.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

const iSet = SRC.indexOf('WITH resolved_set AS (');
const iStats = SRC.indexOf('resolved_stats AS (', iSet);
const RESOLVED_SET = iSet < 0 || iStats < 0 ? null : SRC.slice(iSet, iStats);

describe('BUG-ISSUERESOLVECOUNT-001 — issue_resolve_count excludes non-reward event types', () => {
  it('the resolved_set CTE is findable and bounded (a broken slice makes this file vacuous)', () => {
    expect(RESOLVED_SET, 'resolved_set CTE not found').toBeTruthy();
    expect(RESOLVED_SET).toMatch(/FROM event_log el/);
    expect(RESOLVED_SET).toMatch(/el\.flagged_as_issue = true/);
    expect(RESOLVED_SET).toMatch(/el\.resolved_at IS NOT NULL/);
  });

  // MUTATION: delete the predicate -> RED. That is the state the ledger row describes: any flagged
  // and resolved row counted, whatever its event_type.
  it('filters the partition inside the counting CTE, not downstream of it', () => {
    expect(RESOLVED_SET,
      'the resolved_set CTE counts flagged+resolved rows of ANY event_type, so a flagged ' +
      'moisture_check earns caretaker achievements and grants xp — a direct violation of the ' +
      'NON_REWARD_EVENT_TYPES contract')
      .toMatch(/AND NOT \(el\.event_type = ANY\(\$\{NON_REWARD_EVENT_TYPES\}::text\[\]\)\)/);
  });

  // The ::text[] cast is not cosmetic. Neon cannot infer the type of a bound array parameter here,
  // and the failure mode is `could not determine data type of parameter` at runtime — a 500 on the
  // resolve path, invisible to every static check.
  it('keeps the explicit ::text[] cast on the bound array', () => {
    expect(RESOLVED_SET).toMatch(/NON_REWARD_EVENT_TYPES\}::text\[\]/);
  });

  it('did not trade away the scoping predicates it sits among', () => {
    expect(RESOLVED_SET).toMatch(/pp\.created_by = \$\{userId\}/);
    expect(RESOLVED_SET).toMatch(/el\.deleted_at IS NULL/);
    expect(RESOLVED_SET).toMatch(/pp\.deleted_at IS NULL/);
  });

  // The partition is codegen output. An empty array would make the predicate a tautology and this
  // whole file green-but-not-covering, exactly the vacuity failure sql-comment-hygiene warns about.
  it('the partition it filters on is non-empty and generated', () => {
    expect(NON_REWARD_EVENT_TYPES.length).toBeGreaterThan(0);
    expect(NON_REWARD_EVENT_TYPES).toContain('moisture_check');
  });

  it('the evaluator it guards is the only one in the file', () => {
    const evaluators = SRC.match(/a\.trigger_type = 'issue_resolve_count'/g) ?? [];
    expect(evaluators.length, 'a second copy would need its own filter').toBe(1);
  });
});
