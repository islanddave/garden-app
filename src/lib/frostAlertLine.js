// src/lib/frostAlertLine.js — BUG-FROSTALERTNOAPP-001.
//
// Words the frost ADVISORY that the daily-plan engine already sent by SNS, for rendering on Today.
// Pure: no fetch, no clock, no DOM. Mirrors the vocabulary of the SNS text (frostEval
// advisoryMessage) so the message Dave gets on his phone and the line he sees in the app cannot
// drift into describing the same night two ways.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// IT RENDERS THE ADVISORY TIER AND THE RADIATIVE WATCH; THE EXCLUSIONS ARE MEASURED, NOT TASTE.
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
//   - imminent  -> a THRESHOLD send is skipped: it fires at <= 38F on the same plan low the engine's cue
//                  keys on (weather.tonightLow, handler.js frostForSpace), so on the run that sent it the cue
//                  says "Freeze tonight" (< 40F). A RADIATIVE send (`trip: 'radiative'`, the "Frost watch
//                  tonight" email) is RENDERED, as a watch: it fires ABOVE its trip point — 39-42F for the
//                  tender band (radiativeFrost.js proximity 4) — where the cue says "Cool night" or nothing,
//                  so Today never said "watch" on the evening the email did (V5-TODAYRADIATIVEWATCH-001;
//                  Dave 2026-09-21, "Show it on Today"). The most recently sent imminent entry decides: a
//                  later threshold send leaves tonight to the freeze cue again. pickFrostLines ranks it.
//   - heat      -> skipped. computeCallout renders `high >= 88` already.
//   - advisory  -> rendered, tonight included: its figure is a second model's, and it is the one
//                  Dave was texted about. When it names tonight, Today prints ONE low for the night
//                  on the card, the cue and this line — the colder of this figure and the plan low
//                  (V5-FROSTTWOMODELS-001, src/lib/tonightLow.js) — so this line's number can be the
//                  plan's. Any other night keeps this line's own figure. A RADIATIVE-ONLY advisory
//                  (`trip: 'radiative'`, stored since V5-TODAYRADIATIVEWATCH-001) is worded as the watch
//                  its email is titled ("Frost watch <night>"); an entry stored before carries no `trip`
//                  and keeps "Frost possible".
//   - forced    -> skipped, any tier: a rehearsal, never a real alert (BUG-FROSTREHEARSALSWALLOWS-001).
//
// UP TO TWO LINES, ONE PER NIGHT (V5-TODAYFROSTLINEGAPS-001, Dave 2026-09-21). The slot used to hold ONE line, so a
// watch for tonight displaced the advisory for a LATER night for the rest of the plan date. Now:
//   1. tonight — the watch, or an advisory naming tonight (the V5-TODAYRADIATIVEWATCH-001 choice between them,
//      unchanged); when neither applies and a THRESHOLD "Frost protect tonight" email went out earlier but the plan
//      low has since warmed out of the freeze cue (>= FREEZE_BELOW_F), the facts: "Forecast warmed to 44°F since the
//      3 PM frost email." — the only Today trace such an email would otherwise leave once the cue stops covering it.
//   2. a later night — the newest advisory statement about one: the advisory entry when it names a later night, or
//      the "Colder ahead" advisory a watch email carried (`colder` on the imminent entry, below).
// Tonight's line comes first. Never two lines about the same night; with only one of them, exactly one line, as before.
// A watch entry's `colder` (handler.frostWeatherFacts) is the colder advisory its email printed. Naming TONIGHT it is
// the second forecast's low for the watch's own night ("Colder on a second forecast: 35°F tonight"): the watch line
// says "as low as 35°F", and tonightLow.js agrees the night on it. Naming a later night it is line 2's candidate.
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

// engine.js computeCallout: `low < 40` is the freeze cue, the line where it stops covering tonight. src/lib/tonightLow.js
// imports it for its copy of that cue, and its PARITY sweep holds it to the real computeCallout.
export const FREEZE_BELOW_F = 40

// A number, or a non-empty numeric string, else null (tonightLow.js reads a plan low by the same rule).
function numOrNull(v) {
  if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '')) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

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
  // V5-TODAYRADIATIVEWATCH-001 — an imminent send is about TONIGHT by construction (frostEval sentNight says
  // the same); its entry carries dayOffset 0 and no nightOffset.
  if (a.tier === 'imminent') return { nightOffset: 0, nightDate: null }
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

// V5-TODAYFROSTLINEGAPS-001 — a watch entry's `colder` (the colder advisory its email carried), read by the advisory
// rules (resolveNight on its own dayOffset/date/nightOffset) and nothing else of the object.
function colderFacts(a) {
  const c = a && a.colder
  if (!c || typeof c !== 'object') return null
  const f = { lowF: numOrNull(c.lowF), dayOffset: c.dayOffset, date: c.date, nightOffset: c.nightOffset }
  const night = resolveNight(f)
  return f.lowF != null && night && nightPhrase(night) != null ? { f, night } : null
}
// The second forecast's low for the watch's OWN night ("Colder on a second forecast: 35°F tonight"), or null.
function colderTonight(a) {
  const c = colderFacts(a)
  return c && c.night.nightOffset === 0 ? c.f.lowF : null
}
// The "Colder ahead" advisory a watch email carried, as an advisory statement sent when the email was, or null.
function colderAhead(a) {
  const c = colderFacts(a)
  return c && c.night.nightOffset >= 1 ? { ...c.f, tier: 'advisory', level: 'advisory', at: a.at } : null
}
// A line's own raw low: an advisory's figure; a watch's the colder of its own and its second forecast's.
function lineLowRaw(a) {
  const own = Number(a.lowF)
  const second = a.tier === 'imminent' ? colderTonight(a) : null
  return second != null && second < own ? second : own
}

// Picks what to render -> { tonight, ahead, imminent }: the entry for tonight's line, the statement for a later
// night's, and the most recently sent real imminent entry (for the warmed line). Each null when nothing applies.
// Most severe wins; among equals the most recently SENT wins, because a re-send inside one night is an escalation,
// not a repeat (handler carries prior sends forward rather than replacing them, so the array is append-ordered but
// `at` is authoritative).
// BUG-FROSTREHEARSALSWALLOWS-001 — a send made by a FORCED run (`run: 'forced'`, a rehearsal whose trip
// points may be raised) is never a real alert, so it never renders and never outranks a real one. The
// server's "already sent?" gates skip the same entries (lambda/daily-plan/frostEval.js countsAsSent;
// frostrehearsal.test.js holds the two together). An entry with no `run` predates the field and counts.
// V5-TODAYRADIATIVEWATCH-001 — the imminent tier renders only as a WATCH, and the most recently sent imminent
// entry decides whether it does: a radiative one is tonight's watch, a threshold one leaves tonight to the
// freeze cue (see the header) whatever was sent before it. A watch outranks an advisory for tonight — it is the
// imminent tier — except that an advisory naming TONIGHT at the same or a colder low keeps tonight's line: a
// watch must never make the line warmer than the one it replaced (V5-FROSTTWOMODELS-001: one low per night, the
// colder wins). The watch's low there is lineLowRaw: its second forecast's figure counts.
// V5-TODAYFROSTLINEGAPS-001 — an advisory for a LATER night is no longer displaced: it is `ahead`, the newest of the
// newest advisory entry (when it names a later night) and every "Colder ahead" a real watch email carried.
export function pickFrostLines(alertsSent) {
  if (!Array.isArray(alertsSent)) return { tonight: null, ahead: null, imminent: null }
  let best = null
  let imminent = null
  let carried = null
  for (const a of alertsSent) {
    if (!a || a.run === 'forced') continue
    if (a.tier === 'imminent') {
      if (imminent == null || String(a.at || '') > String(imminent.at || '')) imminent = a
      const c = colderAhead(a)
      if (c && (carried == null || String(c.at || '') > String(carried.at || ''))) carried = c
      continue
    }
    if (SEVERITY[a.tier] == null) continue
    if (a.lowF == null || !Number.isFinite(Number(a.lowF))) continue
    if (nightPhrase(resolveNight(a)) == null) continue
    if (best == null) { best = a; continue }
    const s = SEVERITY[a.tier] - SEVERITY[best.tier]
    if (s > 0) { best = a; continue }
    if (s === 0 && String(a.at || '') > String(best.at || '')) best = a
  }
  const watch = imminent && imminent.trip === 'radiative' && imminent.lowF != null
    && Number.isFinite(Number(imminent.lowF)) ? imminent : null
  const bestTonight = best != null && resolveNight(best).nightOffset === 0
  let tonight = bestTonight ? best : null
  if (watch && !(bestTonight && Number(best.lowF) <= lineLowRaw(watch))) tonight = watch
  let ahead = bestTonight ? null : best
  if (carried && (ahead == null || String(carried.at || '') > String(ahead.at || ''))) ahead = carried
  return { tonight, ahead, imminent }
}

// The single entry the FIRST line renders, or null: tonight's, else the later night's. Unchanged for every entry
// stored before V5-TODAYFROSTLINEGAPS-001 (a list with no `colder` picks exactly what the one-slot rule picked).
export function pickAdvisory(alertsSent) {
  const { tonight, ahead } = pickFrostLines(alertsSent)
  return tonight || ahead
}

// The raw low of the line naming TONIGHT (a watch: including its second forecast), or null when no line names
// tonight. src/lib/tonightLow.js agrees the night on it.
export function tonightLineLow(alertsSent) {
  const { tonight } = pickFrostLines(alertsSent)
  return tonight ? lineLowRaw(tonight) : null
}

// The email's send time on the ET clock, as the reader says it: "3 PM", "3:05 PM". The garden and its sends are ET
// (lambda/daily-plan frost window 14:00-17:59 ET); the phone's zone does not move it. null when `at` is not a time.
const ET_CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true })
function etClock(at) {
  if (typeof at !== 'string' || at.trim() === '') return null
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return null
  const p = {}
  for (const part of ET_CLOCK.formatToParts(d)) p[part.type] = part.value
  if (!p.hour || !p.minute || !p.dayPeriod) return null
  return `${p.hour}${p.minute === '00' ? '' : `:${p.minute}`} ${p.dayPeriod}`
}

// V5-TODAYFROSTLINEGAPS-001 (Dave 2026-09-21, "Say it warmed") — a THRESHOLD imminent email ("Frost protect tonight
// (low 36°F)") leaves tonight to the freeze cue, which keys on the CURRENT plan low: once a later run warms it to
// FREEZE_BELOW_F or above, the cue stops saying "Freeze tonight" and Today said nothing about an email he got that
// afternoon. This line says what changed — facts only, no advice — with the plan low as the card prints it and the
// email's send time. Only from the most recently sent real imminent entry, only when the plan low is now warmer than
// the low that email sent at, and never while the freeze cue still covers tonight. Only reached when no line names
// tonight, so never for a watch: pickFrostLines makes any usable one tonight's line. It never hands this a forced entry.
function warmedLine(imminent, planLow) {
  if (!imminent) return null
  const plan = numOrNull(planLow)
  const sent = numOrNull(imminent.lowF)
  if (plan == null || sent == null || plan < FREEZE_BELOW_F || !(plan > sent)) return null
  const time = etClock(imminent.at)
  if (!time) return null
  return { text: `Forecast warmed to ${planLow}°F since the ${time} frost email.`, tier: 'imminent', dayOffset: 0, nightOffset: 0, lowF: plan }
}

// -> { text, tier, dayOffset, nightOffset, lowF } for one picked entry.
// V5-TODAYRADIATIVEWATCH-001 — a radiative trip (`trip: 'radiative'` on the entry, imminent or advisory) is a
// WATCH, the word its email uses: the low sits above the trip point and the clear, calm sky is the reason it
// can fall further, so the line names both — "Frost watch tonight — clear and calm, low 42°F. …".
// V5-TODAYFROSTLINEGAPS-001 — a watch whose email printed a colder second forecast for its night says so, at that
// figure: "Frost watch tonight — clear and calm, as low as 35°F. …".
function lineFor(a, lowShown) {
  const night = resolveNight(a)
  const when = nightPhrase(night)
  const own = Number(a.lowF)
  const raw = lineLowRaw(a)
  const low = Number.isFinite(lowShown) ? lowShown : Math.round(raw)
  return {
    text: a.trip === 'radiative'
      ? `Frost watch ${when} — clear and calm, ${raw < own ? 'as low as' : 'low'} ${low}°F. Plan cover for tender plants.`
      : `Frost possible ${when} — low ${low}°F. Plan cover for tender plants.`,
    tier: a.tier,
    dayOffset: intOrNull(a.dayOffset),
    nightOffset: night.nightOffset,
    lowF: low,
  }
}

// -> the lines Today renders, in order (tonight's first), each { text, tier, dayOffset, nightOffset, lowF }; [] when
// nothing applies. See the header for which lines, and pickFrostLines for which entries.
// V5-FROSTTWOMODELS-001 — `lowShown`, when a finite number, is the figure TONIGHT's line prints (and returns as
// lowF) instead of its own rounded low. Today passes it only on a night a line names TONIGHT — src/lib/tonightLow.js
// agreedTonightLow decides that — so the card, the cue and that line print one number; a later night's line always
// keeps its own figure. `planLow` (plan.weather.tonightLow) is read only for the warmed line.
export function buildFrostAlertLines(alertsSent, { lowShown, planLow } = {}) {
  const { tonight, ahead, imminent } = pickFrostLines(alertsSent)
  const lines = []
  if (tonight) lines.push(lineFor(tonight, lowShown))
  else {
    const warmed = warmedLine(imminent, planLow)
    if (warmed) lines.push(warmed)
  }
  if (ahead) lines.push(lineFor(ahead, null))
  return lines
}

// -> the FIRST line, or null. Without `planLow` its output is the one-argument output, and for every entry stored
// before V5-TODAYFROSTLINEGAPS-001 that is byte for byte what it returned before: the server's PARITY suites
// (lambda/daily-plan/advisorynight.test.js, frostsubject.test.js, …) call it that way.
export function buildFrostAlertLine(alertsSent, opts = {}) {
  return buildFrostAlertLines(alertsSent, opts)[0] || null
}
