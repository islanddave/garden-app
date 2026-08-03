'use strict';
// DRG-TODAY-001 — overnight Daily Plan generator.
// Pattern mirrors garden-xp-reconcile: EventBridge nightly (midnight ET), DRY_RUN-gated, no Fn URL, kill-switchable.
// Reads Neon (conn from Secrets Manager SECRET_ARN_NEON — NEVER hardcode), resolves weather from each Space's
// postal_code (zip-driven, not hardcoded), runs ./engine per CARETAKER, idempotent upsert into daily_plan.
const { generatePlan, PLAN_SCHEMA_VERSION } = require('./engine');
const { deriveStation, bindStationToSpace, mergeStationHydrology, mergeStationWeather } = require('./station'); // DRG-WXSTATION-001
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

async function run({ pg, today, dryRun = true, geocodeZip, fetchNWS, fetchPrecip, fetchStation }) {
  // DRG-NIGHTLYTIMEOUT-001 — cheap nightly progress markers (db-ready / station-fetched / space-wx)
  // pin the stall site (Neon cold-resume vs fetch hang) in CloudWatch in one night. ms = since run() start.
  const t0 = Date.now();
  // active plantings + last water/fert + caretaker + the planting's Space (workspace_id -> spaces).
  const { rows: plantings } = await pg.query(`
    select p.id, p.name, p.project_id, p.status, p.container_type, p.container_size, p.rain_exposed,
           pv.name as variety, pv.genus, pj.name as project, pj.status as project_status, p.workspace_id,
           -- DRG-WATERCREDIT-001 V1: 'covered' (under cover -> no rain credit) is location-derived from Dave's
           -- classification (2026-06-21): the Stable potting shed + the House + indoor shelves/racks/trays are
           -- covered; all other locations (and no-location) are outdoor. V1.1 replaces this with an editable
           -- locations.covered flag so new indoor spots are Dave-settable, not name-matched here.
           -- DRG-WXCOVERLOC-001: resolved from the PLANTING's own location (see the join below), NOT the
           -- project's — 78/250 active plantings sit in a location different from their project's, so the
           -- project-derived flag mis-credited both directions (11 wrongly covered, 15 wrongly outdoor).
           coalesce(l.type_label in ('shelf','rack','tray') or l.name in ('Stable','House'), false) as covered,
           coalesce(p.assignee_user_id, pj.assignee_user_id) as assignee_user_id,
           vrc.resolved_profile as db_cadence,  -- CARE-CADENCE-001: system||cultivar||leaf merged cadence (NULL/_seeded-absent -> engine bundled fallback)
           -- Dates returned as 'YYYY-MM-DD' TEXT (UTC): the neon driver hands timestamptz back as JS Date objects, and
           -- engine.daysBetween does iso.slice(0,10) -> a Date object crashes it (TypeError). to_char + AT TIME ZONE 'UTC'
           -- matches the engine's own UTC date math (new Date(iso.slice(0,10)+'T00:00:00Z')). Soft-deleted events excluded.
           to_char((select max(e.event_date) from event_log e where e.plant_id=p.id and e.event_type in ('watering','rain') and e.deleted_at is null) at time zone 'UTC','YYYY-MM-DD') as last_water,
           to_char((select max(e.event_date) from event_log e where e.plant_id=p.id and e.event_type='fertilizing' and e.deleted_at is null) at time zone 'UTC','YYYY-MM-DD') as last_fert,
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
    left join locations       l  on l.id=coalesce(p.location_id, pj.location_id)
    left join v_resolved_care vrc on vrc.leaf_id = p.id
    where p.deleted_at is null and p.archived_at is null
      and (p.status is null or p.status not in ('ended','failed','dead','archived'))
      and (pj.status is null or pj.status <> 'planning')
      and pj.archived_at is null`);
  console.log(JSON.stringify({ msg: 'db-ready', ms: Date.now() - t0, rows: plantings.length })); // first pool.query done — includes any Neon cold-resume stall
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
  // Resolve each Space's weather once (zip-driven). Multi-Space ready: keyed by space id.
  const wxBySpace = {}, hyBySpace = {}, coordsBySpace = {}, stationProvBySpace = {};
  for (const s of spaces) {
    let wx = await weatherForSpace(s, { geocodeZip, fetchNWS });
    let hy = await hydrologyForSpace(s, { geocodeZip, fetchPrecip });  // assembled BEFORE suggestions
    // Field-granular station merge (B2/B3): station rain overrides recent_precip_in on the hydrology path;
    // station temp calibrates tonightLow on the weather path; forecast fields stay from Open-Meteo/NWS.
    const st = bindStationToSpace(s, station);
    let prov = {};
    if (st) {
      const mh = mergeStationHydrology(hy, st); hy = mh.merged;
      const mw = mergeStationWeather(wx, st);   wx = mw.merged;
      prov = { ...mh.prov, ...mw.prov };
      boundSpaces++;
    }
    wxBySpace[s.id] = wx;
    hyBySpace[s.id] = hy;
    stationProvBySpace[s.id] = prov;
    coordsBySpace[s.id] = await coordsForSpace(s, { geocodeZip });               // DRG-WXROLL-001: for client live-refresh
    console.log(JSON.stringify({ msg: 'space-wx', space: s.id, ms: Date.now() - t0, wx: !!wx, hy: !!hy }));
  }
  // Group plantings by Space so each gets its own forecast; within a Space, engine splits per caretaker.
  // DRG-WXSTATION-001 observability (V200 §3): one structured line per run — chosen source, recent value,
  // station data-age + freshness/coverage, so a silent fallback is visible in CloudWatch.
  console.log(JSON.stringify({ msg: 'station', present: !!station, boundSpaces,
    mac: station && station.mac, fresh: station && station.fresh, dataAgeMin: station && station.dataAgeMin,
    tempF: station && station.tempF, recentPrecipIn: station && station.recentPrecipIn,
    coversLookback: station && station.coversLookback, uncertainty: station && station.uncertainty }));
  const owner = process.env.OWNER_FALLBACK_SUB || null;     // unassigned -> Space owner (Dave); NEVER leaks to Jen.
  // DRG-WXWATER-001 coarse-v1: SINGLE flag read-site (spec I2 — plan is computed once nightly, all readers consume
  // the stored plan, so one flag here is inherently consistent). Default OFF; the 3-substrate-tier rain model is
  // inert (byte-identical plan) until CARE_RAIN_CREDIT_ENABLED=true is set after shadow-soak.
  const rainCreditEnabled = process.env.CARE_RAIN_CREDIT_ENABLED === 'true';
  // DRG-WXFLAGSPLIT-001 F1: the max-days CEILING gets its own flag, split out of CARE_RAIN_CREDIT_ENABLED.
  // Both default OFF, so this ship is inert (byte-identical plan). The split exists so F2 can flip the tiered
  // CREDIT on by itself, with the interval ceiling still off, instead of the two behaviours moving together.
  // Mirror any flip in src/lib/featureFlags.js — the CJS Lambda cannot import that ESM module.
  const rainMaxDaysEnabled = process.env.CARE_RAIN_MAXDAYS_ENABLED === 'true';
  // BUG-TODAYWATER-001: today-forecast suppression. DEFAULT OFF, so this ship is inert (byte-identical
  // plan) until flipped after a dry-run replay. The flag is not ceremony -- it is the rollback path. This
  // Lambda has NO staging surface (deploy-staging.yml's matrix omits daily-plan) and deploy-lambda.yml
  // redeploys all 26 functions from a main SHA, so reverting the code means a promote-gate cycle with Dave
  // approval plus a 26-function redeploy. With the flag, rollback is one update-function-configuration
  // followed by scripts/rerun-daily-plan.sh --live: about two minutes, no promote.
  // Mirror any flip in src/lib/featureFlags.js -- the CJS Lambda cannot import that ESM module.
  const todayAwareEnabled = process.env.CARE_TODAY_AWARE_ENABLED === 'true';
  const plans = [];
  const bySpace = {};
  for (const p of plantings) (bySpace[p.workspace_id] ||= []).push(p);
  for (const [spaceId, rows] of Object.entries(bySpace)) {
    const plan = generatePlan({ plantings: rows, cadence, fertModel, today, weather: wxBySpace[spaceId], hydrology: hyBySpace[spaceId], ownerFallback: owner, rainCreditEnabled, rainMaxDaysEnabled, todayAwareEnabled });
    for (const [user_id, userPlan] of Object.entries(plan.users)) {
      plans.push({ space_id: spaceId, user_id, plan: userPlan, weather: plan.weather });
      if (!dryRun) {
        await pg.query(
          `insert into daily_plan (user_id, plan_date, items, generated_at)
           values ($1,$2,$3, now())
           on conflict (user_id, plan_date) do update set items=excluded.items, generated_at=now()`,
          [user_id, today, JSON.stringify({ schema_version: PLAN_SCHEMA_VERSION, weather: { ...plan.weather, hot: plan.hot }, hydrology: (Object.keys(stationProvBySpace[spaceId] || {}).length ? { ...plan.hydrology, station: stationProvBySpace[spaceId] } : plan.hydrology), coords: coordsBySpace[spaceId] ?? null, substrate: userPlan.substrate, counts: userPlan.counts, ...userPlan.tasks })]);
      }
    }
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
function resolveInvokeOptions(event, { envDryRun, todayDefault }) {
  const envLive = String(envDryRun ?? 'true').toLowerCase() === 'false';
  const dryRun = (event && event.dryRun === true) ? true : !envLive;
  const today = (event && typeof event.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(event.today))
    ? event.today : todayDefault;
  return { dryRun, today, ping: !!(event && event.ping === true) };
}

module.exports = { run, weatherForSpace, hydrologyForSpace, coordsForSpace, resolveInvokeOptions };
