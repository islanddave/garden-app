// The use-by window classifier, and the two date primitives it needs.
//
// WHY ITS OWN MODULE. Identical reasoning to daily-plan-read/cue-impression.js: index.js imports
// @neondatabase/serverless, @clerk/backend and @aws-sdk at module scope, so it cannot be IMPORTED
// under the root vitest run at all — every existing test in this directory is a text assertion over
// its source. A text assertion cannot prove a date boundary. BUG-USEBYDAYBOUNDARY-001 shipped and sat
// in prod precisely because the only thing testable about this function was its spelling, so the fix
// is not just the arithmetic below: it is putting the arithmetic somewhere a test can execute it.
//
// Everything here is PURE — `now` is injected, never read from the clock inside. That is the
// src/lib/storageDeadlines.js contract ("todayISO always arrives as an argument. No internal
// new Date()"), and it is what lets useBy.test.js pin a specific instant without faking timers.

// "use soon" occupies the final USE_SOON_FRACTION of the preserved_at→use_by_target span (L6: ~15–20%).
export const USE_SOON_FRACTION = 0.175;

// Every other date in this system is stamped America/New_York (daily-plan/index.js todayET,
// plants/index.js et_today, daily-plan-read/cue-impression.js ET_TZ). One site, one household, one
// zone — restated here rather than imported because the Lambdas are separate module graphs.
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

// Classify a row's freshness against its STORED use_by_target (L6 window, server-side).
// Returns 'past_use_by' | 'use_soon' | 'ok'; null when there is no use_by_target (no expiry).
//
// BUG-USEBYDAYBOUNDARY-001 — WHAT WAS WRONG. `dayMs()` yields a UTC-MIDNIGHT epoch, and the old code
// compared those against `now.getTime()`, a raw INSTANT. Two different coordinate systems, and mixing
// them cost exactly one evening per day: from 20:00 EDT the wall clock is already past UTC midnight
// of the NEXT day, so `nowMs > useBy` went true and every row flipped to `past_use_by` the evening
// BEFORE its date. It is computed server-side and shipped to the client as use_by_status, so it was
// not one device's clock — every viewer saw it, for four hours a night, all year. Same class as the
// known gam-site GMT-session hazard, mirrored.
//
// THE FIX is to make both sides civil days: reduce `now` to its ET calendar day first, then compare
// day against day. It now flips at ET midnight, which is what "past its use-by date" means to someone
// standing at a freezer.
export function classifyUseBy(preservedAt, useByTarget, now = new Date()) {
  if (!useByTarget) return null;
  const useBy = dayMs(useByTarget);
  const today = dayMs(etDay(now));

  // Strictly greater: ON the use-by date the jar is not yet past it.
  if (today > useBy) return 'past_use_by';

  // NO START, NO PROPORTIONAL WINDOW. "Use soon" is the final fraction of the preserved_at→use_by
  // span, and with no start there is no span to take a fraction OF. The old code did not guard this,
  // so `dayMs(null)` fell through to `new Date(null)` — the epoch — making the span ~56 YEARS and
  // putting the threshold a decade before the use-by. Every such row reported `use_soon`, on the
  // Today band. `preserved_at` is NOT NULL today so this is unreachable from the current writer; it
  // stops being unreachable the moment V5-INFLIGHTBATCH-001 gives a row a nullable start. Report only
  // what is knowable: not past yet.
  if (preservedAt == null) return 'ok';

  const preserved = dayMs(preservedAt);
  const span = useBy - preserved;
  if (span <= 0) return 'use_soon'; // degenerate/zero span already at expiry
  const threshold = useBy - span * USE_SOON_FRACTION;
  return today >= threshold ? 'use_soon' : 'ok';
}
