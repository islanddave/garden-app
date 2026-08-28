#!/usr/bin/env node
// scripts/backfill-weather-daily.mjs
// V4-WATERMATH-001 F1 (W-F2A-WX) — seed public.weather_daily with history from the Open-Meteo ARCHIVE.
// Canon: watering-cadence-math-design-V100-20260812.md Part 4. Migration: migrations/v4-weatherdaily-001.
//
// AUTHORED, NOT RUN. Nothing in this lane executed it against any database.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY A BACKFILL EXISTS AT ALL
//
// The nightly Lambda writer can only ever persist the two completed days its forecast call carries
// (past_days=2 -> D-2 and D-1). From a standing start that means the ledger's 30-day demand window is
// not fully populated until the writer has been live for a month. This script closes that gap in one
// pass so F2 can be soaked against real history instead of waiting out a calendar month, and it
// doubles as the gap-repair tool: it is re-runnable and idempotent, so a stretch of nights where the
// Lambda could not write is fixed by running it again over that range.
//
// It also covers the range the nightly writer STRUCTURALLY CANNOT. Widening past_days on the forecast
// call is not an option — past_days is what sets D0's offset for every positional read in
// lambda/daily-plan/index.js fetchPrecip, and moving it silently shifts the rain window onto the wrong
// day (the exact breakage openmeteo-indices.test.js exists to prevent). A separate endpoint with its
// own date range is the only way to reach further back without touching that indexing.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IT CANNOT RECOVER, AND WHY THAT IS NOT A DEFECT
//
// Every row this script writes is labelled 'openmeteo_archive' on BOTH provenance columns, and it will
// never overwrite a 'gauge_merged' precip value.
//
// ⚠ CORRECTED 2026-08-28 (V4-RAINAUTOLOG-001). This block used to continue: "The on-site WS-2902's
// history is not reachable from here — the AmbientWeather API serves a rolling ~3-day window of
// 5-minute records and nothing older — so for any day older than that, the model figure is genuinely
// the best available number." That is FALSE, and it is why 38 days of real measurements were replaced
// by model estimates on 2026-08-13.
//
// The ~3-day limit is real for RANGE requests — which is what the 2026-08-12 verification below
// tested, a 90-day bulk pull. It does NOT apply to endDate-anchored single fetches:
//     GET /v1/devices/<mac>?endDate=<epoch_ms>&limit=1
// serves the record nearest that instant however far back it is. Querying one day at a time, anchored
// at ET midnight and reading `dailyrainin`, recovered this station's complete daily series back to its
// 2026-07-05 install date — confirmed two ways: it reproduces all 15 existing gauge_merged values
// exactly, and its July daily values sum to exactly the 7.06" the station itself reports for July.
//
// The model figure is therefore NOT the best available number for the pre-gauge-integration period,
// and it under-reads this site materially (2026-08-03: model 1.00" vs gauge 2.22"). Before running
// this script over any window the station was alive for, pull the gauge instead. See
// migrations/v4-rainbackfill-001. What would NOT be honest is letting a re-run of this script
// quietly replace a measured value with an estimate on days the gauge did cover; hence the guard.
//
// Verified against the live endpoint on 2026-08-12 for this Space's coordinates: a 90-day request
// returned 89 days ending at D-2 with ZERO nulls in any of the four fields, and daily_units confirmed
// et0_fao_evapotranspiration = "inch" and temperature_2m_max = "°F" (both honour the unit params, so
// no conversion happens anywhere in this file). The archive lags roughly 2-8 days; the tail it cannot
// reach is exactly the range the nightly writer already covers.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// USAGE (run from garden-app/). DRY BY DEFAULT — it prints what it would write and exits.
//
//   node scripts/backfill-weather-daily.mjs                 # dry, prod, 90 days
//   node scripts/backfill-weather-daily.mjs --days 120      # dry, wider window
//   node scripts/backfill-weather-daily.mjs --staging       # dry, staging
//   node scripts/backfill-weather-daily.mjs --apply         # WRITES to prod
//
// The migration must already be applied to the target, or every upsert fails on a missing relation.

import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// .env.local is parsed, never sourced. The Neon URL contains an unescaped `&` in its query string,
// so `source .env.local` truncates it silently and hands back a URL that connects to the wrong place
// (or nowhere) without an error worth noticing.
function loadEnvLocal() {
  const raw = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
  const out = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const argv = process.argv.slice(2);
const useStaging = argv.includes('--staging');
const apply = argv.includes('--apply');
const daysArg = argv.indexOf('--days');
const DAYS = daysArg > -1 && argv[daysArg + 1] ? Number(argv[daysArg + 1]) : 90;
if (!Number.isFinite(DAYS) || DAYS < 1 || DAYS > 3650) {
  console.error(`FATAL: --days must be 1..3650, got ${argv[daysArg + 1]}`);
  process.exit(1);
}

let url = process.env.TARGET_DB_URL;
let target = 'TARGET_DB_URL (env)';
if (!url) {
  const env = loadEnvLocal();
  url = useStaging ? env.NEON_STAGING_URL : env.NEON_DATABASE_URL;
  target = useStaging ? 'STAGING (NEON_STAGING_URL)' : 'PROD/MAIN (NEON_DATABASE_URL)';
}
if (!url) {
  console.error('FATAL: No DB URL. Set NEON_DATABASE_URL in .env.local, pass --staging, or set TARGET_DB_URL.');
  process.exit(1);
}
const sql = neon(url);

// ET civil day, matching lambda/daily-plan/index.js todayET. The archive is requested in
// timezone=America/New_York so its day labels are already ET civil days; anchoring the range on a UTC
// clock instead would shift the window by a day for five hours out of every twenty-four.
const todayET = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const shiftDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

const SOURCE = 'openmeteo_archive';

// The `daily=` field list is written in THE SAME ORDER as lambda/daily-plan/index.js fetchPrecip's
// list so the two Open-Meteo surfaces can be read against each other without translating. Values are
// nonetheless taken BY NAME and paired with their own d.time[i] entry, never by a positional
// assumption about where D0 sits — this endpoint takes explicit start_date/end_date and has no
// past_days offset at all, so the forecast call's [D-2, D-1, D0, ...] convention does not apply here
// and importing it would be the bug. openmeteo-indices.test.js pins both properties.
async function fetchArchive(lat, lng, startDate, endDate) {
  const url = 'https://archive-api.open-meteo.com/v1/archive'
    + `?latitude=${lat}&longitude=${lng}`
    + `&start_date=${startDate}&end_date=${endDate}`
    + '&daily=precipitation_sum,precipitation_probability_max,temperature_2m_min,et0_fao_evapotranspiration,temperature_2m_max'
    + '&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=America/New_York';
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`archive ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
  const j = await res.json();
  if (j.error) throw new Error(`archive error: ${j.reason || JSON.stringify(j)}`);
  const d = j.daily || {};
  const times = d.time || [];
  return times.map((date, i) => ({
    date,
    et0_in: Number.isFinite(d.et0_fao_evapotranspiration?.[i]) ? round3(d.et0_fao_evapotranspiration[i]) : null,
    tmax_f: Number.isFinite(d.temperature_2m_max?.[i]) ? round2(d.temperature_2m_max[i]) : null,
    tmin_f: Number.isFinite(d.temperature_2m_min?.[i]) ? round2(d.temperature_2m_min[i]) : null,
    // null, NEVER 0 — an absent value must not be recorded as an observed dry day.
    precip_in: Number.isFinite(d.precipitation_sum?.[i]) ? round2(d.precipitation_sum[i]) : null,
  }));
}

const today = todayET();
const endDate = shiftDays(today, -1);        // never today: it is still accumulating
const startDate = shiftDays(today, -DAYS);

console.log(`\n=== weather_daily backfill — ${target} ===`);
console.log(`window   ${startDate} .. ${endDate}  (${DAYS} days back from ${today} ET)`);
console.log(`mode     ${apply ? 'APPLY (writes)' : 'DRY RUN (no writes)'}\n`);

const spaces = await sql`select id, weather_lat, weather_lng, postal_code, name from spaces
                          where weather_lat is not null and weather_lng is not null`;
if (!spaces.length) {
  console.error('FATAL: no Space has cached weather_lat/weather_lng. Run the daily-plan Lambda once to populate them,');
  console.error('       or set them manually — this script deliberately does NOT geocode (a wrong guess would be');
  console.error('       written into 90 rows of history before anyone noticed).');
  process.exit(1);
}

let totalWould = 0, totalWrote = 0, totalSkippedGauge = 0;
for (const s of spaces) {
  const rows = await fetchArchive(s.weather_lat, s.weather_lng, startDate, endDate);
  const usable = rows.filter((r) => r.date && r.date <= endDate
    && (r.et0_in != null || r.precip_in != null || r.tmax_f != null || r.tmin_f != null));
  const nullEt0 = usable.filter((r) => r.et0_in == null).length;
  console.log(`space ${s.id} (${s.name}) @ ${s.weather_lat},${s.weather_lng}`);
  console.log(`  archive returned ${rows.length} days; ${usable.length} usable; ${nullEt0} with null ET0`);
  if (rows.length && rows[rows.length - 1].date < endDate) {
    console.log(`  note: archive tail stops at ${rows[rows.length - 1].date} (endpoint lag) — the nightly writer covers the rest`);
  }

  if (!apply) {
    // Report what already exists so a dry run answers "is this worth running?" rather than just
    // echoing the fetch. The gauge count is the number this script would decline to touch.
    const [existing] = await sql`select count(*)::int as n,
             count(*) filter (where precip_source = 'gauge_merged')::int as gauge
        from weather_daily
       where space_id = ${s.id}::uuid and "date" >= ${startDate}::date and "date" <= ${endDate}::date`;
    console.log(`  existing rows in window: ${existing.n} (${existing.gauge} gauge_merged, which would be preserved)`);
    console.log(`  WOULD UPSERT ${usable.length} rows\n`);
    totalWould += usable.length;
    continue;
  }

  for (const r of usable) {
    // Byte-for-byte the same conflict policy as lambda/daily-plan/handler.js writeWeatherDaily, and
    // it must stay that way: a backfill with a laxer policy than the nightly writer would undo the
    // nightly writer's work every time it ran. COALESCE keeps a value an earlier pass established
    // when this pass has null for it; the CASE arms refuse to downgrade a measured gauge reading to
    // this endpoint's model estimate.
    const out = await sql`
      insert into weather_daily (space_id, "date", et0_in, tmax_f, tmin_f, precip_in, precip_source, et0_source)
      values (${s.id}::uuid, ${r.date}::date, ${r.et0_in}::numeric, ${r.tmax_f}::numeric,
              ${r.tmin_f}::numeric, ${r.precip_in}::numeric,
              ${r.precip_in == null ? null : SOURCE}::text, ${r.et0_in == null ? null : SOURCE}::text)
      on conflict (space_id, "date") do update set
        et0_in    = coalesce(excluded.et0_in,    weather_daily.et0_in),
        tmax_f    = coalesce(excluded.tmax_f,    weather_daily.tmax_f),
        tmin_f    = coalesce(excluded.tmin_f,    weather_daily.tmin_f),
        precip_in = case when weather_daily.precip_source = 'gauge_merged'
                          and coalesce(excluded.precip_source, '') <> 'gauge_merged'
                         then weather_daily.precip_in
                         else coalesce(excluded.precip_in, weather_daily.precip_in) end,
        precip_source = case when weather_daily.precip_source = 'gauge_merged'
                              and coalesce(excluded.precip_source, '') <> 'gauge_merged'
                             then weather_daily.precip_source
                             else coalesce(excluded.precip_source, weather_daily.precip_source) end,
        et0_source = coalesce(excluded.et0_source, weather_daily.et0_source),
        updated_at = now()
      returning precip_source`;
    totalWrote++;
    if (out?.[0]?.precip_source === 'gauge_merged') totalSkippedGauge++;
  }
  console.log(`  upserted ${usable.length} rows\n`);
}

if (apply) {
  console.log(`DONE — ${totalWrote} rows upserted; ${totalSkippedGauge} kept an existing gauge_merged precip value.`);
  console.log('Verify:  bash scripts/psql-ro.sh -c "select precip_source, et0_source, count(*), min(\\"date\\"), max(\\"date\\") from weather_daily group by 1,2 order by 1,2;"');
} else {
  console.log(`DRY RUN COMPLETE — ${totalWould} rows would be upserted. Re-run with --apply to write.`);
}
