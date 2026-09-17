// seed-stage-date.js — BUG-SEEDSTAGETZSHIFT-001. What instant a seed-lot stage entry is dated.
//
// WHAT WAS WRONG. SavedSeeds sends a picked calendar day as the zoneless literal `${when}T12:00:00`
// and the /seed-stage CTE cast it `::timestamptz`. A zoneless literal is read in the DB SESSION's
// TimeZone, and on prod that is GMT (measured 2026-09-17: current_setting('TimeZone') = 'GMT', no
// role or database override in pg_db_role_setting). So "Sep 7" landed at 12:00Z — 08:00 EDT, 07:00
// EST — never at the local noon both call sites' comments describe. The intake row SaveSeedSheet
// writes a minute earlier omits entered_at and gets now(), i.e. the real afternoon instant, and the
// log is ordered entered_at DESC. So "save seed, then Move to stored" left `stored` UNDER the intake
// row, and the history panel reported a lot sitting in `stored` as set back behind a newer entry.
// Six live lots entered 2026-09-07 carry it (seven rows: Rosso Sicilian's drying row too).
//
// WHY ITS OWN MODULE. The route's SQL never executes under the unit run — the neon stub records the
// text — so a cast that depends on the session TimeZone can never be tested where it happens. The
// fix is to decide the instant HERE, in pure JS with `now` injected (the useBy.js /
// src/lib/storageDeadlines.js contract), and hand Postgres a Z-suffixed ISO string whose meaning
// does not depend on any session setting.
//
// THE RULE. A day-grained value names a calendar day D in America/New_York, the one site zone
// (useBy.js ET_TZ, daily-plan todayET, plants et_today):
//   • D is TODAY in ET → the request instant. A stage dated today is being entered now; that is the
//     same statement SaveSeedSheet makes by omitting the field, and the same reading the put-up
//     start picker gives its "Today" chip (src/components/kitchen/StartChips.jsx resolveStart: the
//     instant, 'exact'). It is the only rule that sorts a same-day entry after an intake row written
//     at ANY hour, and it is inside D by construction because the day test and the instant come off
//     one clock.
//   • any other D → 12:00 America/New_York on D: 16:00Z under EDT, 17:00Z under EST. Local noon is
//     the anchor src/components/putup/goingNow.js ymdToInstant uses for a picked put-up date, for
//     the reason it gives: noon is the instant furthest from both day boundaries, so no offset and
//     no DST change can move it off D, and elapsed-day counts carry at most half a day of error.
//   • anything else (a full ISO instant from a hand-built POST) → parsed as before and re-emitted in
//     UTC, so the stored instant is the one the future-date check measured.
//
// WHY NOT noon UTC, the events convention (events/validators.js normalizeEventDate). That encoding
// is date-grained by construction and its own consumers say so: harvests/index.js orders a day's
// picks by created_at because event_date "cannot order two picks within a day". This log is ordered
// by entered_at and mixes day-grained rows with now() rows, which is exactly the mix that broke.
//
// KNOWN RESIDUAL: a stage backdated to an EARLIER day that also holds an afternoon intake row still
// sorts under that intake (noon is before 12:28). Rare — a stage move recorded days late but dated
// the intake day — and a later anchor would cost the fermenting warning up to half a day.

export const ET_TZ = 'America/New_York';

const _etDayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

// h23, not hour12:false — the latter can render midnight as "24" on some ICU builds.
const _etWallFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// The ET calendar day of an instant, as YYYY-MM-DD (en-CA yields that shape directly).
export function etDay(d) { return _etDayFmt.format(d); }

// 12:00 wall-clock America/New_York on YYYY-MM-DD, as a Date. Reads the zone's offset at 12:00Z on
// that day and applies it. One pass is exact for this zone: US transitions happen at 02:00 local,
// and 12:00Z is 07:00/08:00 local — already past the switch on both transition days, so the offset
// read there is the offset in force at local noon.
export function etNoon(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const probe = Date.UTC(y, m - 1, d, 12);
  const p = Object.fromEntries(_etWallFmt.formatToParts(new Date(probe)).map(x => [x.type, x.value]));
  const wallAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second));
  return new Date(probe + (probe - wallAsUtc));
}

// The two day-grained wire shapes: a bare date, and the zoneless local-noon literal SavedSeeds sends
// (`T12:00`, optional `:00`, optional zero fraction). A zoneless time OTHER than noon is not a day
// marker, and falls through to the instant parse exactly as it did before this module existed.
const DAY_GRAINED = /^(\d{4})-(\d{2})-(\d{2})(?:T12:00(?::00(?:\.0+)?)?)?$/;

// Returns { at } — a Z-suffixed ISO string, or null when the caller sent nothing (the column default
// now() applies, unchanged) — or { invalid: true }.
export function resolveStageEnteredAt(raw, now = new Date()) {
  if (raw == null) return { at: null };
  const s = String(raw);
  const m = DAY_GRAINED.exec(s);
  if (m) {
    const ymd = `${m[1]}-${m[2]}-${m[3]}`;
    // Round-trip the parts. V8 rolls "2026-02-30" over to March 2 without complaint, and Postgres
    // then refuses the same literal with 22008 — which surfaced as an opaque 500 through the catch.
    const cal = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (Number.isNaN(cal.getTime()) || cal.toISOString().slice(0, 10) !== ymd) return { invalid: true };
    return { at: (ymd === etDay(now) ? now : etNoon(ymd)).toISOString() };
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return { invalid: true };
  return { at: new Date(t).toISOString() };
}
