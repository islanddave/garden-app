// V4-HARVESTQTY-001 — structural guard on the harvest-summary SQL.
// Live data cannot exercise these: all 112 harvest_log rows are currently un-deleted, so a
// missing soft-delete predicate would pass every behavioural test AND every manual check while
// silently inflating totals the day someone deletes a harvest. These assertions make the filters
// right BY CONSTRUCTION rather than by observation. Same posture as sql-comment-hygiene.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const src = decomment(readFileSync(join(here, 'index.js'), 'utf-8'));

// The two sql`...` templates inside the harvest-summary route.
function harvestSummarySql() {
  const start = src.indexOf("rawPath === '/api/events/harvest-summary'");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('/api/events/batch/', start);
  const block = src.slice(start, end === -1 ? undefined : end);
  const out = [];
  const re = /(?<![\w`])sql`([^`]*)`/g;
  let m;
  while ((m = re.exec(block)) !== null) out.push(m[1]);
  return { block, templates: out.filter(t => /\bSELECT\b/i.test(t)) };
}

describe('harvest-summary SQL shape', () => {
  const { block, templates } = harvestSummarySql();
  const attributed = templates.find(t => /FROM harvest_log/i.test(t) && /JOIN plants/i.test(t));
  const unattributed = templates.find(t => /FROM harvest_log/i.test(t) && /plant_id IS NULL/i.test(t));

  it('has both the attributed and the unattributed query', () => {
    expect(attributed).toBeTruthy();
    expect(unattributed).toBeTruthy();
  });

  it('dates from event_log.event_date, NEVER harvest_log.created_at', () => {
    // harvest_log has no harvest-date column and 30% of live rows are backdated, so
    // harvest_log.created_at misdates roughly one row in three.
    for (const t of [attributed, unattributed]) {
      expect(t).toMatch(/e\.event_date/);
      expect(t).not.toMatch(/h\.created_at/);
    }
  });

  it('attributes via harvest_log.event_id -> event_log.id, filtered on event_log.plant_id', () => {
    expect(attributed).toMatch(/JOIN\s+event_log\s+e\s+ON\s+e\.id\s*=\s*h\.event_id/i);
    expect(attributed).toMatch(/e\.plant_id\s*=\s*\$\{plantId\}/);
  });

  it('filters soft-deletes at every hop present in the chain', () => {
    expect(attributed).toMatch(/h\.deleted_at IS NULL/);
    expect(attributed).toMatch(/e\.deleted_at IS NULL/);
    expect(attributed).toMatch(/p\.deleted_at IS NULL/);
    // The unattributed query has no plants hop by definition (plant_id IS NULL); its plants
    // subselect resolves the project and must still exclude a deleted planting.
    expect(unattributed).toMatch(/h\.deleted_at IS NULL/);
    expect(unattributed).toMatch(/e\.deleted_at IS NULL/);
    expect(unattributed).toMatch(/FROM plants WHERE id = \$\{plantId\}::uuid AND deleted_at IS NULL/);
  });

  it('scopes to the household via container.created_by', () => {
    for (const t of [attributed, unattributed]) {
      expect(t).toMatch(/c\.created_by = ANY\(\$\{householdIds\}\)/);
    }
  });

  it('projects event_date into the reporting zone server-side', () => {
    for (const t of [attributed, unattributed]) {
      expect(t).toMatch(/e\.event_date AT TIME ZONE \$\{HARVEST_TZ\}/);
    }
  });

  it('documents WHY archived_at is deliberately not filtered on the pinned planting', () => {
    // An archived planting is still reachable at GET /api/plants/:id (which filters only
    // deleted_at) and renders an Unarchive affordance — filtering archived_at here would blank
    // the harvest summary on exactly that page. If this rationale is ever deleted, the omission
    // stops being a decision and becomes a bug.
    expect(block).toMatch(/archived_at/);
    expect(attributed).not.toMatch(/p\.archived_at IS NULL/);
  });

  it('rejects a missing or non-uuid plant_id before touching the DB', () => {
    expect(block).toMatch(/UUID_RE\.test\(plantId\)/);
  });
});
