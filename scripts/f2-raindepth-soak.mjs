// DRG-RAINDEPTH-001 local shadow soak. Runs handler.run() TWICE against LIVE PROD data — flag-OFF
// (today's shipped behavior) vs flag-ON (the F2 ledger with the depth-mapped rain model) — and
// diffs the per-planting water verdicts. Zero-write: both arms are dryRun.
//
// Why local rather than scripts/f2-shadow-soak.sh: that wrapper invokes the DEPLOYED zip, which does
// not carry this change. Same comparison, same real data, no deploy.
//
// Weather is STUBBED to the values the live 15:30 ET run reported today (2026-08-17) so both arms
// see identical hydrology and the diff isolates the ledger. weather_daily (the 30-day precip window
// the depth model actually folds) is read live from the DB, unstubbed.
//
// YOU MUST EXPORT THE PROD ENGINE FLAGS or the flag-OFF arm is not the shipped baseline — without
// CARE_RAIN_CREDIT_ENABLED the legacy arm silently falls back to the untiered rainCreditDays() and
// reports rain_skipped: 0. Validate the baseline by checking counts_off against a live
// `aws lambda invoke garden-daily-plan '{"dryRun":true}'` before trusting any delta.
//
//   npm install --prefix lambda/daily-plan --no-save --legacy-peer-deps
//   CARE_CADENCE_SCOPES_ENABLED=true CARE_RAIN_CREDIT_ENABLED=true CARE_TODAY_AWARE_ENABLED=true \
//   FROST_ALERT_ENABLED=true OWNER_FALLBACK_SUB=<sub> SYSTEM_CLERK_SUB=<sub> \
//   ENV_FILE=<path/to/.env.local> TODAY=YYYY-MM-DD OUT=summary.json [OUT2=explain.json] \
//   [OUT3=detail.json EXPLAIN_IDS=<uuid,uuid>] node scripts/f2-raindepth-soak.mjs
// Resolved from the Lambda's OWN dependency tree (npm install --prefix lambda/daily-plan --no-save)
// — @neondatabase/serverless is a Lambda dep, not a root one.
import { Pool, neonConfig } from '../lambda/daily-plan/node_modules/@neondatabase/serverless/index.mjs';
import ws from '../lambda/daily-plan/node_modules/ws/index.js';
import { readFileSync, writeFileSync } from 'node:fs';
import handler from '../lambda/daily-plan/handler.js';

neonConfig.webSocketConstructor = ws;

const DSN = readFileSync(process.env.ENV_FILE, 'utf8')
  .split('\n').find((l) => l.startsWith('NEON_DATABASE_URL='))
  .slice('NEON_DATABASE_URL='.length).replace(/^"|"$/g, '').trim();

const HYDROLOGY = {
  recent_precip_in: 0, today_precip_in: 0.21, today_pop: 35,
  upcoming_precip_in: 0.33, tomorrow_precip_in: 0.33, tomorrow_pop: 6,
  today_observed_in: 0.21, today_remaining_in: 0,
};
const NWS = { tonightLow: 65, highToday: 77, code: 51, short: 'Patchy Fog', unit: 'F' };

const inject = {
  geocodeZip: async () => ({ lat: 42.51, lng: -72.70 }),
  fetchNWS: async () => NWS,
  fetchPrecip: async () => ({ ...HYDROLOGY }),
  fetchStation: async () => null,      // hydrology above is already the gauge-merged result
  publishAlert: async () => {},
  etHour: 15,
};

async function arm(flagOverrides) {
  const pool = new Pool({ connectionString: DSN });
  try {
    return await handler.run({ pg: pool, today: process.env.TODAY, dryRun: true, flagOverrides, ...inject });
  } finally { await pool.end().catch(() => {}); }
}

// plan.tasks is a BUCKET MAP (water_due / rain_skipped / no_history / ...), not a flat list.
// -> Map(planting id -> overdue_by) over the water_due bucket only; rain_skipped is "not due".
function verdicts(res) {
  const out = new Map();
  for (const p of res.plans || []) {
    for (const t of p.plan?.tasks?.water_due || []) out.set(t.id, t.overdue_by ?? null);
  }
  return out;
}
// Every planting the run considered for water, in ANY bucket — the denominator.
function considered(res) {
  const out = new Set();
  for (const p of res.plans || []) {
    for (const b of ['water_due', 'rain_skipped', 'no_history']) {
      for (const t of p.plan?.tasks?.[b] || []) out.add(t.id);
    }
  }
  return out;
}

const off = await arm(null);
const on = await arm({ CARE_WATER_LEDGER_ENABLED: true });

const vOff = verdicts(off);
const vOn = verdicts(on);
const ids = new Set([...considered(off), ...considered(on)]);

const droppedOff = [], addedOn = [], moved = [];
for (const id of ids) {
  const a = vOff.has(id), b = vOn.has(id);
  if (a && !b) droppedOff.push(id);
  else if (!a && b) addedOn.push(id);
  else if (a && b && vOff.get(id) !== vOn.get(id)) moved.push([id, vOff.get(id), vOn.get(id)]);
}

// run() console.logs to STDOUT, so the report goes to a FILE (process.env.OUT) — never mix them.
const countsOf = (res) => (res.plans || []).map((p) => p.plan?.counts).filter(Boolean);
const report = JSON.stringify({
  today: process.env.TODAY,
  counts_off: countsOf(off), counts_on: countsOf(on),
  due_off: vOff.size, due_on: vOn.size,
  identical: ids.size - droppedOff.length - addedOn.length,
  flips_no_longer_due: droppedOff.length, flips_newly_due: addedOn.length,
  overdue_shifted: moved.length,
  sample_no_longer_due: droppedOff.slice(0, 12),
  sample_newly_due: addedOn.slice(0, 12),
  sample_overdue_shifted: moved.slice(0, 12),
}, null, 1);
writeFileSync(process.env.OUT, report);

// Explainability: are the newly-due plantings the ones the legacy cliff over-credited (i.e. sat in
// its rain_skipped bucket on a 0.21" day that bought a full tier hold)?
if (process.env.OUT2) {
  const rainSkippedOff = new Set();
  for (const p of off.plans || []) for (const t of p.plan?.tasks?.rain_skipped || []) rainSkippedOff.add(t.id);
  writeFileSync(process.env.OUT2, JSON.stringify({
    rain_skipped_off: [...rainSkippedOff].length,
    newly_due_that_were_rain_skipped: addedOn.filter((id) => rainSkippedOff.has(id)).length,
    newly_due_unexplained: addedOn.filter((id) => !rainSkippedOff.has(id)),
    rain_skipped_now_still_not_due: [...rainSkippedOff].filter((id) => !vOn.has(id)).length,
  }, null, 1));
}

// Per-planting ledger detail for named ids (explainability of individual flips).
if (process.env.EXPLAIN_IDS) {
  const want = new Set(process.env.EXPLAIN_IDS.split(','));
  const rows = [];
  for (const p of on.plans || []) {
    for (const b of ['water_due', 'rain_skipped', 'no_history']) {
      for (const t of p.plan?.tasks?.[b] || []) {
        if (want.has(t.id)) rows.push({ bucket: b, id: t.id, name: t.name, days_since: t.days_since,
          interval: t.interval, overdue_by: t.overdue_by, d: t.d, confidence: t.confidence, ledger: t.ledger });
      }
    }
  }
  writeFileSync(process.env.OUT3, JSON.stringify(rows, null, 1));
}
