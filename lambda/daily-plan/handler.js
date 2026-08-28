'use strict';
// DRG-TODAY-001 — overnight Daily Plan generator.
// Pattern mirrors garden-xp-reconcile: EventBridge nightly (midnight ET), DRY_RUN-gated, no Fn URL, kill-switchable.
// Reads Neon (conn from Secrets Manager SECRET_ARN_NEON — NEVER hardcode), resolves weather from each Space's
// postal_code (zip-driven, not hardcoded), runs ./engine per CARETAKER, idempotent upsert into daily_plan.
const { generatePlan, PLAN_SCHEMA_VERSION, resolveCadence } = require('./engine');
const { deriveStation, bindStationToSpace, mergeStationHydrology, mergeStationWeather } = require('./station'); // DRG-WXSTATION-001
const { summarize } = require('./frostClass');                                   // V4-FROST-001 F2 (D6 per-crop bands)
const { frostEval, isFrostSeason, resolveFrostRun } = require('./frostEval');    // V4-FROST-001 F1/F3
const { resolveRainRun, rainDecision, previousDay, rainMetadata } = require('./rainLog'); // V4-RAINAUTOLOG-001 pt2

// The machine actor for rows this Lambda writes on nobody's behalf. Same source as the SYSTEM_SUBS
// set built further down, and FIRST-of-list because that variable is documented as accepting a
// comma-separated list while set_config needs exactly one sub. Note this is the ACTOR (who is
// writing), not the OWNER: rain rows are created_by the PLANTING's owner so they sit in the right
// household, and their machine provenance is carried by source='import' instead.
const SYSTEM_ACTOR_FALLBACK =
  (process.env.SYSTEM_CLERK_SUB || 'user_3D7uvqWjyxdq3jgVwTZs0mKT7Xd').split(',')[0].trim();
const cadence = require('./cadence-data-v2.json'); // per-variety research cadence (161). Swap to v_resolved_care once care_profile is seeded (CARE-CADENCE-001).
const fertModel = require('./fertilization-model.json'); // substrate-aware feed model. REQUIRED by engine.generatePlan (it derefs fertModel.water_quality / .amendments_in_inventory); omitting it crashes every run.

// Space-zip -> NWS forecast (low + high). Zip geocoded via cached spaces.weather_lat/lng, else a geocoder.
// All HTTP injected for testability; no network at module load.
async function weatherForSpace(space, { geocodeZip, fetchNWS }) {
  let { weather_lat: lat, weather_lng: lng, postal_code } = space;
  if ((lat == null || lng == null) && postal_code && geocodeZip) {
    // DRG-NIGHTLYTIMEOUT-001: geocodeZip is now bounded (AbortSignal) and throws on timeout; guard
    // like coordsForSpace so a geocode failure degrades to null weather instead of crashing the run.
    try { const g = await geocodeZip(postal_code); lat = g.lat; lng = g.lng; } catch (_) { return null; }
  }
  if (lat == null || lng == null) return null;              // no Space location -> no weather coupling (engine still runs)
  return fetchNWS(lat, lng);                                // -> { tonightLow, highToday, code, unit, short }
}

// FULL-PICTURE GATE (Dave directive): the nightly run must assemble the whole temporal window BEFORE any
// watering suggestion -- what already fell (N0/D0 actuals: 'did it rain 0.5" yesterday?') AND what's coming
// (N1 tonight + D2 tomorrow + N2). Open-Meteo gives reliable past-days + forecast precip in inches (NWS
// station precip fields are frequently null). If precip data can't be assembled, we DON'T silently assume
// dry -- we proceed with no rain-credit and raise the uncertainty flag (engine.hydrologyStatus).
async function hydrologyForSpace(space, { geocodeZip, fetchPrecip }) {
  let { weather_lat: lat, weather_lng: lng, postal_code } = space;
  if ((lat == null || lng == null) && postal_code && geocodeZip) {
    try { const g = await geocodeZip(postal_code); lat = g.lat; lng = g.lng; } catch (_) { return null; } // DRG-NIGHTLYTIMEOUT-001: degrade, don't crash
  }
  if (lat == null || lng == null || !fetchPrecip) return null;
  // fetchPrecip(lat,lng) -> { recent_precip_in (D-2+D-1 actual), upcoming_precip_in (D1+D2),
  //                           tomorrow_precip_in, tomorrow_pop }
  return fetchPrecip(lat, lng);
}

// DRG-WXROLL-001 — resolve a Space's coordinates once (cached spaces.weather_lat/lng, else geocoded zip) so
// they can be embedded in the stored plan, letting the Today client re-fetch live precip for the SAME point.
// Returns null when no location is resolvable (weather is simply absent; the engine still runs).
async function coordsForSpace(space, { geocodeZip }) {
  let { weather_lat: lat, weather_lng: lng, postal_code } = space;
  if ((lat == null || lng == null) && postal_code && geocodeZip) {
    try { const g = await geocodeZip(postal_code); lat = g.lat; lng = g.lng; } catch (_) { return null; }
  }
  if (lat == null || lng == null) return null;
  return { lat: Number(lat), lng: Number(lng) };
}

// BUG-TODAYWATER-001 — how many earlier generations of the SAME day to retain inside items.prior_runs.
// 3 covers the nightly plus both intraday refreshes; a 4th would mean someone re-ran manually, and the
// oldest (the nightly) is the one worth keeping, so we keep the head and drop from the tail.
const PRIOR_RUNS_MAX = 3;

// Read the row this run is about to replace and fold it into a compact history entry. Returns [] on a
// first run of the day or on ANY failure — this is an audit nicety and must never be able to empty or
// block the plan, which is the same fail-open posture fetchStation takes.
async function readPriorRuns(pg, userId, planDate) {
  try {
    const { rows } = await pg.query(
      `select items, generated_at from daily_plan where user_id = $1 and plan_date = $2`,
      [userId, planDate]);
    if (!rows.length) return [];
    const prev = rows[0].items || {};
    const entry = {
      generated_at: rows[0].generated_at,
      hydrology: prev.hydrology ?? null,
      counts: prev.counts ?? null,
    };
    // Oldest-first, newest-dropped-when-full: the nightly run is the baseline worth keeping.
    return [...(Array.isArray(prev.prior_runs) ? prev.prior_runs : []), entry].slice(0, PRIOR_RUNS_MAX);
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'prior-runs read failed — continuing without history', error: e?.message }));
    return [];
  }
}

// BUG-TODAYWATER-001 actuals backfill — previous plan_date as YYYY-MM-DD (pure UTC date math, matching
// engine.daysBetween's calendar convention; plan_date is a calendar label, not an instant).
function prevPlanDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Write yesterday's OBSERVED rain (hy.yesterday_precip_actual_in, from the past-days array fetchPrecip
// already reads) onto YESTERDAY's plan row as items.today_precip_actual_in — additive jsonb key, no DDL, no
// PLAN_SCHEMA_VERSION bump (readers select named keys). This is what makes "did we skip on a forecast that
// busted?" answerable: yesterday's row holds the forecast it acted on (today_precip_in / prior_runs) and,
// after this run, what actually fell. Same fail-open posture as readPriorRuns — an audit write may NEVER
// break plan generation. Scope: same user_id + previous plan_date ONLY; the CURRENT day's row is untouched
// (flag-OFF byte-parity). 0 is real data (an observed dry day); null/absent means unknown -> no write.
// BUG-RAINACTUAL-001 H3 — the value is now gauge-first (station.mergeStationHydrology), and a SECOND key,
// today_precip_actual_source, is written beside it in the SAME statement. That label is not decoration: an
// "actual" that is silently Open-Meteo's own hindcast is exactly how 2026-08-03 came to be recorded as 4.63"
// against 2.22" on the on-site gauge. `prov` is the Space's station provenance bag; with no station bound
// there is no ambiguity about what the number is, so the label is 'forecast'.
async function backfillYesterdayActual(pg, userId, today, hy, prov) {
  try {
    const v = hy ? hy.yesterday_precip_actual_in : null;
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return false;
    const src = (prov && prov.yesterday_actual_source) || 'forecast';
    await pg.query(
      `update daily_plan
         set items = jsonb_set(
               jsonb_set(coalesce(items, '{}'::jsonb), '{today_precip_actual_in}', $3::jsonb, true),
               '{today_precip_actual_source}', $4::jsonb, true)
       where user_id = $1 and plan_date = $2`,
      [userId, prevPlanDate(today), JSON.stringify(v), JSON.stringify(src)]);  // jsonb text params — sidesteps neon null/numeric param typing
    return true;
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'actuals backfill failed — plan write unaffected', error: e?.message }));
    return false;
  }
}

// ── V4-WATERMATH-001 F1 (W-F2A-WX) — the weather_daily substrate ─────────────────────────────────
// Canon: watering-cadence-math-design-V100-20260812.md Part 4. Migration: migrations/v4-weatherdaily-001.
//
// F1 ships the SUBSTRATE only. Nothing here changes a single watering verdict — the engine does not
// read weather_daily yet (that is F2, behind CARE_WATER_LEDGER_ENABLED) — and that is the point: the
// ledger's demand term integrates over a 30-day window, so the series has to have been accumulating
// long before the fold that consumes it is switched on.
//
// WRITE DISCIPLINE, and why each clause of it is load-bearing:
//   * COMPLETED DAYS ONLY. Sourced from hydrology.settled_days, which excludes D0 by construction.
//     A 15:30 intraday run persisting today's partial total would be indistinguishable from a real
//     dry day on every later read.
//   * !dryRun ONLY. A dry replay must read and never write — the same wrapper contract that governs
//     every other write in this run (scripts/rerun-daily-plan.sh depends on a dry invoke being
//     zero-write, and the A0.2/A0.3 sentinels exist to prove the deployed zip honours it).
//   * STRICTLY BEFORE `today`. This is the guard against the `--today <past>` replay trap: the
//     wrapper's `--today` overrides the PLAN DATE but the fetchers still call Open-Meteo relative to
//     NOW, so a "historical" replay holds today's weather wearing a past date's label. Without this
//     comparison, one `--live --today 2026-07-01` would stamp this week's ET0 onto July rows and the
//     corruption would be invisible — the values are plausible and the provenance column would say
//     'openmeteo_live', which would be true and useless.
//   * NON-FATAL, ALWAYS. Same fail-open posture as readPriorRuns and backfillYesterdayActual: this
//     is substrate accumulation, and losing a night of it is a rounding error against losing the
//     nightly plan. The catch is what makes the migration-lands-late window survivable at all.
const WEATHER_DAILY_SOURCE_GAUGE = 'gauge_merged';
const WEATHER_DAILY_SOURCE_LIVE = 'openmeteo_live';

// Upsert the completed days from one Space's hydrology bag. Returns the number of rows written; never
// throws, never returns a rejected promise. `prov` is the Space's station provenance bag, which is the
// ONLY thing that can distinguish a gauge reading from a model hindcast (see the H3 note in station.js —
// an "actual" that is silently a forecast is the exact defect BUG-RAINACTUAL-001 was filed for).
async function writeWeatherDaily(pg, spaceId, today, hy, prov) {
  try {
    const days = hy && Array.isArray(hy.settled_days) ? hy.settled_days : null;
    if (!days || !days.length) return 0;
    if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return 0;
    const yesterday = prevPlanDate(today);
    // The gauge-merged D-1 figure, if station.mergeStationHydrology established one. Read from the
    // TOP-LEVEL key rather than from settled_days because the merge writes it there — settled_days
    // deliberately carries the raw model value so the two can be told apart here.
    const mergedYest = Number.isFinite(hy.yesterday_precip_actual_in) ? hy.yesterday_precip_actual_in : null;
    const yestIsGauge = !!(prov && prov.yesterday_actual_source === 'station');
    let written = 0;
    for (const d of days) {
      if (!d || typeof d.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) continue;
      if (d.date >= today) continue;                       // the --today replay guard; ISO dates compare lexically
      const isYesterday = d.date === yesterday;
      // Prefer the gauge-merged number for D-1; fall back to the raw model value. Label honestly in
      // both directions — the label is what makes a later "how good was our input?" question answerable.
      const precip = (isYesterday && mergedYest != null) ? mergedYest : d.precip_in;
      const precipSource = precip == null
        ? null
        : ((isYesterday && mergedYest != null && yestIsGauge) ? WEATHER_DAILY_SOURCE_GAUGE : WEATHER_DAILY_SOURCE_LIVE);
      const et0Source = d.et0_in == null ? null : WEATHER_DAILY_SOURCE_LIVE;
      // Every parameter carries an explicit cast. Neon's driver cannot infer a type for a NULL bind
      // and answers "could not determine data type of parameter" — which, in a try/catch this broad,
      // would present as the weather substrate silently never populating.
      await pg.query(
        `insert into weather_daily (space_id, "date", et0_in, tmax_f, tmin_f, precip_in, precip_source, et0_source)
         values ($1::uuid, $2::date, $3::numeric, $4::numeric, $5::numeric, $6::numeric, $7::text, $8::text)
         on conflict (space_id, "date") do update set
           et0_in    = coalesce(excluded.et0_in,    weather_daily.et0_in),
           tmax_f    = coalesce(excluded.tmax_f,    weather_daily.tmax_f),
           tmin_f    = coalesce(excluded.tmin_f,    weather_daily.tmin_f),
           -- NEVER downgrade a gauge reading to a model one. The nightly run rewrites D-2 as well as
           -- D-1, and by the time a day is D-2 the AmbientWeather buckets that produced its gauge
           -- figure are gone, so the only value on offer is Open-Meteo's. Without this guard every
           -- night would overwrite yesterday's measured rain with the model's estimate — the table
           -- would hold real gauge data for exactly 24 hours, and precip_source would faithfully
           -- record the replacement while looking entirely healthy.
           precip_in = case when weather_daily.precip_source = '${WEATHER_DAILY_SOURCE_GAUGE}'
                             and coalesce(excluded.precip_source, '') <> '${WEATHER_DAILY_SOURCE_GAUGE}'
                            then weather_daily.precip_in
                            else coalesce(excluded.precip_in, weather_daily.precip_in) end,
           precip_source = case when weather_daily.precip_source = '${WEATHER_DAILY_SOURCE_GAUGE}'
                                 and coalesce(excluded.precip_source, '') <> '${WEATHER_DAILY_SOURCE_GAUGE}'
                                then weather_daily.precip_source
                                else coalesce(excluded.precip_source, weather_daily.precip_source) end,
           et0_source = coalesce(excluded.et0_source, weather_daily.et0_source),
           updated_at = now()`,
        [spaceId, d.date, d.et0_in ?? null, d.tmax_f ?? null, d.tmin_f ?? null,
         precip ?? null, precipSource, et0Source]);
      written++;
    }
    // Design Part 4 asks for named soak observability rather than vibes: rows/day per space and the
    // null-rate, so a substrate that is quietly writing all-NULL rows is visible in CloudWatch before
    // F2 ever reads it. An alarm threshold on this line is a pre-F2 task.
    console.log(JSON.stringify({ msg: 'weather-daily-write', space: spaceId, rows: written,
      dates: days.map((d) => d && d.date).filter(Boolean),
      null_et0: days.filter((d) => d && d.et0_in == null).length,
      null_precip: days.filter((d) => d && d.precip_in == null).length,
      gauge_yesterday: yestIsGauge }));
    return written;
  } catch (e) {
    // The named failure class: BUG-SEEDEDGATE-001 at TABLE granularity. If the migration has not
    // landed, every statement above throws "relation weather_daily does not exist" — and it stops
    // here, with a warning, leaving the nightly plan completely unaffected.
    console.warn(JSON.stringify({ msg: 'weather_daily write failed — plan unaffected', space: spaceId, error: e?.message }));
    return 0;
  }
}

// FLAG-GATED READ. Nothing in F1 calls this unless CARE_WATER_LEDGER_ENABLED is exactly 'true'; F2's
// fold is its only real consumer. The gating is the whole point — a SELECT against a relation that
// does not exist yet is precisely the seededgate defect (one bad query blanked the entire nightly plan
// for both users), so the read must be structurally unreachable until the migration is known to have
// landed, not merely defensive about it. Pinned by an EXECUTING test that counts the queries run()
// actually issues, not by a source grep: a grep proves where the call site is written, and the thing
// worth proving is that it is never reached.
async function readWeatherDaily(pg, spaceId, fromDate, toDate) {
  try {
    const { rows } = await pg.query(
      `select "date"::text as date, et0_in, tmax_f, tmin_f, precip_in, precip_source, et0_source
         from weather_daily
        where space_id = $1::uuid and "date" >= $2::date and "date" <= $3::date
        order by "date"`,
      [spaceId, fromDate, toDate]);
    return rows;
  } catch (e) {
    // Fail-open to an EMPTY SERIES, never to a throw. Design Part 4's degenerate branch is explicit:
    // a missing weather_daily row yields demand = 1.0, which is today's model exactly. An unreadable
    // table must therefore degrade the ledger to present-day behaviour, not take the run down.
    console.warn(JSON.stringify({ msg: 'weather_daily read failed — ledger degrades to demand 1.0', space: spaceId, error: e?.message }));
    return [];
  }
}

// ── V4-ANCHORSUPERSEDE-001 — the supersede maintainer, nightly half ──────────────────────────────
// Canon for the rule: migrations/v4-anchorbase-001/0b-backfill.sql's second transaction, whose
// header calls it "run on every subsequent execution" — and which nothing ran after the one-shot
// backfill of 2026-08-12. public.plant_anchor_derivation holds an INVENTED anchor for a planting
// that had no real date; the moment a real one arrives the guess has been contradicted and must be
// retired, or lambda/harvests/watch-route.js keeps citing it (its `derived` CTE selects exactly the
// rows this statement retires).
//
// WHY BOTH HERE AND ON THE WRITE PATH. The plants PUT and the merge cutover retire synchronously,
// which is what makes the window zero for anything a user does in the app. This sweep is not
// redundant with them, for two reasons neither of them can cover:
//   1. It is the ONLY thing that heals rows that went stale BEFORE the write-path fix shipped. A
//      write-path retire fires on the next write to that planting; a planting that gained its date
//      last week and is never edited again would hold a live contradicted derivation forever.
//   2. Writers that never touch a Lambda — the rescue-intake style imports, a one-off UPDATE, a
//      migration — bypass every app path by construction.
// Together they are what makes gates.yml's post_no_derived_beside_observed safe to run continuous:
// the write path stops Dave's own data entry from ever reddening it, and this heals everything else
// within a night.
//
// SAME WRITE DISCIPLINE AS writeWeatherDaily, for the same reasons: !dryRun only (a dry replay must
// read and never write — scripts/rerun-daily-plan.sh depends on it), and NON-FATAL always. Losing a
// night of the sweep costs a day of a stale marker; taking the nightly plan down costs Dave his
// Today. No user_id scoping: the marking rule is an invariant of the table, not of a household, and
// this runs as one indexed statement rather than per planting.
//
// RETIRE, NEVER DELETE. The (guess, later truth) pair is the only accuracy measurement the add-date
// baseline tier will ever produce; deleting it throws away the measurement the backfill exists to
// create. `superseded_at is null` is both the idempotence guard (a second run matches nothing) and
// the reason a re-run cannot rewrite an earlier retirement's timestamp.
async function sweepSupersededAnchors(pg) {
  try {
    const res = await pg.query(
      `update public.plant_anchor_derivation d
          set superseded_at = now(),
              superseded_by = 'observed_anchor',
              updated_at    = now()
         from public.plants p
        where p.id = d.plant_id
          and d.superseded_at is null
          and (p.sown_at is not null or p.transplanted_at is not null
               or p.planted_out_at is not null)`);
    const rows = res && Number.isFinite(res.rowCount) ? res.rowCount : 0;
    console.log(JSON.stringify({ msg: 'anchor-supersede-sweep', rows }));
    return rows;
  } catch (e) {
    // Same posture as the weather_daily writer: a missing relation (0a not applied in some
    // environment) or any other failure warns and leaves the nightly plan completely unaffected.
    console.warn(JSON.stringify({ msg: 'anchor-supersede sweep failed — plan unaffected', error: e?.message }));
    return 0;
  }
}

// ── V4-ANCHORRESWEEP-001 — the nightly RE-derivation sweep ───────────────────────────────────────
// Canon for the derivation itself: migrations/v4-anchorbase-001/0b-backfill.sql (the tier ladder and
// every written value) as corrected by lambda/plants/anchorCreate.js (two-arm ownership,
// rescue_suspect-only plausibility). This is the THIRD copy of that statement and it is deliberate
// for the reason the other two state: each Lambda is zipped from its own directory
// (deploy-lambda.yml: cd lambda/<fn> && zip -r), so a shared module is not packaged and the handler
// 502s at module load. anchor-rederive.test.js is the drift guard.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE TWO DEFECTS THIS CLOSES, both recorded in anchorCreate.js's header as known and deferred
//
//   1. THE CLAMP FREEZES. mark() clamps a future anchor to today. At CREATE time add_date IS today,
//      so add_date + 7 is always ahead of it and the clamp ALWAYS binds — every create-path row
//      lands at add_date with clamped_to_today = true, i.e. 7 days earlier than the same planting
//      derives once a week has passed. Nothing ever revisits it.
//   2. LATER EVIDENCE DOES NOT UPGRADE. A transplant is self-healing (events/index.js writes
//      transplanted_at and retires the derivation in one transaction), but a sowing / seed_soak /
//      potting_up logged AFTER the create leaves a tier-3 guess live where tier 1 or 2.5 evidence
//      now exists.
//
// Both are the same shape — the row is a snapshot of what was knowable at t=0 — so both are fixed by
// re-running the derivation against the accrued state, which is what a nightly sweep is for.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// TWO STATEMENTS, AND THE SECOND ONE IS THE RECOVERY MECHANISM FOR THE FIRST
//
// uq_plant_anchor_derivation_live is UNIQUE(plant_id) WHERE superseded_at IS NULL, so a re-derivation
// is retire-then-insert and cannot be one statement: folding the retire into a data-modifying CTE
// puts both sub-statements on the SAME command id, the unique check still sees the old tuple as live,
// and the INSERT raises 23505. So they are issued separately, on the pool, each its own transaction.
//
// That makes the boundary honest to state: THERE IS NO ROLLBACK ACROSS THE PAIR. What there is
// instead is a second statement whose predicate — "a live anchorless planting with NO live
// derivation" — is EXACTLY the state a crash between them would leave. A partial failure therefore
// degrades to a planting temporarily missing its derived anchor (it drops out of the watch band's
// derived tier for a night, no wrong value is ever written) and the NEXT run repairs it without
// knowing anything went wrong. Ordering the pair the other way round would not merely fail to
// self-heal, it would 23505 on the first row.
//
// Statement 2 also earns its place standing alone: it is the backstop anchorCreate.js's call-site
// try/catch already claims exists ("a failed derive leaves nothing at all, and the nightly sweep is
// the backstop") and which, until now, did not. It covers a failed create hook, a planting created
// before that hook shipped, and any writer that never touches a Lambda.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE ELIGIBILITY PREDICATE — the highest-risk decision here, so every clause is a deliberate NO
//
// Re-deriving the wrong row is data loss wearing a fix's clothing, so the retire is narrow by
// construction and each clause below removes a distinct way of being wrong:
//
//   * plausibility IS NULL. 0a2's marks (rescue_suspect / post_frost_impossible) are rows the
//     backfill itself flagged as not believable, and watch-route.js's `derived` CTE drops them —
//     22 of the 60 live rows on prod today. Re-deriving one means recomputing its plausibility HERE,
//     with a narrower rule than 0b's (this Lambda has no first-frost anchor and no catalogue DTM, so
//     it cannot reproduce post_frost_impossible), which would silently UN-SUPPRESS rows a human
//     decision put out of the band. Excluded outright: the sweep can only ever touch rows that are
//     already feeding the band.
//   * model_version matches. A row written by a future model is not this model's to rewrite; an
//     unrecognised source likewise falls out through the NULL arm of the rank CASE below.
//   * the fresh derivation is NOT CLAMPED. This is the convergence guard, not a taste filter. A
//     clamped anchor equals et_today, so it MOVES EVERY NIGHT — re-deriving one would retire and
//     re-insert the same planting nightly for the whole first week after it was added, seven rows of
//     churn in the relation that exists to hold the tier's accuracy record. Refusing to write a
//     clamped value makes the output a pure function of (add_date, events, offset) with no
//     dependence on today at all, which is what makes a second run in the same day a provable no-op.
//     The cost is stated rather than hidden: for the ~7 days a row is still clamped it keeps the
//     EARLIER anchor the create path wrote. That error opens a watch window early; it never hides
//     one, and it self-corrects on the day the clamp releases.
//   * NEVER A TIER DOWNGRADE (c.tier_rank <= the stored row's rank). If a sowing event is
//     soft-deleted, the fresh derivation falls back to the add-date guess — and replacing recorded
//     evidence with a guess is the one direction this table must never move. It also bounds the
//     blast radius of a bug in the evidence join: a join that transiently returned nothing would
//     otherwise downgrade every event-tier row in the household in one night.
//   * SOMETHING MUST ACTUALLY CHANGE (different anchor_date, or a strictly better tier). This is
//     what makes the steady state zero writes rather than 60 rewrites a night.
//
// Not in the list, because it is structural: a planting that has since gained a real date is absent
// from `target` (all three observed columns must be NULL), so the marking rule cannot be violated
// here even if sweepSupersededAnchors above failed on the same run.
//
// SAME WRITE DISCIPLINE AS THE OTHER SWEEPS: !dryRun only, and NON-FATAL always — losing a night of
// re-derivation costs a stale marker, taking the nightly plan down costs Dave his Today.
const ANCHOR_MODEL_VERSION = 'anchor-derive-v1';
// Distinct from 'observed_anchor' on purpose. That reason means "a real date contradicted the guess",
// and the (guess, later truth) pair it creates is the ONLY accuracy measurement the add-date tier
// will ever produce. A row retired here was contradicted by nothing — it was replaced by a better
// derivation — so a calibration extract filtering on 'observed_anchor' must not pick it up.
const REDERIVE_REASON = 'rederived';
// Cap on the per-row detail carried in the summary log line. Named rather than counted, the way
// station.js reports station_rejected_days, because "which plantings moved" is the question an
// operator actually has; capped because a runaway sweep must not also blow up the log line.
const REDERIVE_LOG_MAX = 20;

// The derivation, once. Both statements below embed this identical CTE chain, so the retire's
// judgement and the insert's values can never be computed by two different ladders. Contains no
// parameters and no caller input of any kind — every literal in it is a constant from this module.
const REDERIVE_CTE = `
  prm AS (
    SELECT 'America/New_York'::text AS tz,
           '${ANCHOR_MODEL_VERSION}'::text AS model_version,
           7::int AS off_days,
           'stated_baseline'::text AS off_src
  ),
  -- 0b's target CTE, with anchorCreate.js's two-arm ownership in place of 0b's INNER JOIN to
  -- plant_projects. That join silently excluded every project-less planting, which is the
  -- BUG-ANCHORNOPROJ-001 shape and is exactly what left two live prod rows uncovered.
  target AS (
    SELECT p.id                                     AS plant_id,
           coalesce(pj.created_by, p.created_by)    AS user_id,
           (p.created_at AT TIME ZONE prm.tz)::date AS add_date,
           (now()        AT TIME ZONE prm.tz)::date AS et_today,
           prm.model_version,
           -- rescue_suspect ONLY, per anchorCreate.js: post_frost_impossible needs a first-fall-frost
           -- anchor and a catalogue DTM, and inventing a frost date here would be a second, drifting
           -- copy of one (0b's is the literal 2026-09-28, which a NIGHTLY statement would carry into
           -- 2027). watch.js condition 3 already suppresses that class at READ time.
           CASE WHEN p.name ILIKE '%rescue%' OR p.status IN ('flowering', 'fruiting')
                THEN 'rescue_suspect' ELSE NULL END AS plausibility
      FROM public.plants p
      LEFT JOIN public.plant_projects pj ON pj.id = p.project_id
      CROSS JOIN prm
     WHERE p.deleted_at IS NULL
       AND p.archived_at IS NULL
       AND (pj.id IS NULL OR (pj.deleted_at IS NULL AND pj.archived_at IS NULL))
       AND (p.status IS NULL OR p.status NOT IN ('failed', 'ended', 'dormant'))
       AND p.sown_at IS NULL
       AND p.transplanted_at IS NULL
       AND p.planted_out_at IS NULL
  ),
  evidence AS (
    SELECT t.plant_id,
           min((e.event_date AT TIME ZONE prm.tz)::date) FILTER (WHERE e.event_type IN ('sowing', 'seed_soak'))     AS sow_date,
           min((e.event_date AT TIME ZONE prm.tz)::date) FILTER (WHERE e.event_type = 'transplant')                 AS transplant_date,
           min((e.event_date AT TIME ZONE prm.tz)::date) FILTER (
             WHERE e.event_type IN ('potting_up', 'hardening_off', 'brought_outside'))                              AS proxy_date
      FROM target t
      CROSS JOIN prm
      LEFT JOIN public.event_log e ON e.plant_id = t.plant_id AND e.deleted_at IS NULL
     GROUP BY t.plant_id
  ),
  -- 0b's CASE ladder, evaluated ONCE in a LATERAL so source / confidence / anchor_field / rank /
  -- evidence_date / offset_days cannot disagree with each other. tier_rank is the same precedence
  -- expressed as a number so the retire can compare tiers instead of enumerating pairs.
  computed AS (
    SELECT t.plant_id, t.user_id, t.et_today, t.model_version, t.plausibility,
           tier.source, tier.confidence, tier.anchor_field, tier.tier_rank,
           tier.evidence_date, tier.offset_days,
           least(tier.evidence_date + tier.offset_days, t.et_today) AS anchor_date,
           (tier.evidence_date + tier.offset_days) > t.et_today     AS clamped,
           CASE WHEN tier.offset_days > 0 THEN prm.off_src ELSE NULL END AS offset_source,
           -- Provenance only: how much dual-dated data the household held. 0b's offsets CTE
           -- shape. NULL off the baseline tier, which plant_anchor_derivation_offset_chk expects.
           CASE WHEN tier.offset_days > 0 THEN (
                  SELECT count(*)::int
                    FROM public.plants dp
                    JOIN public.plant_projects dj ON dj.id = dp.project_id
                   WHERE dj.created_by = t.user_id
                     AND dp.deleted_at IS NULL
                     AND dj.deleted_at IS NULL
                     AND dp.transplanted_at IS NOT NULL)
                ELSE NULL END AS offset_sample_n
      FROM target t
      CROSS JOIN prm
      JOIN evidence ev ON ev.plant_id = t.plant_id
      CROSS JOIN LATERAL (
        SELECT CASE WHEN ev.sow_date        IS NOT NULL THEN 'sow_event'
                    WHEN ev.transplant_date IS NOT NULL THEN 'transplant_event'
                    WHEN ev.proxy_date      IS NOT NULL THEN 'nursery_proxy_event'
                    ELSE 'add_date_baseline' END AS source,
               CASE WHEN ev.sow_date IS NOT NULL OR ev.transplant_date IS NOT NULL THEN 'event'
                    WHEN ev.proxy_date IS NOT NULL THEN 'proxy'
                    ELSE 'baseline' END AS confidence,
               CASE WHEN ev.sow_date IS NOT NULL THEN 'sown_at'
                    ELSE 'transplanted_at' END AS anchor_field,
               CASE WHEN ev.sow_date        IS NOT NULL THEN 1
                    WHEN ev.transplant_date IS NOT NULL THEN 2
                    WHEN ev.proxy_date      IS NOT NULL THEN 3
                    ELSE 4 END AS tier_rank,
               coalesce(ev.sow_date, ev.transplant_date, ev.proxy_date, t.add_date) AS evidence_date,
               CASE WHEN coalesce(ev.sow_date, ev.transplant_date, ev.proxy_date) IS NULL
                    THEN prm.off_days ELSE 0 END AS offset_days
      ) tier
  )`;

// The stored row's tier, as a number, for comparison against computed.tier_rank. An unrecognised
// source yields NULL, which makes every comparison below NULL and drops the row — fail-closed on a
// value this model does not own.
const STORED_TIER_RANK = `CASE stale.source
                            WHEN 'sow_event'           THEN 1
                            WHEN 'transplant_event'    THEN 2
                            WHEN 'nursery_proxy_event' THEN 3
                            WHEN 'add_date_baseline'   THEN 4 END`;

// Aliased stale, NOT d. anchor-supersede-parity.test.js slices the OBSERVED-ANCHOR retire out
// of each site by searching for "UPDATE [public.]plant_anchor_derivation d", then asserts that block
// gates on all three observed columns and records superseded_by = 'observed_anchor'. This statement
// implements a DIFFERENT rule — it fires precisely when NONE of those columns is set — so matching
// that guard would mean lying to it. The alias keeps the two rules distinguishable by shape rather
// than by which one happens to appear first in the file.
const REDERIVE_RETIRE_SQL = `
WITH ${REDERIVE_CTE}
UPDATE public.plant_anchor_derivation stale
   SET superseded_at = now(),
       superseded_by = '${REDERIVE_REASON}',
       updated_at    = now()
  FROM computed c
 WHERE stale.plant_id = c.plant_id
   AND stale.superseded_at IS NULL
   AND stale.model_version = c.model_version
   AND stale.plausibility IS NULL
   AND c.clamped = false
   AND c.tier_rank <= ${STORED_TIER_RANK}
   AND (c.anchor_date <> stale.anchor_date OR c.tier_rank < ${STORED_TIER_RANK})
RETURNING stale.plant_id,
          stale.source                             AS was_source,
          to_char(stale.anchor_date, 'YYYY-MM-DD') AS was_anchor_date,
          c.source                                 AS now_source,
          to_char(c.anchor_date, 'YYYY-MM-DD')     AS now_anchor_date,
          c.plausibility                           AS now_plausibility`;

// 0b's INSERT, unchanged in intent: one fresh derivation for every live anchorless planting that
// holds none. The NOT EXISTS is both the re-run guard and — because it matches a planting whose row
// was retired a moment ago — the whole of the recovery path described in the header.
//
// Deliberately NOT gated on `clamped`: unlike the retire, a first derivation for a planting added
// today SHOULD be written clamped, because that is byte-for-byte what the create path writes and
// withholding it would leave a brand-new planting with no anchor for a week.
const REDERIVE_INSERT_SQL = `
WITH ${REDERIVE_CTE}
INSERT INTO public.plant_anchor_derivation
  (user_id, plant_id, anchor_date, anchor_field, source, confidence, model_version,
   evidence_date, offset_days, offset_source, offset_sample_n, clamped_to_today, derived_on,
   plausibility)
SELECT c.user_id, c.plant_id, c.anchor_date, c.anchor_field, c.source, c.confidence, c.model_version,
       c.evidence_date, c.offset_days, c.offset_source, c.offset_sample_n, c.clamped, c.et_today,
       c.plausibility
  FROM computed c
 WHERE NOT EXISTS (
         SELECT 1 FROM public.plant_anchor_derivation x
          WHERE x.plant_id = c.plant_id
            AND x.superseded_at IS NULL)
RETURNING plant_id, source, to_char(anchor_date, 'YYYY-MM-DD') AS anchor_date,
          clamped_to_today, plausibility`;

// Re-derive, then fill. Never throws; returns what it did so run() and the tests read a real result
// shape rather than a stub that happens to be truthy.
//
// The two steps carry SEPARATE guards on purpose. A failed retire must not suppress the insert: the
// insert is safe to issue in that state (every row the retire would have touched still holds a live
// derivation, so NOT EXISTS excludes it) and it is the half that heals plantings holding no
// derivation at all, which is the older and more visible defect of the two.
async function sweepRederiveAnchors(pg) {
  let retired = [];
  let inserted = [];
  try {
    const res = await pg.query(REDERIVE_RETIRE_SQL);
    retired = (res && Array.isArray(res.rows)) ? res.rows : [];
  } catch (e) {
    // Same posture and same named failure class as the sweep above: a missing relation (0a not
    // applied in some environment) or any other failure warns and leaves the nightly plan alone.
    console.warn(JSON.stringify({ msg: 'anchor-rederive retire failed — plan unaffected', error: e?.message }));
  }
  try {
    const res = await pg.query(REDERIVE_INSERT_SQL);
    inserted = (res && Array.isArray(res.rows)) ? res.rows : [];
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'anchor-rederive insert failed — plan unaffected', error: e?.message }));
  }
  // One structured line per run, emitted even when nothing moved: a sweep that has silently stopped
  // matching anything looks identical to a healthy steady state unless the zero is stated. `changed`
  // names the plantings and both endpoints, because "which ones moved, and from what to what" is the
  // question an operator has and a count cannot answer.
  console.log(JSON.stringify({
    msg: 'anchor-rederive-sweep',
    retired: retired.length,
    inserted: inserted.length,
    changed: retired.slice(0, REDERIVE_LOG_MAX).map((r) => ({
      plant: r.plant_id,
      why: r.was_source === r.now_source ? 'clamp_released' : 'tier_upgrade',
      from: `${r.was_source} ${r.was_anchor_date}`,
      to: `${r.now_source} ${r.now_anchor_date}`,
    })),
    // The only user-visible effects, split out so neither hides in a total. A plausibility stamp
    // REMOVES a planting from the watch band (watch-route.js's derived CTE requires it NULL), so a
    // sweep that started suppressing rows must be legible without reading the table.
    healed: inserted.filter((r) => !r.plausibility).length,
    suppressed: inserted.filter((r) => r.plausibility).length
      + retired.filter((r) => r.now_plausibility).length,
    truncated: Math.max(0, retired.length - REDERIVE_LOG_MAX),
  }));
  return { retired: retired.length, inserted: inserted.length };
}

// How far back the ledger fold looks. Design Part 2 anchors on the latest watering/rain event within
// 30 days, so the weather window must cover the same span or the earliest days of the fold would
// accrue demand 1.0 against real events.
const WEATHER_DAILY_WINDOW_DAYS = 30;

// ── V4-WATERMATH-001 F2 — the engine INPUT-CONTRACT change (canon Part 5: "the largest single F2
// code change"). The planting query above still fetches one MAX(event_date) DATE per planting (the
// legacy dW input, untouched for flag-OFF byte-parity); the fold additionally needs each planting's
// 30-day event window WITH TIMESTAMPS and metadata.water_depth. ONE windowed query across all
// plantings (~3.7k rows/30d live), grouped in JS — not a per-planting lateral, so the cost is one
// round trip regardless of planting count.
//
// FLAG-GATED at the call site exactly like readWeatherDaily: flag OFF issues ZERO of these
// statements (same executing-test pin; BUG-SEEDEDGATE-001 class). FAIL-CLOSED TO NULL, not to {}:
// an empty object means "the query ran and found no events" (a legitimate fold input), while null
// means "the read failed" — and a fold run against a falsely-empty window would declare every
// planting ~30 demand-days overdue, so the handler degrades the WHOLE RUN to flag-OFF instead
// (canon: every data gap falls back to today's model, never to a wrong model).
//
// The +-1-day margins absorb the date->timestamptz cast landing on the session's (UTC) midnight
// rather than ET midnight; the fold clips precisely to [window start 00:00 ET, effNow] itself.
// Every parameter carries an explicit cast (Neon cannot type a bare bind — same rule as the
// weather_daily writer above).
async function readLedgerEvents(pg, fromDate, toDate) {
  try {
    const { rows } = await pg.query(
      `select e.id, e.plant_id, e.event_type,
              (extract(epoch from e.event_date) * 1000)::float8 as t_ms,
              e.metadata->>'water_depth' as water_depth
         from event_log e
        where e.event_type in ('watering','rain','moisture_check')
          and e.deleted_at is null
          and e.plant_id is not null
          and e.event_date >= ($1::date - interval '1 day')
          and e.event_date <  ($2::date + interval '2 days')
        order by e.event_date, e.id`,
      [fromDate, toDate]);
    const by = {};
    for (const r of rows) {
      (by[r.plant_id] ||= []).push({ id: r.id, t: Number(r.t_ms), type: r.event_type, depth: r.water_depth || null });
    }
    return by;
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'ledger event-window read failed — ledger degrades to flag-OFF this run', error: e?.message }));
    return null;
  }
}

function weatherWindowStart(today, days = WEATHER_DAILY_WINDOW_DAYS) {
  const d = new Date(today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// ── V4-FROST-001 F3 — alert dedup store (§3-5) ────────────────────────────────────────────────────
// Cheapest durable home per §3-5: an additive `alerts_sent` key on the daily-plan items payload that is
// already written per run. No DDL, no PLAN_SCHEMA_VERSION bump (every reader selects named keys), and the
// key is written ONLY when FROST_ALERT_ENABLED is on — so the flag-OFF plan stays byte-identical.
const ALERTS_SENT_MAX = 12;   // one night can legitimately produce advisory + protect + a hard-freeze escalation

// Fail-open, exactly like readPriorRuns: an unreadable dedup store must never block plan generation. The
// failure direction is deliberate — on a read error we return [] and may RE-SEND an alert. A duplicate
// frost SMS is a nuisance; a suppressed one is the failure this feature exists to prevent (§3-7).
async function readAlertsSent(pg, userId, planDate) {
  try {
    const { rows } = await pg.query(
      `select items from daily_plan where user_id = $1 and plan_date = $2`, [userId, planDate]);
    if (!rows.length) return [];
    const prev = (rows[0].items || {}).alerts_sent;
    return Array.isArray(prev) ? prev : [];
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'alerts_sent read failed — continuing (may re-send)', error: e?.message }));
    return [];
  }
}

// SNS Subject is email-only (SMS ignores it) and is capped at 100 ASCII chars with no newlines, so it is
// built separately from the message body rather than sliced off it.
function frostSubject(d) {
  const label = d.tier === 'imminent'
    ? (d.level === 'hard_freeze' ? 'HARD FREEZE tonight' : 'Frost protect tonight')
    : (d.tier === 'advisory' ? 'Frost advisory' : 'Heat advisory');
  const low = d.observability && d.observability.tonightLowF != null ? ` (low ${d.observability.tonightLowF}F)` : '';
  return `Garden alert - ${label}${low}`.replace(/[^\x20-\x7E]/g, '').slice(0, 100);
}

// V4-COVEREDNOTMODELLED-001 phase 2 — COVERAGE INHERITED FROM THE NEAREST STATED ANCESTOR.
//
// Phase 1 (migration v4-loccovered-001 + the `cov` lateral below) made coverage an editable
// locations.covered flag instead of a name match. It left one hole, and it is the hole the row was
// opened about: `covered` is resolved from the planting's OWN location ONLY. locations is a tree
// (parent_id, level 0-3), the POST defaults `covered` to NULL, and NULL falls through to the
// type_label heuristic — so a low tunnel created as a `bed` under Stable resolves EXPOSED, takes
// rain credit for rain the cover sheds, and goes unwatered. All 21 live prod locations were
// backfilled with a stated flag, so nothing in the garden is in that state TODAY; every location
// Dave creates from now on is born into it.
//
// THE REPO HAS NO EXISTING NEAREST-ANCESTOR SCHEME TO HONOUR, and that was checked rather than
// assumed: the only recursive walks over locations.parent_id (events/index.js By-Space scope,
// photos/index.js location gallery) go DOWN as `loc_subtree`, and container_closure is a closure
// table over `container`, a different entity. So this mirrors the established `loc_subtree` idiom
// inverted — same recursive-CTE shape, same `deleted_at IS NULL` filter — rather than introducing
// a second mechanism (a closure table, a materialised path) for one column.
//
// DEPTH BOUND IS LOAD-BEARING, NOT DECORATION. `level` is capped at 3 by the locations POST so a
// real chain is at most 4 rows, but nothing in the schema forbids a parent_id CYCLE, and an
// unbounded recursive CTE over a cycle does not error — it hangs, which on this Lambda means the
// nightly plan never generates. `depth < 4` terminates regardless of the data.
//
// `c.covered is null` in the recursive term stops the walk at the FIRST stated ancestor, which is
// what makes `distinct on (loc_id) ... order by loc_id, depth` the NEAREST one rather than an
// arbitrary one. A location that states its own flag never recurses at all, so it contributes no
// row here and arm 2 of the `cov` lateral continues to answer for it.
//
// STRICTLY BEHIND CARE_COVER_INHERIT_ENABLED, default OFF. Flag off emits the empty string for all
// three fragments, so the plantings SQL is byte-identical to the pre-change text — pinned by
// sha256 in cover-inherit.test.js against a hash captured from the pre-change handler, so the
// no-op claim is executable rather than asserted.
const COVER_INHERIT_CTE = `
    with recursive loc_cover_chain as (
      select l0.id as loc_id, l0.parent_id, l0.covered, 0 as depth
        from locations l0 where l0.deleted_at is null
      union all
      select c.loc_id, a.parent_id, a.covered, c.depth + 1
        from loc_cover_chain c join locations a on a.id = c.parent_id and a.deleted_at is null
       where c.depth < 4 and c.covered is null
    ),
    loc_cover_inherit as (
      select distinct on (loc_id) loc_id, covered from loc_cover_chain
       where depth > 0 and covered is not null order by loc_id, depth
    )`;
const COVER_INHERIT_JOIN = `
    left join loc_cover_inherit cinh on cinh.loc_id = l.id`;
// Sits BELOW the location's own flag and ABOVE the type_label heuristic in the `cov` lateral: an
// explicit answer on the row always beats an inherited one, and an inherited one always beats a
// guess from the label. Documented here and NOT as a `--` comment beside the lateral, deliberately:
// a SQL comment is part of the emitted statement, so it would break the byte-identity the flag-off
// no-op proof rests on (cover-inherit.test.js pins a sha256 of the whole statement).
const COVER_INHERIT_ARM = `
             when cinh.covered is not null                then cinh.covered`;

// V4-WATERMATH-001 F2: `flagOverrides` is the SHADOW/PARITY seam (canon Part 5 "shadow-soak that can
// actually run"). Honored ONLY when this run is DRY — resolveInvokeOptions already refuses to emit
// it otherwise, and the guard below re-checks so no future caller can arm a live A/B through it.
// An env flip arms the LIVE 02:00/12:00/15:30 runs; this is the only safe replay path.
// ── V4-RAINAUTOLOG-001 part 2 — turn yesterday's gauge reading into rain EVENTS ──────────────────
// Every DECISION lives in rainLog.js and is unit-tested without a database; this function is only
// the SQL. Read that file's header before changing anything here — in particular the gauge-only rule
// and the binding prohibition on reward side effects.
//
// FAIL-OPEN, by construction. The daily plan is already durable when this runs, and rain logging is
// a convenience on top of it: a station outage, a schema surprise or a lock must never cost Dave his
// plan. Every exit path logs a structured line with a REASON, because "no rain logged last night"
// and "the rain logger crashed last night" look identical from the outside.
//
// NOT a call to POST /api/events/batch, deliberately — see rainLog.js. The care cache is maintained
// here exactly as the batch path maintains it; XP, streaks, achievements, critters and app_events
// telemetry are NOT fired, because auto-logged rain is not a logging action Dave performed.
async function logRainEvents(pg, { today, dryRun, event, etHour }) {
  const t0 = Date.now();
  const say = (o) => console.log(JSON.stringify({ msg: 'rain-log', today, ...o, ms: Date.now() - t0 }));
  try {
    const decisionRun = resolveRainRun(event, { etHour });
    if (!decisionRun.log) return say({ logged: 0, skipped: decisionRun.reason, slot: decisionRun.slot });

    const day = previousDay(today);
    if (!day) return say({ logged: 0, skipped: 'bad_plan_date' });

    // Gauge-sourced rows only, and ordered so a multi-Space future takes the wettest rather than an
    // arbitrary one. Prod has a single Space today; this is not a guess about which is right for
    // several, it is a deterministic choice so the behaviour is at least reproducible if one appears.
    const { rows: wrows } = await pg.query(
      `select precip_in, precip_source from weather_daily
        where "date" = $1 order by precip_in desc nulls last limit 1`, [day]);
    const d = rainDecision(wrows[0]);
    if (!d.log) return say({ day, logged: 0, skipped: d.reason, amount_in: d.amountIn });

    // ── the once-a-day cap. LOAD-BEARING, not belt-and-braces ──────────────────────────────────
    // resolveRainRun's window is 00:00–05:59 ET and BOTH the nightly (02:00) and intraday-am (05:30)
    // runs fall inside it — rainLog.test.js pins that overlap on purpose. This guard is the only
    // thing standing between Dave's "once a day at most" and two identical fan-outs 3.5 hours apart.
    // It also makes a manual re-run via scripts/rerun-daily-plan.sh safe.
    const { rows: already } = await pg.query(
      `select 1 from event_log
        where event_type = 'rain' and deleted_at is null and event_date::date = $1 limit 1`, [day]);
    if (already.length) return say({ day, logged: 0, skipped: 'already_logged', amount_in: d.amountIn });

    if (dryRun) return say({ day, logged: 0, skipped: 'dry_run', amount_in: d.amountIn, would_log: true });

    // Ownership context for the transfer trigger, same as every other writer.
    await pg.query(`select set_config('app.actor_clerk_sub', $1, true)`, [SYSTEM_ACTOR_FALLBACK]);

    // Column list, join shape and NULL semantics mirror lambda/events/index.js's batch INSERT, and
    // the roof rule mirrors migrations/v4-rainbackfill-001. LEFT JOIN container, never INNER
    // (BUG-LOGMANYPROJECTLESS-001): a project-less planting must still get its row.
    const { rowCount: inserted } = await pg.query(
      `insert into event_log
         (project_id, location_id, plant_id, event_type, event_date, is_public,
          logged_by, created_by, quantity_numeric, metadata, source, notes)
       -- ALIASES ARE gn/ct, NOT p/pp, DELIBERATELY. archived-exclusion.test.js is a source-text guard
       -- that locates the plantings query by grepping this file for the phrase
       --   where p.deleted_at is null and p.archived_at is null
       -- and then asserts what follows it. Written with a p alias, THIS query appears earlier in the
       -- file and the guard latched onto it instead — passing its own vacuity floor while checking
       -- the wrong statement. The guard is correct; this query was shadowing its anchor. Do not
       -- rename these back. (Note also: no backticks anywhere in this block. It lives inside a
       -- template literal, so one would end the string mid-SQL.)
       select ct.id, ct.location_id, gn.id, 'rain', ($1::date + time '12:00')::timestamptz, true,
              gn.created_by, gn.created_by, $2::numeric, $3::jsonb, 'import',
              'Rain recorded by the on-site weather station.'
         from garden_node gn
         left join container ct on ct.id = gn.container_id
        where gn.deleted_at is null and gn.archived_at is null
          and not coalesce((
                with recursive up as (
                  select l.id, l.parent_id, l.covered from locations l
                   where l.id = gn.location_id and l.deleted_at is null
                  union all
                  select l.id, l.parent_id, l.covered from up
                    join locations l on l.id = up.parent_id and l.deleted_at is null
                ) select bool_or(up.covered) from up), false)`,
      [day, d.amountIn, JSON.stringify(rainMetadata(d.amountIn))]);

    // Care cache, FORWARD ONLY (GREATEST), recomputed FROM event_log rather than from the amount
    // above — so it stays correct even if the insert matched fewer rows than expected, and can never
    // walk the cache backwards into V4-CARECACHEUNDO-001's territory.
    //
    // BOTH ARMS, and NEITHER touches next_water_at. entity_memory is keyed plant-first but also
    // carries a project-keyed row, and they are not interchangeable. The first version of this code
    // updated only the plant arm AND set next_water_at on it — wrong twice over, caught by the
    // scheduled gate-invariants sweep (see migrations/v4-rainbackfill-001/0c-cachearms.sql):
    //   * next_water_at is PROJECT-ARM-ONLY and belongs to the daily-plan engine, not to an event
    //     writer. v4-carekey-001 pins plant-row next_water_at at zero.
    //   * the rain rows carry project_id, so every container's latest event moves and its cache row
    //     must move with it, or the cache sits BEHIND the log.
    // UPSERTS, not UPDATEs. A plant or container whose FIRST event is this rain row has no cache row
    // to update, and an UPDATE silently skips it — which is how staging failed
    // post_every_non_deleted_planting_with_events_has_a_cache_row while prod (where every row already
    // existed) stayed green. Shape mirrors the deployed batch writer's two upserts in
    // lambda/events/index.js: ON CONFLICT (plant_id) WHERE plant_id IS NOT NULL, and
    // ON CONFLICT (project_id).
    const { rowCount: cachedPlant } = await pg.query(
      `insert into entity_memory (plant_id, last_event_at, last_watered_at)
       select e.plant_id, max(e.event_date), max(e.event_date)
         from event_log e
        where e.event_type in ('watering','rain') and e.deleted_at is null and e.plant_id is not null
        group by e.plant_id
       on conflict (plant_id) where plant_id is not null do update set
         last_event_at   = greatest(coalesce(entity_memory.last_event_at,   excluded.last_event_at),   excluded.last_event_at),
         last_watered_at = greatest(coalesce(entity_memory.last_watered_at, excluded.last_watered_at), excluded.last_watered_at),
         updated_at      = now()`);

    // BUG-EMPROJGUARD-001: project_id IS NOT NULL in the subquery is load-bearing — a project-less
    // planting would otherwise contribute a ZERO-parent row, violate entity_memory_exactly_one_parent
    // and abort the statement.
    const { rowCount: cachedProject } = await pg.query(
      `insert into entity_memory (project_id, last_event_at, last_watered_at)
       select e.project_id,
              max(e.event_date),
              max(e.event_date) filter (where e.event_type in ('watering','rain'))
         from event_log e
        where e.deleted_at is null and e.project_id is not null
        group by e.project_id
       having max(e.event_date) filter (where e.event_type in ('watering','rain')) is not null
       on conflict (project_id) do update set
         last_event_at   = greatest(coalesce(entity_memory.last_event_at,   excluded.last_event_at),   excluded.last_event_at),
         last_watered_at = greatest(coalesce(entity_memory.last_watered_at, excluded.last_watered_at), excluded.last_watered_at),
         updated_at      = now()`);
    const cached = cachedPlant + cachedProject;

    return say({ day, logged: inserted, cache_rows: cached, amount_in: d.amountIn, slot: decisionRun.slot });
  } catch (e) {
    // Fail-open: log and return. The plan is already written and must not be lost to this.
    console.error(JSON.stringify({ msg: 'rain-log ERROR', today, error: e?.message ?? String(e) }));
    return null;
  }
}

async function run({ pg, today, dryRun = true, geocodeZip, fetchNWS, fetchPrecip, fetchStation, publishAlert, etHour, event, flagOverrides = null }) {
  const _ovr = (dryRun === true && flagOverrides && typeof flagOverrides === 'object') ? flagOverrides : null;
  const _flag = (name, envOn) => (_ovr && typeof _ovr[name] === 'boolean' ? _ovr[name] : envOn);
  if (_ovr) console.log(JSON.stringify({ msg: 'flag-overrides (dry-run shadow)', overrides: _ovr }));
  // DRG-NIGHTLYTIMEOUT-001 — cheap nightly progress markers (db-ready / station-fetched / space-wx)
  // pin the stall site (Neon cold-resume vs fetch hang) in CloudWatch in one night. ms = since run() start.
  const t0 = Date.now();
  // V4-COVEREDNOTMODELLED-001 phase 2 — read here rather than beside the other CARE_* flags below
  // because this one shapes the plantings SELECT itself, which is the first statement of the run.
  // The three fragments are derived from ONE boolean and used in one statement, so no future edit
  // can arm the CTE without the arm that reads it (or vice versa) and emit SQL that references an
  // undefined relation on the nightly run.
  const coverInheritEnabled = _flag('CARE_COVER_INHERIT_ENABLED', process.env.CARE_COVER_INHERIT_ENABLED === 'true');
  const cinhCte = coverInheritEnabled ? COVER_INHERIT_CTE : '';
  const cinhJoin = coverInheritEnabled ? COVER_INHERIT_JOIN : '';
  const cinhArm = coverInheritEnabled ? COVER_INHERIT_ARM : '';
  // active plantings + last water/fert + caretaker + the planting's Space (workspace_id -> spaces).
  const { rows: plantings } = await pg.query(`${cinhCte}
    select p.id, p.name, p.project_id, p.status, p.container_type, p.container_size, p.rain_exposed,
           pv.name as variety, pv.genus, pj.name as project, pj.status as project_status, p.workspace_id,
           -- V4-FROST-001 F2: frost sensitivity is derived from the crop type (frostClass.js), NEVER reused
           -- from engine.coldFor (design G2 — coldFor emits no cold task at all for basil/melon/tomatillo/
           -- bean/cucurbits on a 30°F night). Additive SELECT only: engine.generatePlan copies named keys,
           -- so this never enters the stored plan payload.
           pv.crop_type_slug,
           -- DRG-WATERCREDIT-001 V1: 'covered' (under cover -> no rain credit) is location-derived. It began as
           -- Dave's 2026-06-21 classification hard-coded as a NAME MATCH (the Stable potting shed + the House +
           -- indoor shelves/racks/trays), which meant renaming a location silently reclassified every planting
           -- in it with nothing logged and nothing 500ing.
           -- V4-COVEREDNOTMODELLED-001 built the V1.1 this comment used to promise: an editable
           -- locations.covered flag, backfilled from the name-match so the swap changed no behaviour, so a new
           -- covered spot (a low tunnel, a cold frame) is Dave-settable instead of needing the right name.
           -- DRG-WXCOVERLOC-001: resolved from the PLANTING's own location (see the join below), NOT the
           -- project's — 78/250 active plantings sit in a location different from their project's, so the
           -- project-derived flag mis-credited both directions (11 wrongly covered, 15 wrongly outdoor).
           -- BUG-NOLOCOUTDOOR-001 (2026-08-07): the old form was
           --   coalesce(<predicate>, false) as covered
           -- With no location the left-joined l.* is NULL, the predicate evaluates NULL, and the
           -- coalesce collapsed it to FALSE = OUTDOOR. "I don't know where this is" was rendered as
           -- "it is outside in the rain." No longer hypothetical: a rescue seedling created
           -- 2026-08-07 with no location and no project was in that night's plan as outdoor.
           --
            -- A SINGLE BOOLEAN CANNOT BE FAIL-SAFE HERE, because 'covered' feeds two consumers whose
           -- safe directions are OPPOSITE:
           --   * rain credit + saturation suppression only ever WITHHOLD water. Treating an indoor
           --     plant as outdoor gives it rain it never got -> it goes unwatered -> drought.
           --     Unknown must mean NOT EXPOSED.
           --   * frost alerting only ever SUPPRESSES an alert (frostClass's covered exclusion).
           --     Treating an outdoor plant as covered drops it from the alert -> it freezes.
           --     Unknown must mean NOT COVERED.
           -- So unknown resolves to "no rain credit" AND "still frost-alerted" — which one boolean
           -- cannot express, and which a NULL tri-state would get wrong the moment a consumer used
            -- '?' instead of '=== true' (rainClass did exactly that: NULL is falsy -> 'outdoor').
           --
           -- Expressed once here as a three-state, then split into two plain booleans so no consumer
           -- can mis-handle it. IS TRUE / IS FALSE are deliberately NOT complements over NULL —
           -- that asymmetry IS the fix. For the 248 located plantings both flags are exactly the old
            -- old 'covered' and NOT-covered, so behaviour is unchanged for every row but the un-located.
           --
           -- type_label IS NULL is also unknown, not outdoor: it is the same defect reached through a
           -- populated location (clearing type_label on Shelf 4 would otherwise flip 15 plantings).
           -- V4-COVEREDNOTMODELLED-001 narrowed how far that can reach: l.covered is decisive whenever it
           -- is stated, so type_label only classifies a location created since the migration and left blank.
           --
            -- The three-state is computed ONCE in the cov lateral below and split here, so the two
           -- flags cannot drift apart under a later edit to one of them.
           cov.state as loc_cover_state,
           cov.state is false as rain_exposed_resolved,
           cov.state is true  as frost_covered_resolved,
           coalesce(p.assignee_user_id, pj.assignee_user_id) as assignee_user_id,
           vrc.resolved_profile as db_cadence,  -- CARE-CADENCE-001: system||cultivar||leaf merged cadence (NULL/no-cadence-scope -> engine bundled fallback)
           -- BUG-SEEDEDGATE-001: which scopes supplied a NON-NULL watering interval. [] means nothing
           -- in the DB knows this plant's cadence. NOT resolved_scopes (row-exists), which would adopt
           -- Collards' deliberately watering-free profile and move it 2d -> 3d. REQUIRES
           -- migrations/v4-seededgate-001/0a-view.sql APPLIED: selecting a column that does not exist
           -- throws on the NIGHTLY PLANTING QUERY, i.e. an empty daily plan for both users. Applied to
           -- prod and staging 2026-08-07.
           vrc.cadence_scopes,
           -- Dates returned as 'YYYY-MM-DD' TEXT (UTC): the neon driver hands timestamptz back as JS Date objects, and
           -- engine.daysBetween does iso.slice(0,10) -> a Date object crashes it (TypeError). to_char + AT TIME ZONE 'UTC'
           -- matches the engine's own UTC date math (new Date(iso.slice(0,10)+'T00:00:00Z')). Soft-deleted events excluded.
           to_char((select max(e.event_date) from event_log e where e.plant_id=p.id and e.event_type in ('watering','rain') and e.deleted_at is null) at time zone 'UTC','YYYY-MM-DD') as last_water,
           to_char((select max(e.event_date) from event_log e where e.plant_id=p.id and e.event_type='fertilizing' and e.deleted_at is null) at time zone 'UTC','YYYY-MM-DD') as last_fert,
           -- V4-OVERWINTER-001: the overwintering soil check is satisfied by a moisture_check, not only by
           -- a watering — "I felt it, it is still damp" is the CORRECT answer to a winter check, and
           -- last_water above counts only watering/rain. Without this column the reduced-cadence check
           -- re-cards every night once the interval passes and can never be cleared by the honest answer,
           -- which is the nightly-nag extinction pattern V4-TROPICALCOLD-001 solved for the cold card with
           -- last_brought_inside. Same to_char/UTC shape; engine.overwinter.lastTouch takes the later of
           -- the two as plain 'YYYY-MM-DD' strings.
           to_char((select max(e.event_date) from event_log e where e.plant_id=p.id and e.event_type='moisture_check' and e.deleted_at is null) at time zone 'UTC','YYYY-MM-DD') as last_moisture_check,
           -- V4-OVERWINTERCARDNOISE-001 (1): last_water above deliberately unions 'watering' WITH 'rain',
           -- which is right for an open bed and wrong for every PROTECTED overwintering regime — a low
           -- tunnel, a cold garage and a windowsill are defined by rain NOT reaching them, so a logged
           -- rain event was clearing the very check card the cover makes necessary. This is the same
           -- subquery narrowed to hand watering only; engine.overwinter.lastTouch picks this column
           -- instead of last_water when the regime's rain_counts is false. Same to_char/UTC shape.
           to_char((select max(e.event_date) from event_log e where e.plant_id=p.id and e.event_type='watering' and e.deleted_at is null) at time zone 'UTC','YYYY-MM-DD') as last_hand_water,
           -- V4-TROPICALCOLD-001: the indoors/outdoors toggle engine.coldFor reads to keep the
           -- bring-indoors card a ONE-TIME task instead of a nightly nag. doneEvents retires a cold
           -- task for the calendar day only, so a plant already on the windowsill would otherwise be
           -- re-carded every night under 55F until spring. Same to_char/UTC shape as last_water above,
           -- because the engine compares these two as plain 'YYYY-MM-DD' strings.
           to_char((select max(e.event_date) from event_log e where e.plant_id=p.id and e.event_type='brought_inside' and e.deleted_at is null) at time zone 'UTC','YYYY-MM-DD') as last_brought_inside,
           to_char((select max(e.event_date) from event_log e where e.plant_id=p.id and e.event_type='brought_outside' and e.deleted_at is null) at time zone 'UTC','YYYY-MM-DD') as last_brought_outside,
           -- substrate_start = when the current MG-amended substrate began (the feed-phase clock). NOT a column; derived from the
           -- latest potting_up event, else transplant/plant/created date. engine reads p.substrate_start for feedPhase; without it
           -- every plant -> phase 'unknown' -> zero fert recs (silent dead feature). Validated on prod: 168 active, 28 via potting_up, 0 null.
           to_char(coalesce(
             (select max(e.event_date) from event_log e where e.plant_id=p.id and e.event_type='potting_up' and e.deleted_at is null),
             p.transplanted_at, p.planted_at, p.planted_out_at, p.created_at) at time zone 'UTC','YYYY-MM-DD') as substrate_start,
           -- DRG-WATERCREDIT-002: transplant_at drives the fresh-transplant rain-credit carve-out ONLY.
           -- Real horticultural transplant/potting events ONLY (potting_up event | transplanted_at |
           -- planted_out_at). DELIBERATELY excludes created_at (DB row-creation -> the carve-out bug) and
           -- planted_at (sow date, not a transplant). NULL => established/unknown => NOT carved out => gets
           -- rain credit. Kept separate from substrate_start so the fert feed-phase clock is unchanged.
           to_char(coalesce(
             (select max(e.event_date) from event_log e where e.plant_id=p.id and e.event_type='potting_up' and e.deleted_at is null),
             p.transplanted_at, p.planted_out_at) at time zone 'UTC','YYYY-MM-DD') as transplant_at
    from plants p
    left join plant_varieties pv on pv.id=p.variety_id
    left join plant_projects  pj on pj.id=p.project_id
    -- DRG-WXCOVERLOC-001: the planting's own location wins; fall back to the project's location only when the
    -- planting has none (0/250 active rows today, but plants.location_id is NULLABLE — coalesce keeps an
    -- un-located planting on its pre-fix classification instead of silently reclassifying it as outdoor).
    left join locations       l  on l.id=coalesce(p.location_id, pj.location_id)${cinhJoin}
    -- BUG-NOLOCOUTDOOR-001: the coverage three-state, evaluated once. NULL = unknown, and the two
    -- resolved flags in the SELECT read it with IS FALSE / IS TRUE — deliberately not complements.
    -- V4-COVEREDNOTMODELLED-001: l.covered — the editable flag — WINS, and the name-matching arm it
    -- replaces is GONE. migrations/v4-loccovered-001/0b backfilled every location that existed at
    -- apply time with exactly what the old name-match computed for it, so this returns byte-identical
    -- state for all 21 live prod locations on day one; the only rows that can reach the arms below
    -- are locations created AFTER the apply and not yet stated. Tested with IS NOT NULL and never for
    -- truthiness: covered=false is a real answer (open to the sky), not an absence, and a truthiness
    -- test would drop it through to the type_label heuristic instead of honouring Dave's answer.
    left join lateral (select case
             when l.id is null                            then null
             when l.covered is not null                   then l.covered${cinhArm}
             when l.type_label in ('shelf','rack','tray') then true
             when l.type_label is null                    then null
             else false
           end as state) cov on true
    left join v_resolved_care vrc on vrc.leaf_id = p.id
    where p.deleted_at is null and p.archived_at is null
      and (p.status is null or p.status not in ('ended','failed','dead','archived'))
      and (pj.status is null or pj.status <> 'planning')
      and pj.archived_at is null`);
  console.log(JSON.stringify({ msg: 'db-ready', ms: Date.now() - t0, rows: plantings.length })); // first pool.query done — includes any Neon cold-resume stall
  // V4-ANCHORSUPERSEDE-001. Here rather than at the end of the run: it is one indexed statement, it
  // depends on nothing the run computes, and running it early means a fetch hang later in the night
  // cannot cost the invariant a day. Never throws (see sweepSupersededAnchors).
  if (!dryRun) await sweepSupersededAnchors(pg);
  // V4-ANCHORRESWEEP-001, immediately after and never before: sweepSupersededAnchors retires the
  // derivations a real date has contradicted, so by this line every remaining live derivation belongs
  // to a planting that is still anchorless — which is the population the re-derivation is defined
  // over. The dependency is an ordering nicety rather than a correctness one (the re-derive's own
  // target CTE re-tests all three observed columns, so it stays correct even on a run where the
  // sweep above threw), and it is here for the same reason that one is: it depends on nothing the
  // run computes, so a fetch hang later in the night cannot cost it a day. Never throws.
  if (!dryRun) await sweepRederiveAnchors(pg);
  // Guard: remap System-account assignees -> null so ownerFallback applies (stray-pick guard).
  // Real System/bot account = user_3D7u…; the prior default here (user_3E2x…) is actually Jen in the live
  // Clerk instance and wrongly nulled her assignments. Env override supports a comma-separated list. (DRG-ASSIGN-FIX)
  const SYSTEM_SUBS = new Set(
    (process.env.SYSTEM_CLERK_SUB || 'user_3D7uvqWjyxdq3jgVwTZs0mKT7Xd')
      .split(',').map((s) => s.trim()).filter(Boolean));
  for (const p of plantings) { if (SYSTEM_SUBS.has(p.assignee_user_id)) p.assignee_user_id = null; }
  const { rows: spaces } = await pg.query(`select id, postal_code, weather_lat, weather_lng from spaces`);
  // DRG-WXSTATION-001: one account-level station fetch per run (V200 §3), derived to a normalized reading.
  // fetchStation is fully guarded (returns null on any secret/HTTP/timeout failure) so it can NEVER empty the
  // nightly plan (B6); a null station simply leaves Open-Meteo/NWS as the source.
  const stationRaw = fetchStation ? await fetchStation() : null;
  console.log(JSON.stringify({ msg: 'station-fetched', ms: Date.now() - t0, present: !!stationRaw }));
  const station = deriveStation(stationRaw, { nowMs: Date.now() });
  let boundSpaces = 0;
  // V4-WATERMATH-001 F1 — the ledger flag, read ONCE and used for exactly one thing in F1: whether the
  // weather_daily SELECT happens at all. Default OFF, and OFF is byte-identical — the engine is not
  // wired to this data yet (that is F2), so with the flag off this run issues zero reads against the
  // new relation. The WRITE below is deliberately NOT behind this flag: the substrate has to be
  // accumulating before the fold that consumes it is switched on, which is the entire reason F1 is a
  // separate ship. Mirror any flip in src/lib/featureFlags.js when F2 gives it a client-side meaning.
  const waterLedgerEnabled = _flag('CARE_WATER_LEDGER_ENABLED', process.env.CARE_WATER_LEDGER_ENABLED === 'true');
  // V4-WATERMATH-001 F2 — the fold's per-planting event window, ONE query per run, STRICTLY behind
  // the flag (flag OFF issues zero of these — pinned by an executing test in ledger-run.test.js,
  // same reachability proof as the weather_daily read below). null = read failed -> the generatePlan
  // call passes enabled=false and the whole run degrades to flag-OFF (see readLedgerEvents).
  const ledgerEvents = waterLedgerEnabled ? await readLedgerEvents(pg, weatherWindowStart(today), today) : null;
  // Resolve each Space's weather once (zip-driven). Multi-Space ready: keyed by space id.
  const wxBySpace = {}, hyBySpace = {}, coordsBySpace = {}, stationProvBySpace = {}, wxDailyBySpace = {};
  for (const s of spaces) {
    let wx = await weatherForSpace(s, { geocodeZip, fetchNWS });
    let hy = await hydrologyForSpace(s, { geocodeZip, fetchPrecip });  // assembled BEFORE suggestions
    // Field-granular station merge (B2/B3): station rain overrides recent_precip_in on the hydrology path;
    // station temp calibrates tonightLow on the weather path; forecast fields stay from Open-Meteo/NWS.
    const st = bindStationToSpace(s, station);
    let prov = {};
    if (st) {
      // BUG-RAINACTUAL-001: planDay makes the gauge buckets address the day the PLAN is for, not the day the
      // AWN fetch happened on. Identical in every live run (today === todayET() === the station's civil D0);
      // it is what makes a `--today` replay read the day it is actually replaying.
      const mh = mergeStationHydrology(hy, st, { planDay: today }); hy = mh.merged;
      const mw = mergeStationWeather(wx, st);   wx = mw.merged;
      prov = { ...mh.prov, ...mw.prov };
      boundSpaces++;
    }
    wxBySpace[s.id] = wx;
    hyBySpace[s.id] = hy;
    stationProvBySpace[s.id] = prov;
    coordsBySpace[s.id] = await coordsForSpace(s, { geocodeZip });               // DRG-WXROLL-001: for client live-refresh
    console.log(JSON.stringify({ msg: 'space-wx', space: s.id, ms: Date.now() - t0, wx: !!wx, hy: !!hy }));
    // V4-WATERMATH-001 F1 — persist this Space's completed days, then (ONLY behind the flag) read the
    // fold window back. Order matters: the write goes first so a same-night backfill of a gap is
    // visible to the read in the same run rather than a day later.
    //
    // The write is gated on !dryRun and is non-fatal by construction (writeWeatherDaily never throws),
    // so neither a dry replay nor an unapplied migration can affect anything below this line.
    if (!dryRun) await writeWeatherDaily(pg, s.id, today, hy, prov);
    // FLAG OFF => this expression short-circuits to null and readWeatherDaily is NEVER CALLED, so no
    // statement mentioning weather_daily is ever sent by the read path. That is the seededgate
    // guarantee, and it is pinned by an executing test that counts real queries (weatherdaily.test.js),
    // not by a source assertion — the claim is about reachability, which source text cannot show.
    wxDailyBySpace[s.id] = waterLedgerEnabled
      ? await readWeatherDaily(pg, s.id, weatherWindowStart(today), prevPlanDate(today))
      : null;
  }
  // Group plantings by Space so each gets its own forecast; within a Space, engine splits per caretaker.
  // DRG-WXSTATION-001 observability (V200 §3): one structured line per run — chosen source, recent value,
  // station data-age + freshness/coverage, so a silent fallback is visible in CloudWatch.
  console.log(JSON.stringify({ msg: 'station', present: !!station, boundSpaces,
    mac: station && station.mac, fresh: station && station.fresh, dataAgeMin: station && station.dataAgeMin,
    tempF: station && station.tempF, recentPrecipIn: station && station.recentPrecipIn,
    // BUG-RAINACTUAL-001: the two buckets that now drive today + the yesterday actual, so a wrong number is
    // diagnosable from CloudWatch alone (design §7 — "gauge = truth" must not become "gauge = infallible").
    todayPrecipIn: station && station.todayPrecipIn, yesterdayPrecipIn: station && station.yesterdayPrecipIn,
    planDay: today, stationDay0: station && station.day0, stationHour0: station && station.hour0,
    // H5: which basis produced today_remaining_in, and (on the fallback) why the hourly path was refused.
    // Without this a silent slide back to the whole-day subtraction — the exact defect H5 corrects — would
    // be invisible in CloudWatch.
    remainingBasis: Object.values(stationProvBySpace).map((p) => p && p.today_remaining_basis).filter(Boolean),
    remainingFallback: Object.values(stationProvBySpace).map((p) => p && p.today_remaining_fallback).filter(Boolean),
    coversLookback: station && station.coversLookback, uncertainty: station && station.uncertainty }));
  const owner = process.env.OWNER_FALLBACK_SUB || null;     // unassigned -> Space owner (Dave); NEVER leaks to Jen.
  // DRG-WXWATER-001 coarse-v1: SINGLE flag read-site (spec I2 — plan is computed once nightly, all readers consume
  // the stored plan, so one flag here is inherently consistent). Default OFF; the 3-substrate-tier rain model is
  // inert (byte-identical plan) until CARE_RAIN_CREDIT_ENABLED=true is set after shadow-soak.
  const rainCreditEnabled = _flag('CARE_RAIN_CREDIT_ENABLED', process.env.CARE_RAIN_CREDIT_ENABLED === 'true');
  // DRG-WXFLAGSPLIT-001 F1: the max-days CEILING gets its own flag, split out of CARE_RAIN_CREDIT_ENABLED.
  // Both default OFF, so this ship is inert (byte-identical plan). The split exists so F2 can flip the tiered
  // CREDIT on by itself, with the interval ceiling still off, instead of the two behaviours moving together.
  // Mirror any flip in src/lib/featureFlags.js — the CJS Lambda cannot import that ESM module.
  const rainMaxDaysEnabled = _flag('CARE_RAIN_MAXDAYS_ENABLED', process.env.CARE_RAIN_MAXDAYS_ENABLED === 'true');
  // BUG-TODAYWATER-001: today-forecast suppression. DEFAULT OFF, so this ship is inert (byte-identical
  // plan) until flipped after a dry-run replay. The flag is not ceremony -- it is the rollback path. This
  // Lambda has NO staging surface (deploy-staging.yml's matrix omits daily-plan) and deploy-lambda.yml
  // redeploys all 26 functions from a main SHA, so reverting the code means a promote-gate cycle with Dave
  // approval plus a 26-function redeploy. With the flag, rollback is one update-function-configuration
  // followed by scripts/rerun-daily-plan.sh --live: about two minutes, no promote.
  // Mirror any flip in src/lib/featureFlags.js -- the CJS Lambda cannot import that ESM module.
  const todayAwareEnabled = _flag('CARE_TODAY_AWARE_ENABLED', process.env.CARE_TODAY_AWARE_ENABLED === 'true');
  // BUG-RAINFORECASTCREDIT-001 — rain credit spends MEASURED precipitation only (engine.creditPrecip).
  // Default OFF: absent env => byte-identical plan, so the deploy is inert and the behaviour change is a
  // deliberate flip, not a side effect of shipping. Flipping it makes the engine stop crediting rain that
  // has not fallen, which REDUCES skips -- i.e. it errs toward watering, the fail-safe direction.
  const measuredCreditEnabled = _flag('CARE_RAIN_MEASURED_CREDIT_ENABLED', process.env.CARE_RAIN_MEASURED_CREDIT_ENABLED === 'true');
  // BUG-SEEDEDGATE-001 — structural cadence provenance replaces the in-payload _seeded marker.
  // DEFAULT OFF, and OFF is byte-identical.
  //
  // The flag is applied by NULLING the column on every row rather than by branching in the engine.
  // resolveCadence has FOUR call sites — engine.js coldFor, the water loop, owner grouping, and
  // cadenceTenderFor in this file — and a threaded parameter is one missed site away from the same
  // planting resolving two different ways in one run. Carrying the flag on the DATA makes that
  // structurally impossible.
  //
  // Expected delta on flip, measured on prod 2026-08-07: exactly 6 plantings. Chives 3->4,
  // Garlic Chives 3->4, Christmas Cactus 7->8 (inert, dormant), Echeveria x2 10->12, and Jade Plant
  // 16->12 — the only one that GAINS a task on flip day. Collards stays 2: its cadence_scopes is [].
  // Rollback is one update-function-configuration plus a rerun; no promote needed.
  const cadenceScopesEnabled = _flag('CARE_CADENCE_SCOPES_ENABLED', process.env.CARE_CADENCE_SCOPES_ENABLED === 'true');
  if (!cadenceScopesEnabled) { for (const p of plantings) p.cadence_scopes = null; }
  // Loud, not silent: if the driver ever hands text[] back unparsed, resolveCadence's Array.isArray
  // fails safe to the flag-OFF answer — which is indistinguishable from "the flag did nothing".
  else console.log(JSON.stringify({ msg: 'cadence-scopes', rows: plantings.length,
    arrays: plantings.filter((p) => Array.isArray(p.cadence_scopes)).length,
    bearing: plantings.filter((p) => Array.isArray(p.cadence_scopes) && p.cadence_scopes.length > 0).length }));
  // ── DRG-CADENCEOBS-001 — cadence-floor observability. MEASUREMENT ONLY ──────────────────────────
  // Reads nothing back, writes nothing, mutates nothing, and contributes nothing to the plan payload.
  // The engine already computes _via at four call sites and DISCARDS it at all four; this is the one
  // place that keeps the number. engine.js:81 (the `_via:'default'` fallthrough) hands a planting the
  // house 3-day container cadence with no log, no counter and no flag — 20 of 229 active plantings on
  // prod 2026-08-17, all 20 Dave's, producing 18 of his 194 water_due tasks. Nobody could see that.
  //
  // Zero-behaviour-change BY CONSTRUCTION, not by care: it runs OUTSIDE generatePlan (the plan object
  // is built from explicitly named keys at engine.js:703-711), resolveCadence is pure (every arm
  // returns a fresh spread), and it runs AFTER line 916 so it observes exactly the array generatePlan
  // will receive — this can never disagree with the cadence the run actually applied. The counters are
  // built into local objects; nothing is stamped onto p, because the SAME array is handed to
  // generatePlan AND to frostClass.summarize and a stamped field would travel into both.
  //
  // by_owner mirrors engine.ownerFor (assignee, else the fallback sub; System subs are already nulled
  // at line 809). Pooled-only would go blind to Jen: her 16 rows sit inside Dave's 213, and her 0 %
  // naked-default is a small-sample zero, not a property.
  //
  // no_interval_key counts the SECOND, less obvious entry to the bare 3 (engine.js:489-491): a profile
  // adopted at ANY arm that carries neither *_container nor *_inground falls to cad.default anyway.
  // Zero on prod today; it costs nothing to count and it is the failure mode that would otherwise
  // reappear invisibly (the live system care row expresses its interval under the UNREAD key
  // `water_interval_days`).
  //
  // Not flag-gated, deliberately — the cadence-scopes log above is not either, and a kill switch on a
  // console.log inside a try/catch is ceremony. The try/catch is NOT ceremony: a throw here would empty
  // the nightly plan for both users, which is a failure this file has already suffered once (line 746).
  try {
    const via = {}, nakedIds = [], byOwner = {};
    let noIntervalKey = 0;
    for (const p of plantings) {
      const c = resolveCadence(p, cadence);
      const arm = c && c._via ? String(c._via).split(':')[0] : 'unknown';   // db | variety | genus | default
      const own = (p && p.assignee_user_id) || owner;
      via[arm] = (via[arm] || 0) + 1;
      (byOwner[own] ||= {})[arm] = ((byOwner[own] ||= {})[arm] || 0) + 1;
      if (arm === 'default') nakedIds.push(p.id);
      if (c && c.water_interval_days_container == null && c.water_interval_days_inground == null) noIntervalKey++;
    }
    console.log(JSON.stringify({ msg: 'cadence-fallback', rows: plantings.length, via, by_owner: byOwner,
      naked_default: nakedIds.length, no_interval_key: noIntervalKey, naked_default_ids: nakedIds.slice(0, 50) }));
  } catch (err) {
    console.log(JSON.stringify({ msg: 'cadence-fallback-failed', error: String((err && err.message) || err) }));
  }
  // ── V4-FROST-001 F3 — frost alert channel (design §3, decisions D1–D6) ──────────────────────────
  // F6 kill switch, default OFF. Flag OFF still EVALUATES and LOGS (§3-8 wants the 2026 corpus started
  // before anything reads it) but never publishes and never writes alerts_sent — so the stored plan is
  // byte-identical to pre-frost. Flipping it is the whole of F6.
  const frostAlertEnabled = process.env.FROST_ALERT_ENABLED === 'true';
  // G3: tonightLow means three different nights depending on which run reads it. Only the 15:30 ET
  // intraday-pm run may evaluate. resolveFrostRun is pure; index.js supplies the ET hour.
  const frostRun = resolveFrostRun(event, { etHour });
  const frostSeason = isFrostSeason(today);                       // §3-7 Sep 1 – Nov 15
  // cadence cold.tender is a PROMOTION-ONLY signal into frostClass (it can lift an unknown slug to tender,
  // never override an explicit one) — see frostClass.js for the by_variety['Peach'] pepper/peach-tree collision.
  const cadenceTenderFor = (p) => { const c = resolveCadence(p, cadence); return !!(c && c.cold && c.cold.tender); };
  const frostPublished = new Set();       // one publish per dedup key per invocation, across users
  const frostFailures = [];               // §3-7: collected, then THROWN after the plan is durable
  const plans = [];
  const bySpace = {};
  for (const p of plantings) (bySpace[p.workspace_id] ||= []).push(p);
  for (const [spaceId, rows] of Object.entries(bySpace)) {
    // V4-WATERMATH-001 F2 — the F1 seam is CONSUMED now: weatherDaily + the per-planting event
    // window + the run instant feed the ledger fold, all behind waterLedgerEnabled. enabled is
    // ANDed with `ledgerEvents != null` so a failed event-window read degrades the run to flag-OFF
    // (a fold against a falsely-empty window would over-due every planting — see readLedgerEvents).
    const plan = generatePlan({ plantings: rows, cadence, fertModel, today, weather: wxBySpace[spaceId], hydrology: hyBySpace[spaceId], weatherDaily: wxDailyBySpace[spaceId], ownerFallback: owner, rainCreditEnabled, rainMaxDaysEnabled, todayAwareEnabled, measuredCreditEnabled,
      waterLedgerEnabled: waterLedgerEnabled && ledgerEvents != null, eventsByPlant: ledgerEvents, nowMs: Date.now() });
    // Frost is a SITE-level event (§3-3): evaluated once per Space, then annotated with the affected crop
    // types. D6: one coalesced alert naming every crop type that tripped ITS OWN threshold; plantings
    // already under cover are excluded (frostClass.summarize's covered filter).
    let frostDecision = null;
    if (frostRun.evaluate) {
      const wx = wxBySpace[spaceId] || null;
      const hy = hyBySpace[spaceId] || null;
      const prov = stationProvBySpace[spaceId] || {};
      // BUG-FROSTDORMANT-001: `rows` is the UNFILTERED per-space planting set. generatePlan above
      // drops dormant plantings internally (engine.js:387 — `p.status==='dormant' || c.dormant_skip`
      // then `continue`, before the cold bucket at :493), but that guard lives INSIDE the engine and
      // does not travel with the array. Handing the same `rows` to summarize() let a dormant planting
      // into the frost exposure set and therefore into a real outbound alert (FROST_ALERT_ENABLED is
      // "true" in prod; the topic emails Dave). Dave, 2026-08-10: dormant stock is in temp/humidity-
      // controlled bins and "never need that treatment".
      // Filtered HERE rather than inside summarize() so summarize stays a pure classifier, and built
      // from the engine's own predicate (resolveCadence is already imported for cadenceTenderFor) so
      // the two cannot drift — one `continue` in the engine was the entire defence and a second
      // consumer walked straight past it.
      const careRows = rows.filter(p => {
        const c = resolveCadence(p, cadence);
        return !(p.status === 'dormant' || (c && c.dormant_skip));
      });
      const exposure = summarize(careRows, { cadenceTenderFor });
      frostDecision = frostEval({
        tonightLow: wx ? wx.tonightLow : null,
        highToday: wx ? wx.highToday : null,
        forecastLows: hy ? hy.forecast_lows : null,          // G5 — index.js:fetchPrecip temperature_2m_min
        forecastDates: hy ? hy.forecast_dates : null,
        lowSource: prov.low_source || (wx ? 'forecast' : 'forecast_absent'),
        exposure, spaceId, eventDate: today,
      }, { frostSeason });
      // §3-8 — emitted on EVERY evaluation, alert or not. This log is also the 2026 corpus for the 2027
      // learned microclimate offset (G4): nightly station minimum vs NWS forecast low.
      console.log(JSON.stringify({ msg: 'frost-eval', space: spaceId, plan_date: today, run: frostRun.slot,
        enabled: frostAlertEnabled, dry_run: dryRun, season: frostSeason, alert: frostDecision.alert,
        degraded: frostDecision.degraded, dedup_key: frostDecision.dedupKey, ...frostDecision.observability }));
      // §3-7 loud degradation: inside frost season, a missing tonightLow is NOT "no frost tonight". Silence
      // must never be indistinguishable from safety. Routed to garden-ops-alerts, not the frost topic.
      if (frostDecision.degradedAlert && frostAlertEnabled && !dryRun && publishAlert) {
        const dk = `${spaceId}|${today}|frost_eval_degraded`;
        if (!frostPublished.has(dk)) {
          try {
            // ASCII-only Subject, same constraint frostSubject enforces (SNS rejects non-printable/non-ASCII).
            await publishAlert({ topic: 'ops', subject: 'Garden ops - frost evaluation DEGRADED',
              message: `frost_eval_degraded — no tonight low available for space ${spaceId} on ${today} during frost season. ` +
                'The frost alert could not be evaluated; treat tonight as UNKNOWN, not safe.' });
            frostPublished.add(dk);
          } catch (e) {
            console.error(JSON.stringify({ msg: 'frost degraded-alert publish FAILED', space: spaceId, error: e?.message }));
            frostFailures.push({ kind: 'frost_degraded_publish_failed', spaceId, error: e?.message });
          }
        }
      }
    }
    for (const [user_id, userPlan] of Object.entries(plan.users)) {
      // hydrology rides along for the A0.3-DRY-PLANS dry-replay diff (rerun-daily-plan.sh --diff needs the
      // decision inputs, not just the verdicts). Additive: live-path consumers read res.rows only.
      plans.push({ space_id: spaceId, user_id, plan: userPlan, weather: plan.weather, hydrology: plan.hydrology });
      if (!dryRun) {
        // BUG-TODAYWATER-001 / intraday regeneration — carry a bounded audit trail of what EARLIER runs of
        // the same day believed. The row is upserted on (user_id, plan_date) (there is a UNIQUE index), so
        // without this a re-run silently destroys the snapshot it replaced — and the one question this
        // change makes urgent is exactly "what did the 02:00 run think, and did that forecast arrive?"
        // Deliberately NOT a schema change: kept inside `items` as an additive key, so no DDL, no touching
        // the UNIQUE constraint, no reader impact (every reader selects named keys), and no
        // PLAN_SCHEMA_VERSION bump — that literal is pinned by three readers which deploy in one unordered
        // wave, so bumping it opens a mismatch window. Hydrology + counts only, capped at PRIOR_RUNS_MAX:
        // enough to reconstruct the decision, small enough that a day of re-runs cannot bloat the row.
        const priorRuns = await readPriorRuns(pg, user_id, today);
        // V4-FROST-001 F3 §3-5 — read the dedup store, publish, THEN persist. Publishing before the write
        // is deliberate: recording "sent" for a publish that never happened would silently suppress the
        // real alert on the next pass, which is the exact failure mode §3-7 forbids.
        // Carried forward even on a non-evaluating run so an earlier pm send is never wiped by a re-run.
        let alertsSent = null;
        if (frostAlertEnabled) {
          alertsSent = await readAlertsSent(pg, user_id, today);
          const dk = frostDecision && frostDecision.dedupKey;
          if (frostDecision && frostDecision.alert && dk && !frostPublished.has(dk)
              && !alertsSent.some((a) => a && a.key === dk)) {
            if (!publishAlert) {
              console.warn(JSON.stringify({ msg: 'frost alert SUPPRESSED — no publisher injected', space: spaceId, dedup_key: dk }));
            } else {
              try {
                await publishAlert({ topic: 'frost', subject: frostSubject(frostDecision), message: frostDecision.message });
                frostPublished.add(dk);
                alertsSent = [...alertsSent, { key: dk, tier: frostDecision.tier, level: frostDecision.level, at: new Date().toISOString() }].slice(-ALERTS_SENT_MAX);
                console.log(JSON.stringify({ msg: 'frost alert PUBLISHED', space: spaceId, user: user_id, dedup_key: dk, tier: frostDecision.tier, level: frostDecision.level }));
              } catch (e) {
                // §3-7: a swallowed frost alert is the failure mode this feature exists to prevent. Log at
                // ERROR here, and THROW after the plan writes complete so the invocation is marked failed
                // and the existing garden-daily-plan-errors CloudWatch alarm (Errors > 0 -> garden-alerts)
                // surfaces it. Explicitly NOT continue-on-error, unlike integrity-weekly.
                console.error(JSON.stringify({ msg: 'frost alert publish FAILED', space: spaceId, user: user_id, dedup_key: dk, error: e?.message }));
                frostFailures.push({ kind: 'frost_publish_failed', spaceId, userId: user_id, dedupKey: dk, error: e?.message });
              }
            }
          }
        }
        await pg.query(
          `insert into daily_plan (user_id, plan_date, items, generated_at)
           values ($1,$2,$3, now())
           on conflict (user_id, plan_date) do update set items=excluded.items, generated_at=now()`,
          [user_id, today, JSON.stringify({ schema_version: PLAN_SCHEMA_VERSION, weather: { ...plan.weather, hot: plan.hot }, hydrology: (Object.keys(stationProvBySpace[spaceId] || {}).length ? { ...plan.hydrology, station: stationProvBySpace[spaceId] } : plan.hydrology), coords: coordsBySpace[spaceId] ?? null, substrate: userPlan.substrate, counts: userPlan.counts, prior_runs: priorRuns, ...(alertsSent ? { alerts_sent: alertsSent } : {}), ...userPlan.tasks })]);
        // BUG-TODAYWATER-001: record yesterday's observed rain on yesterday's row. Fail-open (returns
        // false, never throws) and touches ONLY (user_id, prevPlanDate) — today's upsert above is final.
        await backfillYesterdayActual(pg, user_id, today, hyBySpace[spaceId], stationProvBySpace[spaceId]);
      }
    }
  }
  // V4-RAINAUTOLOG-001 part 2. Placed HERE on purpose: after every plan row is durably written, and
  // before the frost throw below, so a rain-log problem can never cost the plan and can never mask
  // a frost publish failure. Fail-open internally; never throws.
  await logRainEvents(pg, { today, dryRun, event, etHour });

  // §3-7 fail LOUD, after every plan row is durably written. The daily plan itself must not be lost to an
  // SNS outage, but the invocation MUST be marked failed so garden-daily-plan-errors pages. Throwing here
  // (rather than at the publish site) is what gets both.
  if (frostFailures.length) {
    const err = new Error(`frost alert publish failed (${frostFailures.length}) — see ERROR logs; the daily plan was written`);
    err.frostFailures = frostFailures;
    throw err;
  }
  return { today, dryRun, rows: plans.length, plans };
}

// A0.2-EVENT-OVERRIDES — invoke-payload parsing for the manual re-run wrapper (scripts/rerun-daily-plan.sh).
// Pure + dependency-free so it is unit-testable (index.js pulls AWS/neon at module load and cannot be).
// SAFETY CONTRACT (fail-safe direction ONLY):
//   * event.dryRun === true (strict boolean) forces a DRY run even when env DRY_RUN=false (prod live).
//   * The event can NEVER force a live run: live writes stay gated solely by env DRY_RUN=false, so the
//     env kill switch (DRY_RUN=true) always wins over any payload — including the wrapper's --live.
//   * event.today overrides the plan date ONLY when it is a strict 'YYYY-MM-DD' string.
//   * event.ping === true -> caller wants a no-op liveness probe (index.handler returns before any
//     secrets/DB/network work).
// EventBridge scheduled events ({source:'aws.events','detail-type':'Scheduled Event',detail:{},...})
// carry none of these keys, so the nightly run's behavior is byte-identical to pre-A0.2.
// V4-WATERMATH-001 F2 (A0.4-FLAG-OVERRIDES) — `event.flagOverrides` lets a replay run the engine
// under a different flag combo, DRY RUNS ONLY. The fail-safe contract extends A0.2's: the payload
// can never change what a LIVE run does. When the resolved run is live, flagOverrides is null no
// matter what the event carried (hard-reject, not best-effort); when dry, only whitelisted flag
// names with strict-boolean values pass through. NEVER an env-based A/B — an env flip arms the live
// EventBridge runs (canon landmine).
// CARE_RAIN_MEASURED_CREDIT_ENABLED added 2026-08-24 (DRG-INTRADAY-002 Track 0). Its read site at
// :939 already went through `_flag`, so the override was honoured everywhere EXCEPT this list — the
// one place that decides whether it arrives. The gap made Track 0 unmeasurable on the only day it
// mattered: the flag flipped live at 13:13Z while the stored plan had been generated 09:30Z, so a
// replay compared two different engines and could not separate intraday freshness from the flip.
// Without this entry the instrument silently answers a different question than the one asked.
const LEDGER_OVERRIDABLE_FLAGS = ['CARE_WATER_LEDGER_ENABLED', 'CARE_RAIN_CREDIT_ENABLED',
  'CARE_RAIN_MAXDAYS_ENABLED', 'CARE_TODAY_AWARE_ENABLED', 'CARE_CADENCE_SCOPES_ENABLED',
  'CARE_RAIN_MEASURED_CREDIT_ENABLED',
  // V4-COVEREDNOTMODELLED-001 phase 2. Listed so the dry-run shadow can A/B the inheritance against
  // live rows before any env flip — the same seam the water-ledger flip was measured through, and
  // the only way to re-run the blast-radius count against real data rather than a fixture.
  'CARE_COVER_INHERIT_ENABLED'];
function resolveInvokeOptions(event, { envDryRun, todayDefault }) {
  const envLive = String(envDryRun ?? 'true').toLowerCase() === 'false';
  const dryRun = (event && event.dryRun === true) ? true : !envLive;
  const today = (event && typeof event.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(event.today))
    ? event.today : todayDefault;
  let flagOverrides = null;
  const fo = event && event.flagOverrides;
  if (dryRun === true && fo && typeof fo === 'object' && !Array.isArray(fo)) {
    for (const k of LEDGER_OVERRIDABLE_FLAGS) {
      if (typeof fo[k] === 'boolean') (flagOverrides ||= {})[k] = fo[k];
    }
  }
  return { dryRun, today, ping: !!(event && event.ping === true), flagOverrides };
}

module.exports = { run, weatherForSpace, hydrologyForSpace, coordsForSpace, resolveInvokeOptions, readPriorRuns, PRIOR_RUNS_MAX, backfillYesterdayActual, prevPlanDate, readAlertsSent, frostSubject, ALERTS_SENT_MAX,
  writeWeatherDaily, readWeatherDaily, weatherWindowStart, WEATHER_DAILY_WINDOW_DAYS,
  readLedgerEvents, LEDGER_OVERRIDABLE_FLAGS, sweepSupersededAnchors,
  COVER_INHERIT_CTE, COVER_INHERIT_JOIN, COVER_INHERIT_ARM,
  sweepRederiveAnchors, REDERIVE_RETIRE_SQL, REDERIVE_INSERT_SQL, REDERIVE_REASON,
  ANCHOR_MODEL_VERSION, REDERIVE_LOG_MAX };
