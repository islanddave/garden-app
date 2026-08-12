#!/usr/bin/env node
// measure-anchor-coverage.mjs — V4-ANCHORBASE-001.
//
// Reads the JSON payload emitted by scripts/measure-anchor-coverage.sql on stdin and runs the REAL
// modules (lambda/harvests/watch.js + anchorDerive.js) over live rows. Nothing here re-implements
// the classifier; that is the entire point. A number in the lane report that this script does not
// print is a number nobody verified.
//
//   cd ~/AI/Claude/Projects/Gardening \
//     && bash scripts/psql-ro.sh -At -f <repo>/scripts/measure-anchor-coverage.sql \
//     | node <repo>/scripts/measure-anchor-coverage.mjs
//
// READ-ONLY end to end: the SQL is SELECT-only and this script writes nothing anywhere.
//
// It reports four configurations so the two levers can be told apart:
//   A  as shipped                     — sibling anchor for all habits, no derived tier
//   B  sibling restricted to single   — the falsified-premise fix alone
//   C  derived anchors admitted       — the backfill alone
//   D  both                           — what the lane actually proposes
//
// Configurations B/C/D are simulated by preparing the ROWS, not by mutating the module: the derived
// tier is fed in as derived_anchor_date exactly as the backfill would persist it, and the sibling
// restriction is applied by clearing sibling_first_pick_date on non-single rows — the same input the
// restricted code path produces. So the numbers hold regardless of how the flags are currently set.

import { buildWatchList, WATCHED_HABITS, SIBLING_ANCHOR_HABITS } from '../lambda/harvests/watch.js';
import {
  deriveAnchor, resolveAddDateOffset, summarizeDerivations, observedAnchorOf,
} from '../lambda/harvests/anchorDerive.js';

const raw = await new Promise((resolve, reject) => {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { buf += c; });
  process.stdin.on('end', () => resolve(buf));
  process.stdin.on('error', reject);
});

const payload = JSON.parse(raw.trim());
const { et_today: etToday, rows, offset_samples: offsetSamples } = payload;
const nurseryOffsetDays = payload.nursery_sample_n >= 5 ? payload.nursery_median_gap : 31;

// The event evidence arrives as flat columns; anchorDerive takes an events array.
const withEvents = rows.map((r) => ({
  ...r,
  events: [
    r.sow_event_date && { event_type: 'sowing', event_date: r.sow_event_date },
    r.transplant_event_date && { event_type: 'transplant', event_date: r.transplant_event_date },
    r.proxy_event_date && { event_type: 'potting_up', event_date: r.proxy_event_date },
  ].filter(Boolean),
}));

const offset = resolveAddDateOffset(offsetSamples ?? []);

// ── Part 1: anchor coverage and what each tier recovers ──────────────────────────────────────────
const census = summarizeDerivations(withEvents, { etToday, offset });
const WATCHED = new Set(['single', 'repeat', 'cut_and_come_again']);
const watchPool = withEvents.filter((r) => WATCHED.has(r.harvest_habit) && Number(r.prior_harvest_count ?? 0) === 0);
const watchCensus = summarizeDerivations(watchPool, { etToday, offset });

const pct = (n, d) => (d === 0 ? '  -  ' : `${((100 * n) / d).toFixed(1).padStart(5)}%`);
const row = (label, n, d) => `  ${label.padEnd(34)} ${String(n).padStart(4)}  ${pct(n, d)}`;

console.log(`\nV4-ANCHORBASE-001 — anchor coverage, live prod ${etToday}`);
console.log('Household = Dave. Jen has zero live plantings, so every figure below is Dave\'s.\n');
console.log(`ALL LIVE PLANTINGS (n=${census.total})`);
console.log(row('already anchored (own date)', census.already_anchored, census.total));
console.log(row('NO usable anchor today', census.total - census.already_anchored, census.total));
const anchorless = census.total - census.already_anchored;
console.log('\n  recovered by tier, of the anchorless:');
console.log(row('tier 1  sow event', census.by_source.sow_event, anchorless));
console.log(row('tier 2  transplant event', census.by_source.transplant_event, anchorless));
console.log(row('tier 2b nursery proxy event', census.by_source.nursery_proxy_event, anchorless));
console.log(row('tier 3  add-date + offset', census.by_source.add_date_baseline, anchorless));
console.log(row('STILL unanchored after all three', census.unrecoverable, anchorless));
console.log(`\n  baseline share of everything recovered: ${(100 * census.baseline_share).toFixed(1)}%`);
console.log(`  offset applied: +${offset.days}d (${offset.source}, n=${offset.sample_n})`);
console.log(`  future baselines clamped to today: ${census.clamped}`);

console.log(`\nWATCH-ELIGIBLE POOL ONLY (watched habit, no pick this season; n=${watchCensus.total})`);
console.log(row('already anchored', watchCensus.already_anchored, watchCensus.total));
console.log(row('anchorless', watchCensus.derivable + watchCensus.unrecoverable, watchCensus.total));
console.log(row('  of which tier 1+2 recover', watchCensus.by_source.sow_event + watchCensus.by_source.transplant_event, watchCensus.total));
console.log(row('  of which tier 2b recovers', watchCensus.by_source.nursery_proxy_event, watchCensus.total));
console.log(row('  of which tier 3 recovers', watchCensus.by_source.add_date_baseline, watchCensus.total));

// ── Part 2: the effect on the watch queue ────────────────────────────────────────────────────────
// Each configuration is a row transform; the classifier is untouched.
const asShipped = (r) => ({ ...r });
const addDerived = (r) => {
  if (observedAnchorOf(r) != null) return { ...r };
  const d = deriveAnchor(r, { etToday, offset });
  return d == null ? { ...r } : { ...r, derived_anchor_date: d.date, derived_anchor_source: d.source, derived_anchor_confidence: d.confidence };
};

// The derived tier is gated in watch.js by DERIVED_ANCHOR_ENABLED. To measure what flipping it would
// do without flipping it, feed the derived date through the calendar path — identical arithmetic
// (anchor date + DTM - lead), which is exactly what the derived branch computes.
const asCalendarFallback = (r) => (
  r.derived_anchor_date == null ? r : { ...r, transplanted_at: r.derived_anchor_date, dtm_basis: 'from-transplant' }
);

// The sibling restriction is priced through the module's own injectable option rather than by
// mangling rows, so config A is the genuinely-shipped behaviour and not a re-implementation of it.
const ALL_HABITS = WATCHED_HABITS;
const configs = [
  ['A  as shipped', (r) => asShipped(r), ALL_HABITS],
  ['B  sibling -> single only', (r) => asShipped(r), SIBLING_ANCHOR_HABITS],
  ['C  + derived anchors', (r) => asCalendarFallback(addDerived(r)), ALL_HABITS],
  ['D  both (this lane)', (r) => asCalendarFallback(addDerived(r)), SIBLING_ANCHOR_HABITS],
];

console.log('\nWATCH QUEUE EFFECT (real classifier, same live rows)\n');
console.log('  config                        total  sibling-anchored  calendar  derived  no_anchor');
for (const [label, fn, siblingHabits] of configs) {
  const { candidates, excluded } = buildWatchList(withEvents.map(fn), etToday, { nurseryOffsetDays, siblingHabits });
  const sib = candidates.filter((c) => c.confidence === 'sibling').length;
  const cal = candidates.filter((c) => c.confidence === 'calendar').length;
  // In configs C/D the derived rows arrive through the calendar path (see asCalendarFallback), so
  // they are counted by their source row rather than by the anchor kind.
  const derivedIds = new Set(withEvents.filter((r) => observedAnchorOf(r) == null && deriveAnchor(r, { etToday, offset }) != null).map((r) => r.plant_id));
  const der = candidates.filter((c) => derivedIds.has(c.plant_id)).length;
  console.log(
    `  ${label.padEnd(28)} ${String(candidates.length).padStart(5)}`
    + `${String(sib).padStart(18)}${String(cal - (label.startsWith('C') || label.startsWith('D') ? der : 0)).padStart(10)}`
    + `${String(label.startsWith('C') || label.startsWith('D') ? der : 0).padStart(9)}`
    + `${String(excluded.no_anchor ?? 0).padStart(11)}`,
  );
}
console.log('');
