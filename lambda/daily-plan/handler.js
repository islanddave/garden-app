'use strict';
// DRG-TODAY-001 — overnight Daily Plan generator.
// Pattern mirrors garden-xp-reconcile: EventBridge nightly (midnight ET), DRY_RUN-gated, no Fn URL, kill-switchable.
// Reads Neon (conn from Secrets Manager SECRET_ARN_NEON — NEVER hardcode), resolves weather from each Space's
// postal_code (zip-driven, not hardcoded), runs ./engine per CARETAKER, idempotent upsert into daily_plan.
const { generatePlan, PLAN_SCHEMA_VERSION, resolveCadence } = require('./engine');
const { deriveStation, bindStationToSpace, mergeStationHydrology, mergeStationWeather } = require('./station'); // DRG-WXSTATION-001
const { summarize } = require('./frostClass');                                   // V4-FROST-001 F2 (D6 per-crop bands)
const { frostEval, isFrostSeason, resolveFrostRun } = require('./frostEval');    // V4-FROST-001 F1/F3
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

async function run({ pg, today, dryRun = true, geocodeZip, fetchNWS, fetchPrecip, fetchStation, publishAlert, etHour, event }) {
  // DRG-NIGHTLYTIMEOUT-001 — cheap nightly progress markers (db-ready / station-fetched / space-wx)
  // pin the stall site (Neon cold-resume vs fetch hang) in CloudWatch in one night. ms = since run() start.
  const t0 = Date.now();
  // active plantings + last water/fert + caretaker + the planting's Space (workspace_id -> spaces).
  const { rows: plantings } = await pg.query(`
    select p.id, p.name, p.project_id, p.status, p.container_type, p.container_size, p.rain_exposed,
           pv.name as variety, pv.genus, pj.name as project, pj.status as project_status, p.workspace_id,
           -- V4-FROST-001 F2: frost sensitivity is derived from the crop type (frostClass.js), NEVER reused
           -- from engine.coldFor (design G2 — coldFor emits no cold task at all for basil/melon/tomatillo/
           -- bean/cucurbits on a 30°F night). Additive SELECT only: engine.generatePlan copies named keys,
           -- so this never enters the stored plan payload.
           pv.crop_type_slug,
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
    planDay: today, stationDay0: station && station.day0,
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
    const plan = generatePlan({ plantings: rows, cadence, fertModel, today, weather: wxBySpace[spaceId], hydrology: hyBySpace[spaceId], ownerFallback: owner, rainCreditEnabled, rainMaxDaysEnabled, todayAwareEnabled });
    // Frost is a SITE-level event (§3-3): evaluated once per Space, then annotated with the affected crop
    // types. D6: one coalesced alert naming every crop type that tripped ITS OWN threshold; plantings
    // already under cover are excluded (frostClass.summarize's covered filter).
    let frostDecision = null;
    if (frostRun.evaluate) {
      const wx = wxBySpace[spaceId] || null;
      const hy = hyBySpace[spaceId] || null;
      const prov = stationProvBySpace[spaceId] || {};
      const exposure = summarize(rows, { cadenceTenderFor });
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
function resolveInvokeOptions(event, { envDryRun, todayDefault }) {
  const envLive = String(envDryRun ?? 'true').toLowerCase() === 'false';
  const dryRun = (event && event.dryRun === true) ? true : !envLive;
  const today = (event && typeof event.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(event.today))
    ? event.today : todayDefault;
  return { dryRun, today, ping: !!(event && event.ping === true) };
}

module.exports = { run, weatherForSpace, hydrologyForSpace, coordsForSpace, resolveInvokeOptions, readPriorRuns, PRIOR_RUNS_MAX, backfillYesterdayActual, prevPlanDate, readAlertsSent, frostSubject, ALERTS_SENT_MAX };
