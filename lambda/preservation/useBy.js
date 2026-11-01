// The use-by window classifier, and the two date primitives it needs.
//
// Its own module because index.js imports neon, clerk and aws at module scope, so it cannot be IMPORTED
// under the root vitest run, and a text assertion over its source cannot prove a date boundary
// (BUG-USEBYDAYBOUNDARY-001 sat in prod because the only testable thing was this function's spelling).
// Everything here is PURE: `now` is injected, never read from the clock (the src/lib/storageDeadlines.js
// contract), so useBy.test.js can pin a specific instant without faking timers.

// "use soon" occupies the final USE_SOON_FRACTION of the preserved_at→use_by_target span (L6: ~15–20%).
export const USE_SOON_FRACTION = 0.175;

// Every other date in this system is stamped America/New_York (daily-plan/index.js todayET, plants/index.js
// et_today, daily-plan-read/cue-impression.js ET_TZ): one site, one household, one zone. Restated here
// because the Lambdas are separate module graphs.
export const ET_TZ = 'America/New_York';

const _etDayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

// The ET calendar day of an instant, as YYYY-MM-DD (en-CA yields that shape directly). Constructed
// once at module scope — building an Intl.DateTimeFormat is the expensive half and this runs per row.
export function etDay(d) { return _etDayFmt.format(d); }

// UTC-midnight epoch ms for a Date OR a YYYY-MM-DD / ISO string. The neon driver returns date and
// timestamptz columns as JS Date objects, so String(v).slice(0,10) is NOT safe — normalize both.
export function dayMs(v) {
  const d = v instanceof Date ? v : new Date(v);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Classify a row's freshness against its STORED use_by_target (L6 window, server-side). Returns
// 'past_use_by' | 'use_soon' | 'ok'; null when there is no use_by_target (no expiry).
//
// Both sides are civil days: `now` is reduced to its ET calendar day first, then compared day against day.
// Comparing dayMs() (a UTC-MIDNIGHT epoch) with a raw instant made every row flip to `past_use_by` from
// 20:00 EDT, the evening BEFORE its date, for every viewer (BUG-USEBYDAYBOUNDARY-001). It now flips at ET
// midnight, which is what "past its use-by date" means at a freezer.
export function classifyUseBy(preservedAt, useByTarget, now = new Date()) {
  if (!useByTarget) return null;
  const useBy = dayMs(useByTarget);
  const today = dayMs(etDay(now));

  // Strictly greater: ON the use-by date the jar is not yet past it.
  if (today > useBy) return 'past_use_by';

  // NO START, NO PROPORTIONAL WINDOW. "Use soon" is the final fraction of the preserved_at->use_by span, and
  // with no start there is no span: dayMs(null) would fall through to the epoch and report `use_soon` for
  // every such row. preserved_at is NOT NULL today, but a nullable start (V5-INFLIGHTBATCH-001) makes this
  // reachable. Report only what is knowable: not past yet.
  if (preservedAt == null) return 'ok';

  const preserved = dayMs(preservedAt);
  const span = useBy - preserved;
  if (span <= 0) return 'use_soon'; // degenerate/zero span already at expiry
  const threshold = useBy - span * USE_SOON_FRACTION;
  return today >= threshold ? 'use_soon' : 'ok';
}
