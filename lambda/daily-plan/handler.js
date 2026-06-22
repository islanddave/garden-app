'use strict';
// DRG-TODAY-001 — overnight Daily Plan generator (HELD: not yet wired into deploy-lambda.yml's 4 dir lists; AE-050).
// Pattern mirrors garden-xp-reconcile: EventBridge nightly (midnight ET), DRY_RUN-gated, no Fn URL, kill-switchable.
// Reads Neon (conn from Secrets Manager SECRET_ARN_NEON — NEVER hardcode), resolves weather from each Space's
// postal_code (zip-driven, not hardcoded), runs ./engine per CARETAKER, idempotent upsert into daily_plan.
const { generatePlan } = require('./engine');
const cadence = require('./cadence-data-v2.json'); // per-variety research cadence (161). Swap to v_resolved_care once care_profile is seeded (CARE-CADENCE-001).
const fertModel = require('./fertilization-model.json'); // substrate-aware feed model. REQUIRED by engine.generatePlan (it derefs fertModel.water_quality / .amendments_in_inventory); omitting it crashes every run.

// Space-zip -> NWS forecast (low + high). Zip geocoded via cached spaces.weather_lat/lng, else a geocoder.
// All HTTP injected for testability; no network at module load.
async function weatherForSpace(space, { geocodeZip, fetchNWS }) {
  let { weather_lat: lat, weather_lng: lng, postal_code } = space;
  if ((lat == null || lng == null) && postal_code && geocodeZip) {
    const g = await geocodeZip(postal_code);                // e.g. zippopotam: 01341 -> {lat,lng}; cache back to spaces
    lat = g.lat; lng = g.lng;
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
  if ((lat == null || lng == null) && postal_code && geocodeZip) { const g = await geocodeZip(postal_code); lat = g.lat; lng = g.lng; }
  if (lat == null || lng == null || !fetchPrecip) return null;
  // fetchPrecip(lat,lng) -> { recent_precip_in (D-2+D-1 actual), upcoming_precip_in (D1+D2),
  //                           tomorrow_precip_in, tomorrow_pop }
  return fetchPrecip(lat, lng);
}

async function run({ pg, today, dryRun = true, geocodeZip, fetchNWS, fetchPrecip }) {
  // active plantings + last water/fert + caretaker + the planting's Space (workspace_id -> spaces).
  const { rows: plantings } = await pg.query(`
    select p.id, p.name, p.project_id, p.status, p.container_type, p.container_size,
           pv.name as variety, pv.genus, pj.name as project, pj.status as project_status, p.workspace_id,
           -- DRG-WATERCREDIT-001 V1: 'covered' (under cover -> no rain credit) is location-derived from Dave's
           -- classification (2026-06-21): the Stable potting shed + the House + indoor shelves/racks/trays are
           -- covered; all other locations (and no-location) are outdoor. V1.1 replaces this with an editable
           -- locations.covered flag so new indoor spots are Dave-settable, not name-matched here.
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
             p.transplanted_at, p.planted_at, p.planted_out_at, p.created_at) at time zone 'UTC','YYYY-MM-DD') as substrate_start
    from plants p
    left join plant_varieties pv on pv.id=p.variety_id
    left join plant_projects  pj on pj.id=p.project_id
    left join locations       l  on l.id=pj.location_id
    left join v_resolved_care vrc on vrc.leaf_id = p.id
    where p.deleted_at is null and p.archived_at is null
      and (p.status is null or p.status not in ('ended','failed','dead','archived','harvested'))
      and (pj.status is null or pj.status <> 'planning')
      and pj.archived_at is null`);
  // Guard: remap System-account assignees -> null so ownerFallback applies (stray-pick guard).
  // Real System/bot account = user_3D7u…; the prior default here (user_3E2x…) is actually Jen in the live
  // Clerk instance and wrongly nulled her assignments. Env override supports a comma-separated list. (DRG-ASSIGN-FIX)
  const SYSTEM_SUBS = new Set(
    (process.env.SYSTEM_CLERK_SUB || 'user_3D7uvqWjyxdq3jgVwTZs0mKT7Xd')
      .split(',').map((s) => s.trim()).filter(Boolean));
  for (const p of plantings) { if (SYSTEM_SUBS.has(p.assignee_user_id)) p.assignee_user_id = null; }
  const { rows: spaces } = await pg.query(`select id, postal_code, weather_lat, weather_lng from spaces`);
  // Resolve each Space's weather once (zip-driven). Multi-Space ready: keyed by space id.
  const wxBySpace = {}, hyBySpace = {};
  for (const s of spaces) {
    wxBySpace[s.id] = await weatherForSpace(s, { geocodeZip, fetchNWS });
    hyBySpace[s.id] = await hydrologyForSpace(s, { geocodeZip, fetchPrecip });  // assembled BEFORE suggestions
  }
  // Group plantings by Space so each gets its own forecast; within a Space, engine splits per caretaker.
  const owner = process.env.OWNER_FALLBACK_SUB || null;     // unassigned -> Space owner (Dave); NEVER leaks to Jen.
  const plans = [];
  const bySpace = {};
  for (const p of plantings) (bySpace[p.workspace_id] ||= []).push(p);
  for (const [spaceId, rows] of Object.entries(bySpace)) {
    const plan = generatePlan({ plantings: rows, cadence, fertModel, today, weather: wxBySpace[spaceId], hydrology: hyBySpace[spaceId], ownerFallback: owner });
    for (const [user_id, userPlan] of Object.entries(plan.users)) {
      plans.push({ space_id: spaceId, user_id, plan: userPlan, weather: plan.weather });
      if (!dryRun) {
        await pg.query(
          `insert into daily_plan (user_id, plan_date, items, generated_at)
           values ($1,$2,$3, now())
           on conflict (user_id, plan_date) do update set items=excluded.items, generated_at=now()`,
          [user_id, today, JSON.stringify({ weather: { ...plan.weather, hot: plan.hot }, hydrology: plan.hydrology, substrate: userPlan.substrate, counts: userPlan.counts, ...userPlan.tasks })]);
      }
    }
  }
  return { today, dryRun, rows: plans.length, plans };
}
module.exports = { run, weatherForSpace, hydrologyForSpace };
