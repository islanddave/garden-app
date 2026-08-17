// anchor-supersede.test.js — V4-ANCHORSUPERSEDE-001, the nightly half of the supersede maintainer.
//
// WHAT WENT WRONG. public.plant_anchor_derivation holds an INVENTED anchor for a planting that had
// no sown_at / transplanted_at / planted_out_at. The retiring UPDATE lived only in the second
// transaction of migrations/v4-anchorbase-001/0b-backfill.sql — whose own header calls it "run on
// every subsequent execution" — and nothing ever ran it again after the one-shot backfill of
// 2026-08-12. So a planting could hold BOTH a real date and a live derivation, and
// lambda/harvests/watch-route.js would keep citing a guess the data had already contradicted.
//
// These tests EXECUTE run() against a recording pg stub rather than grepping the source, for the
// same reason weatherdaily.test.js does: the claims worth proving here are about REACHABILITY (does
// a live run actually issue the statement, does a dry run actually not) and about SURVIVAL (does a
// failing sweep leave the nightly plan intact). Source text can show a call site inside an `if`; it
// cannot show what the deploy evaluates.
//
// The row-level semantics of the predicate — retires a contradicted derivation, leaves an
// uncontradicted one alone, no-ops on a second run, never deletes — are asserted here as properties
// of the statement the driver actually received. They are proven against real rows by
// migrations/v4-anchorbase-001/gates.yml's post_no_derived_beside_observed, re-armed continuous in
// the same change and swept against live prod AND staging.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import handler from './handler.js';

const { run, sweepSupersededAnchors } = handler;

const SPACE = 'sp-1';
const TODAY = '2026-08-15';

const PLANTINGS = [{
  id: 'p1', name: 'Pepper p1', project_id: 'pj1', status: 'fruiting', container_type: 'pot',
  container_size: '5gal', rain_exposed: null, variety: 'pepper', genus: null, project: 'Garden',
  project_status: 'active', workspace_id: SPACE, crop_type_slug: 'pepper', covered: false,
  frost_covered_resolved: false, assignee_user_id: 'user_1', db_cadence: null,
  last_water: '2026-08-01', last_fert: '2026-08-01', substrate_start: '2026-05-01', transplant_at: null,
}];

// Records every statement handed to the driver. `rowCount` is supplied the way node-postgres
// supplies it, so the sweep's return value is read from a real result shape rather than a stub that
// happens to be truthy.
function recordingPg({ throwOnSweep = false, sweepRowCount = 3 } = {}) {
  const calls = [];
  const pg = {
    query: vi.fn(async (sql) => {
      calls.push({ sql });
      if (/plant_anchor_derivation/.test(sql)) {
        if (throwOnSweep) throw new Error('relation "plant_anchor_derivation" does not exist');
        return { rows: [], rowCount: sweepRowCount };
      }
      if (/from plants p/.test(sql)) return { rows: PLANTINGS };
      if (/from spaces/.test(sql)) {
        return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
      }
      return { rows: [] };
    }),
    calls,
  };
  return pg;
}

// Scoped to the OBSERVED-ANCHOR retire specifically, not to every statement naming the relation.
// V4-ANCHORRESWEEP-001 added a second sweep to the same run (retire + insert, both against this
// table), so a bare /plant_anchor_derivation/ filter now counts three statements and would make
// "sweeps exactly once" fail for a reason that has nothing to do with this file's subject. The
// re-derivation sweep has its own reachability and survival tests in anchor-rederive.test.js.
const sweeps = (pg) => pg.calls.filter((c) => /superseded_by = 'observed_anchor'/.test(c.sql));

async function drive(opts = {}) {
  const pg = opts.pg || recordingPg(opts.pgOpts);
  const res = await run({
    pg, today: opts.today || TODAY, dryRun: opts.dryRun ?? false,
    geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow: 60, highToday: 82, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: async () => null,
    fetchStation: async () => null,
    publishAlert: vi.fn(async () => ({ messageId: 'm1' })),
    etHour: 2, event: {},
  });
  return { res, pg };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('sweepSupersededAnchors — the statement that reaches the database', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });

  it('retires a derivation ONLY for a planting that now holds an observed anchor', async () => {
    const pg = recordingPg();
    await sweepSupersededAnchors(pg);
    const [{ sql }] = sweeps(pg);
    // The whole invariant in one predicate: joined to the planting, and gated on that planting
    // having at least one of the three OBSERVED columns. All three, because any one of them
    // contradicts the guess — anchorDerive.observedAnchorOf treats them as one set.
    expect(sql).toMatch(/from public\.plants p/);
    expect(sql).toMatch(/p\.id = d\.plant_id/);
    expect(sql).toMatch(/p\.sown_at is not null/);
    expect(sql).toMatch(/p\.transplanted_at is not null/);
    expect(sql).toMatch(/p\.planted_out_at is not null/);
  });

  it('leaves a derivation LIVE when its planting still has no real date', async () => {
    const pg = recordingPg();
    await sweepSupersededAnchors(pg);
    const [{ sql }] = sweeps(pg);
    // Conditionality is the property: the three column tests are ORed together and the whole group
    // is ANDed onto the row selection, so a planting with none of them matches nothing. An
    // unconditional retire — or an OR that leaked out to the top level — would retire every
    // derivation in the table on the first night, destroying the derived tier outright.
    const where = sql.slice(sql.indexOf('where'));
    expect(where).toMatch(/and \(p\.sown_at is not null or p\.transplanted_at is not null\s+or p\.planted_out_at is not null\)/);
    expect(where).not.toMatch(/or p\.id = d\.plant_id/);
  });

  it('is idempotent: the second run matches nothing the first already retired', async () => {
    const pg = recordingPg();
    await sweepSupersededAnchors(pg);
    await sweepSupersededAnchors(pg);
    const texts = sweeps(pg).map((c) => c.sql);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe(texts[1]);
    // `superseded_at is null` is what makes re-running a no-op AND what stops a later run from
    // rewriting an earlier retirement's timestamp — the retirement date is evidence about when the
    // guess was contradicted, so moving it would falsify the calibration record.
    for (const t of texts) expect(t).toMatch(/d\.superseded_at is null/);
  });

  it('RETIRES, never deletes — the (guess, later truth) pair is the only ground truth tier 3 gets', async () => {
    const pg = recordingPg();
    await sweepSupersededAnchors(pg);
    const [{ sql }] = sweeps(pg);
    expect(sql).toMatch(/^\s*update public\.plant_anchor_derivation/);
    expect(sql).not.toMatch(/delete/i);
    expect(sql).toMatch(/superseded_by = 'observed_anchor'/);
  });

  it('reports the rows it retired from the driver result, not from a guess', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const pg = recordingPg({ sweepRowCount: 7 });
    expect(await sweepSupersededAnchors(pg)).toBe(7);
    const logged = spy.mock.calls
      .map(([l]) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((m) => m && m.msg === 'anchor-supersede-sweep');
    expect(logged).toHaveLength(1);
    expect(logged[0].rows).toBe(7);
  });
});

describe('run() wiring', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });

  it('a LIVE run sweeps exactly once', async () => {
    const { pg } = await drive({ dryRun: false });
    expect(sweeps(pg)).toHaveLength(1);
  });

  it('a DRY run never writes — the replay wrapper depends on it', async () => {
    const { pg } = await drive({ dryRun: true });
    expect(sweeps(pg)).toHaveLength(0);
  });

  it('sweeps EARLY, so a later fetch hang cannot cost the invariant a night', async () => {
    const { pg } = await drive({ dryRun: false });
    const idx = pg.calls.findIndex((c) => /plant_anchor_derivation/.test(c.sql));
    const spaces = pg.calls.findIndex((c) => /from spaces/.test(c.sql));
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(spaces);
  });

  it('a failing sweep leaves the nightly plan completely unaffected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The named failure class is BUG-SEEDEDGATE-001 at table granularity: one bad statement blanked
    // the entire nightly plan for both users. An environment without 0a applied throws here on
    // every run, and Today must survive it.
    const { res, pg } = await drive({ dryRun: false, pgOpts: { throwOnSweep: true } });
    expect(res.rows).toBeGreaterThan(0);
    expect(sweeps(pg)).toHaveLength(1);
    const msgs = warn.mock.calls
      .map(([l]) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    expect(msgs.some((m) => m.msg === 'anchor-supersede sweep failed — plan unaffected')).toBe(true);
  });
});
