// anchor-rederive.test.js — V4-ANCHORRESWEEP-001, the nightly re-derivation sweep.
//
// WHAT WENT WRONG. lambda/plants/anchorCreate.js derives an anchor the moment a planting is created,
// and its own header records the two things that state can never become: at t=0 add_date IS today,
// so the future-clamp always binds and every create-path row lands 7 days early and frozen; and the
// tiers above the add-date floor are empty BY CONSTRUCTION (no event can exist against an id the
// INSERT just returned), so a sowing / seed_soak / potting_up logged later leaves a tier-3 guess live
// beside tier-1 or tier-2.5 evidence. Nothing revisited either.
//
// WHAT THESE TESTS CAN AND CANNOT PROVE, stated up front because the split is the whole design of
// this file. The sweep is two SQL statements; there is no in-process Postgres in this repo (no
// pg-mem, no pglite), so a unit test cannot execute the ladder. It therefore splits in two:
//
//   * EXECUTING tests drive the real run() against a recording pg stub. They prove REACHABILITY
//     (a live run issues both statements, a dry run issues neither, the ordering against the
//     observed-anchor sweep) and SURVIVAL (either statement failing leaves the nightly plan intact,
//     and a failed retire does not suppress the insert). Source text cannot show any of that.
//   * TEXT tests pin the statement the driver received. They are the drift guard, and the vocabulary
//     half of them is NOT a restatement — it IMPORTS the tiers, the offset, the model version and
//     the event-type sets from lambda/harvests/anchorDerive.js and asserts the SQL agrees, so that
//     module stays the canonical owner of the ladder even though a CJS Lambda zipped from its own
//     directory can never import it at runtime. Same contract anchor-create.test.js works under.
//
// The ROW-LEVEL semantics of the predicate were proven separately, read-only against live prod on
// 2026-08-16, by mechanically rewriting THIS statement's UPDATE head into a SELECT and evaluating it
// against real rows: no evidence -> 0 rows; a potting_up event injected 20d after create -> exactly
// that planting, add_date_baseline 2026-08-12 -> nursery_proxy_event 2026-07-27; evaluated at
// 2026-08-17 (the day the clamp releases) -> exactly the 2 clamped rows, 2026-08-12 -> 2026-08-17;
// every nursery-proxy event removed -> 0 rows, i.e. the downgrade refused. Recorded in
// _lane_reports/anchorresweep-20260816b.md.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import handler from './handler.js';
import {
  ANCHOR_DERIVE_MODEL_VERSION, ADD_DATE_OFFSET_DAYS, DERIVATION_TIERS, OBSERVED_ANCHOR_FIELDS,
  SOW_EVENT_TYPES, TRANSPLANT_EVENT_TYPES, NURSERY_PROXY_EVENT_TYPES,
} from '../harvests/anchorDerive.js';

const {
  run, sweepRederiveAnchors, REDERIVE_RETIRE_SQL, REDERIVE_INSERT_SQL, REDERIVE_REASON,
  ANCHOR_MODEL_VERSION, REDERIVE_LOG_MAX,
} = handler;

const RETIRE = REDERIVE_RETIRE_SQL;
const INSERT = REDERIVE_INSERT_SQL;
const BOTH = { retire: RETIRE, insert: INSERT };

const SPACE = 'sp-1';
const TODAY = '2026-08-15';

const PLANTINGS = [{
  id: 'p1', name: 'Pepper p1', project_id: 'pj1', status: 'fruiting', container_type: 'pot',
  container_size: '5gal', rain_exposed: null, variety: 'pepper', genus: null, project: 'Garden',
  project_status: 'active', workspace_id: SPACE, crop_type_slug: 'pepper', covered: false,
  frost_covered_resolved: false, assignee_user_id: 'user_1', db_cadence: null,
  last_water: '2026-08-01', last_fert: '2026-08-01', substrate_start: '2026-05-01', transplant_at: null,
}];

const isRetire = (sql) => /superseded_by = 'rederived'/.test(sql);
const isInsert = (sql) => /INSERT INTO public\.plant_anchor_derivation/.test(sql);
const isObservedSweep = (sql) => /superseded_by = 'observed_anchor'/.test(sql);

// Records every statement handed to the driver, and can fail either half of the re-derivation
// independently — the two guards are separate in the source, so the tests have to be able to trip
// them separately or the claim that a failed retire still lets the insert run is untested.
function recordingPg({ failRetire = false, failInsert = false, retireRows = [], insertRows = [] } = {}) {
  const calls = [];
  const pg = {
    query: vi.fn(async (sql) => {
      calls.push({ sql });
      if (isRetire(sql)) {
        if (failRetire) throw new Error('relation "public.plant_anchor_derivation" does not exist');
        return { rows: retireRows, rowCount: retireRows.length };
      }
      if (isInsert(sql)) {
        if (failInsert) throw new Error('duplicate key value violates unique constraint');
        return { rows: insertRows, rowCount: insertRows.length };
      }
      if (/plant_anchor_derivation/.test(sql)) return { rows: [], rowCount: 0 };
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

const retireRow = (over = {}) => ({
  plant_id: 'pl-1', was_source: 'add_date_baseline', was_anchor_date: '2026-08-10',
  now_source: 'add_date_baseline', now_anchor_date: '2026-08-17', now_plausibility: null, ...over,
});
const insertRow = (over = {}) => ({
  plant_id: 'pl-9', source: 'add_date_baseline', anchor_date: '2026-08-16',
  clamped_to_today: true, plausibility: null, ...over,
});

const logs = (spy, msg) => spy.mock.calls
  .map(([l]) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((m) => m && m.msg === msg);

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

// ── the ladder is anchorDerive.js's, not this file's ─────────────────────────────────────────────
describe('the derivation vocabulary is imported from anchorDerive.js, never restated', () => {
  it('uses that module\'s model version', () => {
    expect(ANCHOR_MODEL_VERSION).toBe(ANCHOR_DERIVE_MODEL_VERSION);
    expect(RETIRE).toContain(`'${ANCHOR_DERIVE_MODEL_VERSION}'::text AS model_version`);
  });

  it('uses that module\'s stated add-date offset', () => {
    // The measured household median is deliberately NOT used (0b's header records the reversal:
    // +7 scores 68.8% within a week against the median's 46.4%). If ADD_DATE_OFFSET_DAYS moves,
    // this Lambda must move with it rather than quietly keeping a stale constant.
    expect(RETIRE).toContain(`${ADD_DATE_OFFSET_DAYS}::int AS off_days`);
  });

  it.each(DERIVATION_TIERS.map((t) => [t.source, t]))('tier %s keeps its source/field/confidence', (source, tier) => {
    expect(RETIRE).toContain(`'${tier.source}'`);
    expect(RETIRE).toContain(`'${tier.confidence}'`);
    expect(RETIRE).toContain(`'${tier.field}'`);
  });

  it('ranks the tiers in anchorDerive.js\'s order — the rank IS the precedence', () => {
    // DERIVATION_TIERS is ordered, and tier_rank has to agree with that order or the no-downgrade
    // clause silently protects the wrong direction. Read the ladder's CASE arms out of the SQL and
    // compare the sequence, so re-ordering either side reds this.
    const arms = [...RETIRE.matchAll(/THEN '(sow_event|transplant_event|nursery_proxy_event)'/g)].map((m) => m[1]);
    expect(arms).toEqual(DERIVATION_TIERS.slice(0, 3).map((t) => t.source));
    const ranks = [...RETIRE.matchAll(/IS NOT NULL THEN (\d)\n/g)].map((m) => Number(m[1]));
    expect(ranks).toEqual([1, 2, 3]);
    expect(RETIRE).toMatch(/ELSE 4 END AS tier_rank/);
  });

  it.each([
    ['sow', SOW_EVENT_TYPES], ['transplant', TRANSPLANT_EVENT_TYPES], ['proxy', NURSERY_PROXY_EVENT_TYPES],
  ])('reads every %s event type the module defines', (_label, types) => {
    for (const t of types) expect(RETIRE).toContain(`'${t}'`);
  });

  it('treats all three OBSERVED columns as disqualifying, per the marking rule', () => {
    // The direction is the point: the re-derivation fires only where NONE of them is set. A planting
    // that has since gained a real date is absent from `target`, which is why this sweep cannot
    // violate the marking rule even on a run where the observed-anchor sweep above threw.
    expect(OBSERVED_ANCHOR_FIELDS.length).toBeGreaterThanOrEqual(3);
    // The alias must be exactly `p` (the target planting) — `[\s(]` in front so the household
    // dual-dated COUNT's own `dp.transplanted_at IS NOT NULL`, which is a different relation and a
    // correct use of the retiring direction, is not mistaken for one.
    for (const f of OBSERVED_ANCHOR_FIELDS) {
      for (const [name, sql] of Object.entries(BOTH)) {
        expect(new RegExp(`[\\s(]p\\.${f} IS NULL`).test(sql), `${name} does not require ${f} IS NULL`).toBe(true);
        expect(new RegExp(`[\\s(]p\\.${f} IS NOT NULL`).test(sql), `${name} reads ${f} in the retiring direction`).toBe(false);
      }
    }
  });
});

// ── the eligibility predicate, clause by clause ──────────────────────────────────────────────────
describe('the eligibility predicate refuses each way of being wrong', () => {
  const where = RETIRE.slice(RETIRE.indexOf('\n WHERE '), RETIRE.indexOf('\nRETURNING '));

  it('refuses a row a human decision already flagged as not believable', () => {
    // watch-route.js's `derived` CTE requires plausibility IS NULL; 22 of the 60 live prod rows carry
    // a mark. Re-deriving one means recomputing plausibility with a NARROWER rule than 0b's (no frost
    // anchor here, so post_frost_impossible cannot be reproduced), which would un-suppress it.
    expect(where).toMatch(/stale\.plausibility IS NULL/);
  });

  it('refuses a row written by a model this one does not own', () => {
    expect(where).toMatch(/stale\.model_version = c\.model_version/);
  });

  it('refuses to write a CLAMPED value — this is what makes the sweep converge', () => {
    // A clamped anchor equals et_today, so it moves every night; writing one would retire and
    // re-insert the same planting nightly for the whole first week after it was added. Refusing it
    // makes the output a pure function of (add_date, events, offset) with no dependence on today.
    expect(where).toMatch(/c\.clamped = false/);
  });

  it('refuses a TIER DOWNGRADE — evidence is never replaced by a guess', () => {
    expect(where).toMatch(/c\.tier_rank <= CASE stale\.source/);
    // Every source the CHECK constraint admits must have an arm, or an unmatched source yields NULL
    // and the row is dropped. That fail-closed direction is intended, but it must be intended for
    // exactly one reason (an unknown future source), not because an arm was forgotten.
    for (const t of DERIVATION_TIERS) {
      expect(where).toContain(`WHEN '${t.source}'`);
    }
  });

  it('requires that something actually CHANGE — the steady state is zero writes', () => {
    expect(where).toMatch(/c\.anchor_date <> stale\.anchor_date OR c\.tier_rank < CASE stale\.source/);
  });

  it('is idempotent: superseded_at IS NULL is both the re-run guard and the retirement-date guard', () => {
    // A second run in the same day recomputes the same values (nothing in an unclamped derivation
    // depends on today), finds anchor_date equal and tier_rank equal, and matches nothing. The
    // superseded_at test is what additionally stops a re-run rewriting an earlier retirement's
    // timestamp — that date is evidence about when the guess was replaced.
    expect(where).toMatch(/stale\.superseded_at IS NULL/);
  });
});

// ── what may be written, and to where ────────────────────────────────────────────────────────────
describe('the sweep writes one relation and retires rather than erases', () => {
  it.each(Object.entries(BOTH))('%s never deletes', (_name, sql) => {
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
  });

  it.each(Object.entries(BOTH))('%s writes no relation but plant_anchor_derivation', (_name, sql) => {
    // public.plants is READ and never written, so none of its four row-level UPDATE triggers fire
    // and no planting's updated_at or version moves — the same guarantee 0c check 6 proves for 0b.
    const writes = [...sql.matchAll(/\b(UPDATE|INSERT INTO)\s+(public\.)?(\w+)/gi)].map((m) => m[3]);
    expect([...new Set(writes)]).toEqual(['plant_anchor_derivation']);
  });

  it('records a reason that a calibration extract can tell apart from a real contradiction', () => {
    // 'observed_anchor' means a real date contradicted the guess, and that (guess, truth) pair is the
    // ONLY accuracy measurement the add-date tier will ever produce. A row retired here was
    // contradicted by nothing.
    expect(REDERIVE_REASON).toBe('rederived');
    expect(RETIRE).toContain(`superseded_by = '${REDERIVE_REASON}'`);
    expect(RETIRE).not.toContain("superseded_by = 'observed_anchor'");
  });

  it('does NOT present itself to the observed-anchor parity guard', () => {
    // anchor-supersede-parity.test.js slices the observed-anchor retire out of each site by searching
    // for "UPDATE [public.]plant_anchor_derivation d", then asserts that block gates on all three
    // observed columns and says 'observed_anchor'. This statement implements the opposite predicate,
    // so matching that guard would mean lying to it. The alias, not the ordering in the file, is what
    // keeps them apart — a later edit that moves this function above sweepSupersededAnchors must not
    // be able to hijack the guard's slice.
    const parityRe = /update\s+(public\.)?plant_anchor_derivation\s+d\b/i;
    expect(parityRe.test(RETIRE)).toBe(false);
    expect(RETIRE).toMatch(/UPDATE public\.plant_anchor_derivation stale/);
  });

  it('the insert re-checks that no live derivation exists — re-run guard AND recovery path', () => {
    // Same NOT EXISTS 0b uses, backed by uq_plant_anchor_derivation_live. It is also the whole of the
    // recovery story for the un-transacted pair: a crash between retire and insert leaves exactly the
    // state this predicate matches, so the next run repairs it without knowing anything went wrong.
    expect(INSERT).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM public\.plant_anchor_derivation x/);
    expect(INSERT).toMatch(/x\.plant_id = c\.plant_id\s+AND x\.superseded_at IS NULL/);
  });

  it('the insert is NOT gated on the clamp — a planting added today still gets an anchor', () => {
    // The asymmetry against the retire is deliberate: withholding a first derivation until the clamp
    // releases would leave a brand-new planting with no anchor for a week, where the create path
    // writes one immediately. Only the RE-derivation refuses clamped values.
    const insertWhere = INSERT.slice(INSERT.indexOf('\n WHERE '), INSERT.indexOf('\nRETURNING '));
    expect(insertWhere).not.toMatch(/clamped/);
    expect(INSERT).toContain('c.clamped, c.et_today');
  });

  it('inserts a value for every column it names, and names 0b\'s column list', () => {
    const cols = INSERT.slice(INSERT.indexOf('(user_id'), INSERT.indexOf('SELECT c.user_id'))
      .replace(/[()\s]/g, '').split(',').filter(Boolean);
    expect(cols).toEqual([
      'user_id', 'plant_id', 'anchor_date', 'anchor_field', 'source', 'confidence', 'model_version',
      'evidence_date', 'offset_days', 'offset_source', 'offset_sample_n', 'clamped_to_today',
      'derived_on', 'plausibility',
    ]);
    const vals = INSERT.slice(INSERT.indexOf('SELECT c.user_id'), INSERT.indexOf('\n  FROM computed c'))
      .split(',').length;
    expect(vals).toBe(cols.length);
  });

  it('both statements embed the IDENTICAL ladder — the judgement and the values cannot diverge', () => {
    const cte = (sql) => sql.slice(sql.indexOf('WITH\n') + 5, sql.indexOf('\nUPDATE ') > 0
      ? sql.indexOf('\nUPDATE ') : sql.indexOf('\nINSERT INTO '));
    expect(cte(RETIRE)).toBe(cte(INSERT));
    expect(cte(RETIRE).length).toBeGreaterThan(500);
  });

  it('carries no parameters and no caller input', () => {
    // Both statements are issued with pg.query(sql) and nothing else. Every literal in them is a
    // module constant, so there is no interpolation surface to get wrong.
    for (const sql of Object.values(BOTH)) expect(sql).not.toMatch(/\$\d/);
  });
});

// ── reachability and survival, executed rather than grepped ──────────────────────────────────────
describe('run() wiring', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });

  it('a LIVE run issues the retire then the insert, exactly once each', async () => {
    const { pg } = await drive({ dryRun: false });
    const texts = pg.calls.map((c) => c.sql);
    expect(texts.filter(isRetire)).toHaveLength(1);
    expect(texts.filter(isInsert)).toHaveLength(1);
    expect(texts.findIndex(isRetire)).toBeLessThan(texts.findIndex(isInsert));
  });

  it('a DRY run never writes — the replay wrapper depends on it', async () => {
    const { pg } = await drive({ dryRun: true });
    expect(pg.calls.filter((c) => /plant_anchor_derivation/.test(c.sql))).toHaveLength(0);
  });

  it('runs AFTER the observed-anchor sweep and before any weather work', async () => {
    // Ordering is a nicety rather than a correctness requirement (target re-tests all three observed
    // columns), but it is the ordering that makes the population this sweep runs over exactly "still
    // anchorless", so a reversal should be a deliberate edit.
    const { pg } = await drive({ dryRun: false });
    const texts = pg.calls.map((c) => c.sql);
    expect(texts.findIndex(isObservedSweep)).toBeGreaterThan(-1);
    expect(texts.findIndex(isObservedSweep)).toBeLessThan(texts.findIndex(isRetire));
    expect(texts.findIndex(isInsert)).toBeLessThan(texts.findIndex((t) => /from spaces/.test(t)));
  });

  it('a failing retire leaves the nightly plan intact AND still lets the insert run', async () => {
    // The two guards are separate for this reason: the insert is safe to issue after a failed retire
    // (every row the retire would have touched still holds a live derivation, so NOT EXISTS excludes
    // it) and it is the half that heals plantings holding no derivation at all.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { res, pg } = await drive({ dryRun: false, pgOpts: { failRetire: true } });
    expect(res.rows).toBeGreaterThan(0);
    expect(pg.calls.filter((c) => isInsert(c.sql))).toHaveLength(1);
    expect(logs(warn, 'anchor-rederive retire failed — plan unaffected')).toHaveLength(1);
  });

  it('a failing insert leaves the nightly plan intact', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { res } = await drive({ dryRun: false, pgOpts: { failInsert: true } });
    expect(res.rows).toBeGreaterThan(0);
    expect(logs(warn, 'anchor-rederive insert failed — plan unaffected')).toHaveLength(1);
  });

  it('both halves failing still leaves the nightly plan intact', async () => {
    // The named failure class is BUG-SEEDEDGATE-001 at table granularity — an environment without 0a
    // applied throws on every statement here, and Today must survive it.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { res } = await drive({ dryRun: false, pgOpts: { failRetire: true, failInsert: true } });
    expect(res.rows).toBeGreaterThan(0);
  });

  it('sweepRederiveAnchors never throws and never rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pg = recordingPg({ failRetire: true, failInsert: true });
    await expect(sweepRederiveAnchors(pg)).resolves.toEqual({ retired: 0, inserted: 0 });
  });
});

// ── observability: how Dave learns this ran and what it changed ──────────────────────────────────
describe('the summary line names what moved, not just how much', () => {
  it('reports counts read off the driver result, not off a guess', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const pg = recordingPg({ retireRows: [retireRow(), retireRow({ plant_id: 'pl-2' })], insertRows: [insertRow()] });
    expect(await sweepRederiveAnchors(pg)).toEqual({ retired: 2, inserted: 1 });
    const [line] = logs(spy, 'anchor-rederive-sweep');
    expect(line.retired).toBe(2);
    expect(line.inserted).toBe(1);
  });

  it('emits the line even when nothing moved — a stalled sweep must not look like a healthy one', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sweepRederiveAnchors(recordingPg());
    const [line] = logs(spy, 'anchor-rederive-sweep');
    expect(line).toMatchObject({ retired: 0, inserted: 0, changed: [], healed: 0, suppressed: 0 });
  });

  it('distinguishes a clamp release from a tier upgrade', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sweepRederiveAnchors(recordingPg({ retireRows: [
      retireRow(),
      retireRow({ plant_id: 'pl-2', now_source: 'nursery_proxy_event', now_anchor_date: '2026-07-27' }),
    ] }));
    const [line] = logs(spy, 'anchor-rederive-sweep');
    expect(line.changed.map((c) => c.why)).toEqual(['clamp_released', 'tier_upgrade']);
    expect(line.changed[1]).toMatchObject({
      plant: 'pl-2', from: 'add_date_baseline 2026-08-10', to: 'nursery_proxy_event 2026-07-27',
    });
  });

  it('counts a plausibility stamp separately — it REMOVES a planting from the watch band', async () => {
    // watch-route.js's derived CTE requires plausibility IS NULL, so a stamp is the one thing this
    // sweep does that takes something off Dave's screen. It must be legible without reading the table.
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sweepRederiveAnchors(recordingPg({
      retireRows: [retireRow({ now_plausibility: 'rescue_suspect' })],
      insertRows: [insertRow(), insertRow({ plant_id: 'pl-8', plausibility: 'rescue_suspect' })],
    }));
    const [line] = logs(spy, 'anchor-rederive-sweep');
    expect(line.healed).toBe(1);
    expect(line.suppressed).toBe(2);
  });

  it('caps the per-row detail and says how much it dropped', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rows = Array.from({ length: REDERIVE_LOG_MAX + 3 }, (_, i) => retireRow({ plant_id: `pl-${i}` }));
    await sweepRederiveAnchors(recordingPg({ retireRows: rows }));
    const [line] = logs(spy, 'anchor-rederive-sweep');
    expect(line.changed).toHaveLength(REDERIVE_LOG_MAX);
    expect(line.retired).toBe(REDERIVE_LOG_MAX + 3);
    expect(line.truncated).toBe(3);
  });

  it('a second run in the same day sends byte-identical statements', async () => {
    // Idempotence at the level this file can actually observe: the statements carry no run-varying
    // input, so "did it converge" is a property of the predicate (asserted above) rather than of a
    // changing query. A second run that sent DIFFERENT text would break that argument outright.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const pg = recordingPg();
    await sweepRederiveAnchors(pg);
    await sweepRederiveAnchors(pg);
    const texts = pg.calls.map((c) => c.sql);
    expect(texts).toHaveLength(4);
    expect(texts[0]).toBe(texts[2]);
    expect(texts[1]).toBe(texts[3]);
  });
});
