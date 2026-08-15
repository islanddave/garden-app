// measure-fruiting-tier.mjs — V4-FRUITINGTIER-001. Prices the observed-status tier against LIVE rows
// by running the REAL route query and the REAL resolver, the same way scripts/measure-anchor-
// coverage.mjs prices the derived tier. Nothing here re-implements either: an effect size measured
// by a hand-written copy of the logic measures the copy.
//
// READ-ONLY. Runs one SELECT.
//   DATABASE_URL="$(grep '^NEON_DATABASE_URL=' .env.local | cut -d= -f2-)" \
//   HOUSEHOLD_IDS='user_a,user_b' node scripts/measure-fruiting-tier.mjs
//
// The A/B is `fruitingIntervalDays: 0`, which is exactly what suppresses the anchor in
// availableAnchors (the guard is `days > 0`) — so the OFF arm is the shipped pre-tier behaviour and
// not an approximation of it.
//
// MEASURED 2026-08-14 against prod: 233 rows scanned, 53 carrying a fruiting status, interval
// resolved from the household median (18d over n=39), NET-NEW rows = 2 (Floradade, Yatsufusa).
// San Marzano rescue correctly did NOT appear: its fruiting status was logged 2026-08-13, so its
// watch opens ~18 days later rather than immediately.
import { neon } from '@neondatabase/serverless';
import { queryWatchRows, resolveFruitingInterval } from '../lambda/harvests/watch-route.js';
import { buildWatchList } from '../lambda/harvests/watch.js';

const dsn = process.env.DATABASE_URL;
if (!dsn) { console.error('DATABASE_URL is required (read-only use).'); process.exit(1); }
const household = (process.env.HOUSEHOLD_IDS ?? '').split(',').filter(Boolean);
if (household.length === 0) {
  console.error('HOUSEHOLD_IDS is required (comma-separated Clerk ids).');
  process.exit(1);
}

const sql = neon(dsn);
const rows = await queryWatchRows(sql, household, household[0], process.env.TZ_NAME ?? 'America/New_York');
const fruiting = resolveFruitingInterval(rows);
const etToday = rows[0]?.et_today;

const off = buildWatchList(rows, etToday, { derivedEnabled: true, fruitingIntervalDays: 0 });
const on = buildWatchList(rows, etToday, { derivedEnabled: true, fruitingIntervalDays: fruiting.days });
const seen = new Set(off.candidates.map((c) => c.plant_id));

console.log(JSON.stringify({
  rows_scanned: rows.length,
  rows_with_fruiting_status: rows.filter((r) => r.fruiting_status_date != null).length,
  interval: fruiting,
  candidates_without_tier: off.candidates.length,
  candidates_with_tier: on.candidates.length,
  net_new: on.candidates.filter((c) => !seen.has(c.plant_id)).map((c) => ({ name: c.name, basis: c.basis })),
}, null, 2));
