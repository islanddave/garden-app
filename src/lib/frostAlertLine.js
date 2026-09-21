// src/lib/frostAlertLine.js — BUG-FROSTALERTNOAPP-001.
//
// Words the frost ADVISORY that the daily-plan engine already sent by SNS, for rendering on Today.
// Pure: no fetch, no clock, no DOM. Mirrors the vocabulary of the SNS text (frostEval
// advisoryMessage) so the message Dave gets on his phone and the line he sees in the app cannot
// drift into describing the same night two ways.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// IT RENDERS THE ADVISORY TIER ONLY, AND THE EXCLUSIONS ARE MEASURED, NOT TASTE.
//
// Today already has a frost surface: WeatherCueLine renders computeCallout's `freeze` cue at
// `tonightLow < 40` and `cold` at `< 45`. So the naive reading of this bug — "frost alerts are
// invisible in the app" — is FALSE for tonight, and shipping a second tonight-line would be pure
// duplication in a slot whose own header warns that a third warn-family item turns the other two
// into wallpaper.
//
// What has NO surface is the LEAD TIME. frostEval's evalAdvisory scans the D1..D3 forecast window
// (Open-Meteo) and picks the coldest civil day in it; the engine's cue keys on the NWS plan low alone.
// (V5-FROSTTWOMODELS-001: on a night THIS line names as tonight, Today re-keys the card and a
// freeze/cold cue on the colder of the two lows — see src/lib/tonightLow.js.)
//
// BUG-FROSTADVISORYNIGHTWORDING-001 — an advisory CAN refer to tonight, and usually does when it picks
// D1. `dayOffset` (i + 1) is the CIVIL DAY of the minimum, and at this site 78% of cold minima fall
// before noon, i.e. at the end of the night that starts THIS evening. The line used to word the night
// from dayOffset and so named most nights one day late ("tomorrow night" for tonight). It now words the
// night the SNS text named, from `nightOffset` on the entry. (The 2026-09-07 row once cited here as a
// <= 40F night the cue missed was the F5 rehearsal: ADVISORY_LOW_F raised to 58, run "forced".)
//
//   - imminent  -> skipped. Fires at <= 38F, and 38 < 40, so the freeze cue ALWAYS covers it.
//   - heat      -> skipped. computeCallout renders `high >= 88` already.
//   - advisory  -> rendered, tonight included: its figure is a second model's, and it is the one
//                  Dave was texted about. When it names tonight, Today prints ONE low for the night
//                  on the card, the cue and this line — the colder of this figure and the plan low
//                  (V5-FROSTTWOMODELS-001, src/lib/tonightLow.js) — so this line's number can be the
//                  plan's. Any other night keeps this line's own figure.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// AN ENTRY WITHOUT A TEMPERATURE RENDERS NOTHING, DELIBERATELY.
//
// Entries written before the handler persisted the weather facts carry key/tier/level/at only — 66
// such rows existed in prod when this was written. A line built from those could say no more than
// "an advisory was sent at 11:27pm", which raises the question it cannot answer and is worse than
// silence on a screen whose whole discipline is that silence means something. So: no lowF, no line.
// Those rows age out on their own; nothing needs backfilling.

const SEVERITY = { advisory: 1 };

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE NIGHT — the same rule as frostEval (advisoryNight + nightPhrase), from the fields the handler
// persists. lambda/daily-plan/advisorynight.test.js drives both halves with one input and holds them
// to the same words.
//   nightOffset  0 = tonight, 1 = tomorrow night, 2+ = the weekday the night STARTS on.
//   absent       an entry written before the field existed: the base rate, the night that ENDED on the
//                minimum's morning (dayOffset - 1). It errs a night early, never late.
// Dates are YYYY-MM-DD labels, shifted and read in UTC from a UTC anchor: the phone's zone and DST
// cannot move them, and no clock is read.
const YMD = /^\d{4}-\d{2}-\d{2}$/
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const intOrNull = (v) => {
  if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '')) return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function shiftYmd(ymd, n) {
  if (typeof ymd !== 'string' || !YMD.test(ymd) || !Number.isInteger(n)) return null
  const [y, m, d] = ymd.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d + n))
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10)
}

function weekdayOf(ymd) {
  if (typeof ymd !== 'string' || !YMD.test(ymd)) return null
  const [y, m, d] = ymd.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d))
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null
  return WEEKDAYS[at.getUTCDay()]
}

// -> { nightOffset, nightDate } or null. nightDate is derived from the minimum's civil date: the plan
// date is `date - dayOffset`, so the night starting `nightOffset` days after it is date + (n - dayOffset).
export function resolveNight(a) {
  if (!a) return null
  const day = intOrNull(a.dayOffset)
  const n = intOrNull(a.nightOffset)
  if (n != null && n >= 0) {
    return { nightOffset: n, nightDate: day != null && day >= 1 ? shiftYmd(a.date, n - day) : null }
  }
  if (day == null || day < 1) return null
  return { nightOffset: day - 1, nightDate: shiftYmd(a.date, -1) }
}

// "tonight" / "tomorrow night" / "Sunday night" — frostEval nightPhrase, word for word.
export function nightPhrase(night) {
  if (!night || !Number.isInteger(night.nightOffset) || night.nightOffset < 0) return null
  if (night.nightOffset === 0) return 'tonight'
  if (night.nightOffset === 1) return 'tomorrow night'
  const wd = weekdayOf(night.nightDate)
  return wd ? `${wd} night` : `in ${night.nightOffset} days`
}

// Picks the alert to render, or null. Most severe wins; among equals the most recently SENT wins,
// because a re-send inside one night is an escalation, not a repeat (handler carries prior sends
// forward rather than replacing them, so the array is append-ordered but `at` is authoritative).
// BUG-FROSTREHEARSALSWALLOWS-001 — a send made by a FORCED run (`run: 'forced'`, a rehearsal whose trip
// points may be raised) is never a real alert, so it never renders and never outranks a real one. The
// server's "already sent?" gates skip the same entries (lambda/daily-plan/frostEval.js countsAsSent;
// frostrehearsal.test.js holds the two together). An entry with no `run` predates the field and counts.
export function pickAdvisory(alertsSent) {
  if (!Array.isArray(alertsSent)) return null
  let best = null
  for (const a of alertsSent) {
    if (!a || a.run === 'forced' || SEVERITY[a.tier] == null) continue
    if (a.lowF == null || !Number.isFinite(Number(a.lowF))) continue
    if (nightPhrase(resolveNight(a)) == null) continue
    if (best == null) { best = a; continue }
    const s = SEVERITY[a.tier] - SEVERITY[best.tier]
    if (s > 0) { best = a; continue }
    if (s === 0 && String(a.at || '') > String(best.at || '')) best = a
  }
  return best
}

// -> { text, tier, dayOffset, nightOffset, lowF } or null.
// V5-FROSTTWOMODELS-001 — `lowShown`, when a finite number, is the figure the line prints (and returns
// as lowF) instead of its own rounded low. Today passes it only on a night this line names TONIGHT —
// src/lib/tonightLow.js agreedTonightLow decides that, here nothing does — so the card, the cue and this
// line print one number. Without it the output is the one-argument output, byte for byte: the server's
// PARITY suites (lambda/daily-plan/advisorynight.test.js, frostsubject.test.js) call it that way.
export function buildFrostAlertLine(alertsSent, { lowShown } = {}) {
  const a = pickAdvisory(alertsSent)
  if (!a) return null
  const night = resolveNight(a)
  const when = nightPhrase(night)
  const low = Number.isFinite(lowShown) ? lowShown : Math.round(Number(a.lowF))
  return {
    text: `Frost possible ${when} — low ${low}°F. Plan cover for tender plants.`,
    tier: a.tier,
    dayOffset: intOrNull(a.dayOffset),
    nightOffset: night.nightOffset,
    lowF: low,
  }
}
