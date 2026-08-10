// V4-HARVESTSURF-001 — structural guard on the harvest-ready SQL. Same posture as
// harvest-summary.test.js: live data cannot exercise these (no deleted harvests, no archived
// plantings with recent picks today), so a dropped predicate would pass every behavioural test while
// silently nagging about a planting that is gone, archived, or someone else's.
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

const start = src.indexOf("rawPath === '/api/events/harvest-ready'");
const end = src.indexOf('Route 2/3 (F10 precedence)', start);
const block = src.slice(start, end === -1 ? undefined : end);
const templates = [...block.matchAll(/(?<![\w`])sql`([^`]*)`/g)].map(m => m[1]);
const candidates = templates.find(t => /FROM last_pick/i.test(t));

describe('harvest-ready SQL shape', () => {
  it('found the candidate query', () => {
    expect(start).toBeGreaterThan(-1);
    expect(candidates).toBeTruthy();
  });

  it('is matched BEFORE the /api/events/:id regex (literal sub-route precedence)', () => {
    const idRoute = src.indexOf("rawPath.match(/^\\/api\\/events\\/([^/]+)$/)");
    expect(idRoute).toBeGreaterThan(-1);
    expect(start).toBeLessThan(idRoute);
  });

  it('dates from event_log.event_date in the reporting zone, NEVER harvest_log.created_at', () => {
    expect(candidates).toMatch(/e\.event_date AT TIME ZONE \$\{HARVEST_TZ\}/);
    expect(candidates).not.toMatch(/h\.created_at/);
  });

  it('requires evidence: a dated harvest/first_harvest event', () => {
    expect(candidates).toMatch(/JOIN harvest_log h ON h\.event_id = e\.id/);
    expect(candidates).toMatch(/e\.event_type IN \('harvest', 'first_harvest'\)/);
  });

  // The evidence rule is "a DATED pick", not "a logged quantity". first_harvest is a milestone that
  // never has a harvest_log row (validators.js 400s on harvest fields for it), so the original INNER
  // JOIN silently made any planting whose only pick was a first_harvest invisible here forever.
  // These two assertions pin BOTH halves of the replacement, because each half alone is a bug:
  // an INNER JOIN re-opens the hole, and a bare LEFT JOIN with no predicate would admit a `harvest`
  // event whose harvest_log row was soft-deleted (i.e. a retracted pick counting as evidence).
  it('admits first_harvest as evidence via a LEFT JOIN, not an INNER JOIN', () => {
    expect(candidates).toMatch(/LEFT JOIN harvest_log h ON h\.event_id = e\.id/);
    expect(candidates).not.toMatch(/(?<!LEFT )JOIN harvest_log h ON h\.event_id = e\.id/);
  });

  it('still rejects a harvest event whose harvest_log row was soft-deleted', () => {
    // Without this predicate the LEFT JOIN would let a retracted quantity count as a pick.
    expect(candidates).toMatch(/h\.id IS NOT NULL OR e\.event_type = 'first_harvest'/);
  });

  it('filters soft-deletes at every hop', () => {
    for (const pred of [/h\.deleted_at IS NULL/, /e\.deleted_at IS NULL/, /p\.deleted_at IS NULL/,
      /c\.deleted_at IS NULL/, /pv\.deleted_at IS NULL/, /ct\.deleted_at IS NULL/]) {
      expect(candidates).toMatch(pred);
    }
  });

  it('excludes archived and dead plantings (ambient nudge, unlike the pinned detail page)', () => {
    expect(candidates).toMatch(/p\.archived_at IS NULL/);
    expect(candidates).toMatch(/c\.archived_at IS NULL/);
    expect(candidates).toMatch(/p\.status NOT IN \('failed', 'ended', 'dormant'\)/);
  });

  // A wild wineberry that went dormant on 2026-07-31 kept ranking #1 of 18 at 10.5x overdue,
  // because `dormant` is not 'failed' and not 'ended'. statusTransitions.js already classifies
  // dormant as a terminal/past state and dashboard/handlers.js excludes it in 7 places — this
  // route was the lone outlier. Regression guard on the specific status, not just the list shape.
  it('excludes DORMANT plantings (finished-for-the-season no longer nags)', () => {
    expect(candidates).toMatch(/'dormant'/);
  });

  // Staleness backstop for the whole leak class: whatever status leaks through next (or a plain
  // abandonment with no status change at all), nothing can sit at the top of the list many
  // multiples overdue. Ceiling is empirical — see the constant's comment for the distribution.
  it('applies the staleness ceiling as a multiple of the crop repeat interval', () => {
    expect(candidates).toMatch(/\$\{HARVEST_STALE_INTERVAL_CEILING\} \* ct\.repeat_interval_days/);
  });

  // The server ceiling is defence-in-depth behind src/lib/harvestReadiness.js's MAX_OVERDUE_RATIO,
  // which is authoritative. They live in different deploy units (Lambda vs bundle) so the value
  // cannot be imported and MUST be duplicated — this is the guard that stops the duplicate from
  // drifting. Divergence is not merely untidy: the looser of the two becomes silent dead config.
  it('server ceiling equals the client MAX_OVERDUE_RATIO (single effective value)', () => {
    const serverCeiling = Number(
      /const HARVEST_STALE_INTERVAL_CEILING = (\d+(?:\.\d+)?)/.exec(src)?.[1]
    );
    const clientSrc = decomment(readFileSync(
      join(here, '..', '..', 'src', 'lib', 'harvestReadiness.js'), 'utf-8'
    ));
    const clientCeiling = Number(
      /MAX_OVERDUE_RATIO\s*=\s*(\d+(?:\.\d+)?)/.exec(clientSrc)?.[1]
    );
    expect(Number.isFinite(serverCeiling)).toBe(true);
    expect(Number.isFinite(clientCeiling)).toBe(true);
    expect(serverCeiling).toBe(clientCeiling);
  });

  // The ceiling must NARROW only. Rows the pure client predicate owns rejecting (NULL/non-positive
  // interval) must still arrive, or the server has quietly taken over eligibility.
  it('staleness ceiling is NULL-safe and no-ops on non-positive intervals', () => {
    expect(candidates).toMatch(/ct\.repeat_interval_days IS NULL/);
    expect(candidates).toMatch(/ct\.repeat_interval_days <= 0/);
  });

  it('scopes to the household via container.created_by', () => {
    expect(candidates).toMatch(/c\.created_by = ANY\(\$\{householdIds\}\)/);
  });

  it('returns candidates only — the eligibility predicate is NOT duplicated in SQL', () => {
    // Single source of truth: src/lib/harvestReadiness.js decides. If these ever appear here the
    // predicate has two homes and they will drift.
    // NOTE the staleness ceiling above is deliberately NOT a violation of this: it is a fourth,
    // server-only concern (is this rhythm still live?) with no counterpart in isReadyToPick, so it
    // narrows the candidate set without duplicating — and therefore without being able to drift
    // from — any of the three eligibility legs asserted below.
    expect(candidates).not.toMatch(/harvest_habit\s+IN/i);
    expect(candidates).not.toMatch(/repeat_interval_days\s+IS NOT NULL/i);
    expect(candidates).not.toMatch(/harvest_season_start_doy\s*(<=|>=|BETWEEN)/i);
  });

  it('ships the reporting-zone day-of-year so the client never does tz math', () => {
    expect(block).toMatch(/EXTRACT\(DOY FROM \(NOW\(\) AT TIME ZONE \$\{HARVEST_TZ\}\)::date\)/);
    expect(block).toMatch(/et_doy:/);
  });
});
