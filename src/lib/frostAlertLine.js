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
// A SAME-NIGHT ADVISORY RETIRES ONCE BOTH MODELS HAVE WARMED PAST IT (V5-TODAYFROSTWARMEDADVISORY-001, Dave 2026-09-28).
// An advisory entry is the second model's low at SEND time and no later run writes a fresher one (dedup is escalation-
// only), so "Frost possible tonight — low 38°F" held tonight's line, and the colder-wins 38 on the card and the cue, all
// evening after both forecasts had warmed to 44 — and it blocked the warmed line. The plan now stores the second model's
// CURRENT D1..D3 lows (hydrology.forecast_lows/forecast_dates, while the frost alert is on); currentLows(plan) hands them
// in with the plan low. A THRESHOLD advisory naming tonight is retired only when the second model's low for the advisory's
// own civil date is above ADVISORY_TRIP_F (the email's own trigger would no longer fire) AND the plan low is at or above
// FREEZE_BELOW_F (the freeze cue has let go). Tonight's line is then the watch if one was sent, else the warmed line citing
// the newest real frost email about tonight — the protect email after the advisory, or the advisory itself when it was
// the only one (Dave's scope: the same line on advisory-only nights) — and only when that line can speak, so the email
// always leaves one line about tonight. Models disagree -> colder wins, as before. Anything unknown (no stored lows, the
// date not among them, a hole, no plan low) -> not retired. Nothing is stored: the next run that turns either model cold
// again brings the email's line back. A radiative-only advisory keeps its figure (the plan holds no clear-and-calm verdict).
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

// V5-TODAYFROSTWARMEDADVISORY-001 — the advisory tier's trip: frostEval sends an advisory when the second model's coldest
// D1..D3 low is <= this (DEFAULT_THRESHOLDS.ADVISORY_LOW_F, D2), and no crop band trips higher (frostClass holds tropical
// and chill_sensitive to it). A low ABOVE it is a day the email would not have fired on. A copy of a Lambda constant:
// frostWatchLine.test.jsx holds it to frostEval.resolveThresholds() and to the highest band trip in frostClass.
export const ADVISORY_TRIP_F = 40

// A number, or a non-empty numeric string, else null (tonightLow.js reads a plan low by the same rule).
function numOrNull(v) {
  if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '')) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// V5-TODAYFROSTWARMEDADVISORY-001 — what the plan's LATEST run said about the nights ahead, from both models: the plan
// low (weather.tonightLow: NWS, floored by the yard station) and the second model's D1..D3 lows with their ET civil dates
// (hydrology.forecast_lows/forecast_dates). Pure and null-safe: null without a plan; a field the row does not carry is
// null, and the retirement rule reads null as unknown, never as warm.
export function currentLows(plan) {
  if (!plan || typeof plan !== 'object') return null
  const hy = plan.hydrology && typeof plan.hydrology === 'object' ? plan.hydrology : null
  return {
    planLow: plan.weather ? (plan.weather.tonightLow ?? null) : null,
    forecastLows: hy && Array.isArray(hy.forecast_lows) ? hy.forecast_lows : null,
    forecastDates: hy && Array.isArray(hy.forecast_dates) ? hy.forecast_dates : null,
  }
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

// V5-TODAYFROSTWARMEDADVISORY-001 — the second model's CURRENT low for one civil day, found by DATE, never by position
// (the array is D1..D3 of whichever run wrote it), or null when the row does not say: no arrays, no such date, a hole.
function currentLowFor(date, current) {
  if (!current || typeof date !== 'string' || !YMD.test(date)) return null
  const lows = current.forecastLows
  const dates = current.forecastDates
  if (!Array.isArray(lows) || !Array.isArray(dates)) return null
  let low = null
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] !== date) continue
    const v = numOrNull(lows[i])
    if (v == null) return null
    low = low == null ? v : Math.min(low, v)
  }
  return low
}
// Has tonight's advisory entry (pickFrostLines' `bestTonight`: an advisory naming tonight by construction) warmed past
// its own email on BOTH models? A radiative-only one (`trip` set) is never retired, nor is anything the row cannot vouch
// for. See the header.
function warmedPast(a, current) {
  if (a.trip != null) return false
  const second = currentLowFor(a.date, current)
  const plan = numOrNull(current && current.planLow)
  return second != null && second > ADVISORY_TRIP_F && plan != null && plan >= FREEZE_BELOW_F
}

// Picks what to render -> { tonight, ahead, imminent, warmed }: the entry for tonight's line, the statement for a later
// night's, the most recently sent real imminent entry (for the warmed line), and — when tonight's advisory was retired
// (V5-TODAYFROSTWARMEDADVISORY-001, `current` = currentLows(plan)) — the email the warmed line cites. Each null when
// nothing applies; without `current` nothing is retired and `warmed` is null.
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
// newest advisory entry naming a later night and every "Colder ahead" a real watch email carried.
// Follow-up F1 (Dave 2026-09-21): the same for a plain "Frost possible tonight" ADVISORY — the advisory entries are
// ranked PER NIGHT CLASS, tonight and later, so an advisory about tonight and one about a later night both show,
// whichever was sent last. Within a class the newest entry supersedes (the same night named again, or another later
// night). Before this, the newest advisory entry of ANY night took the one advisory slot and the other night vanished.
// ONE MINIMUM, ONE LINE (orchestrator, 2026-09-21, keeping "never two lines about one night" true for a corrected
// attribution): an advisory statement is about the coldest CIVIL DAY in the window, `date`, and which night that
// minimum falls in. Two statements with the same `date` describe ONE minimum — a later run re-attributed it (the
// BUG-FROSTESCALATENIGHTMOVE sequence: "tomorrow night" at 2 PM corrected to "tonight" at 3 PM) — so only the newest of
// them is kept, whichever night it names, before the per-class ranking. A watch email's carried "Colder ahead" is such
// a statement too. A statement with no usable `date` is not grouped and keeps the per-class rule.
export function pickFrostLines(alertsSent, current = null) {
  if (!Array.isArray(alertsSent)) return { tonight: null, ahead: null, imminent: null, warmed: null }
  const newer = (a, than) => than == null || String(a.at || '') > String(than.at || '')
  const entries = []
  const carried = []
  let imminent = null
  for (const a of alertsSent) {
    if (!a || a.run === 'forced') continue
    if (a.tier === 'imminent') {
      if (newer(a, imminent)) imminent = a
      const c = colderAhead(a)
      if (c) carried.push(c)
      continue
    }
    if (SEVERITY[a.tier] == null) continue
    if (a.lowF == null || !Number.isFinite(Number(a.lowF))) continue
    if (nightPhrase(resolveNight(a)) == null) continue
    entries.push(a)
  }
  // Entries before carried statements, so an entry still wins a tie on `at`, as it did against a carried statement.
  const statements = [...entries, ...carried]
  const dayOf = (s) => (typeof s.date === 'string' && YMD.test(s.date) ? s.date : null)
  const newestOfDay = new Map()
  for (const s of statements) {
    const d = dayOf(s)
    if (d != null && newer(s, newestOfDay.get(d))) newestOfDay.set(d, s)
  }
  let bestTonight = null
  let bestAhead = null
  for (const s of statements) {
    const d = dayOf(s)
    if (d != null && newestOfDay.get(d) !== s) continue
    if (resolveNight(s).nightOffset === 0) { if (newer(s, bestTonight)) bestTonight = s }
    else if (newer(s, bestAhead)) bestAhead = s
  }
  const watch = imminent && imminent.trip === 'radiative' && imminent.lowF != null
    && Number.isFinite(Number(imminent.lowF)) ? imminent : null
  let tonight = bestTonight
  let warmed = null
  if (bestTonight && warmedPast(bestTonight, current)) {
    // Retired: a watch sent for tonight takes the line, at its own low (the watch rules are unchanged). Else the
    // warmed line, citing the newest real frost email about tonight — and only if it can speak (a plan low warmer
    // than that email's, a readable send time); otherwise the advisory keeps the line, as before.
    if (watch) tonight = watch
    else {
      const cite = imminent && !newer(bestTonight, imminent) ? imminent : bestTonight
      if (warmedLine(cite, current.planLow)) { tonight = null; warmed = cite }
    }
  } else if (watch && !(bestTonight && Number(bestTonight.lowF) <= lineLowRaw(watch))) tonight = watch
  return { tonight, ahead: bestAhead, imminent, warmed }
}

// The single entry the FIRST line renders, or null: tonight's, else the later night's. For a list with no `colder` it
// picks what the one-slot rule picked, except (follow-up F1) where a tonight advisory sits beside a NEWER later-night
// advisory: the one slot took the later night, the first line is now tonight's.
export function pickAdvisory(alertsSent) {
  const { tonight, ahead } = pickFrostLines(alertsSent)
  return tonight || ahead
}

// The raw low of the line naming TONIGHT (a watch: including its second forecast), or null when no line names
// tonight. src/lib/tonightLow.js agrees the night on it. `current` (currentLows(plan)) applies the retirement rule, so
// a retired advisory no longer pins the night at its send-time figure; without it, exactly as before.
export function tonightLineLow(alertsSent, current = null) {
  const { tonight } = pickFrostLines(alertsSent, current)
  return tonight ? lineLowRaw(tonight) : null
}

// The email's send time on the ET clock, as the reader says it: "3 PM", "3:05 PM". The garden and its sends are ET
// (lambda/daily-plan frost window 14:00-17:59 ET); the phone's zone does not move it. null when `at` is not a time.
// Built per call and never at module load: this module is imported by tonightLow.js and careNeeded.js, so a runtime
// without the zone (RangeError) costs the warmed line, never the Today page.
function etClock(at) {
  if (typeof at !== 'string' || at.trim() === '') return null
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return null
  const p = {}
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true })
    for (const part of f.formatToParts(d)) p[part.type] = part.value
  } catch {
    return null
  }
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
// V5-TODAYFROSTWARMEDADVISORY-001 — the same line, word for word, speaks for a RETIRED same-night advisory: `sent` is
// then the email pickFrostLines cites (`warmed`), which may be the advisory itself; the line carries that entry's tier
// and day, as the advisory's own line did.
function warmedLine(sent, planLow) {
  if (!sent) return null
  const plan = numOrNull(planLow)
  const was = numOrNull(sent.lowF)
  if (plan == null || was == null || plan < FREEZE_BELOW_F || !(plan > was)) return null
  const time = etClock(sent.at)
  if (!time) return null
  return {
    text: `Forecast warmed to ${planLow}°F since the ${time} frost email.`,
    tier: sent.tier, dayOffset: sent.tier === 'imminent' ? 0 : intOrNull(sent.dayOffset), nightOffset: 0, lowF: plan,
  }
}

// -> { text, tier, dayOffset, nightOffset, lowF } for one picked entry.
// V5-TODAYRADIATIVEWATCH-001 — a radiative trip (`trip: 'radiative'` on the entry, imminent or advisory) is a
// WATCH, the word its email uses: the low sits above the trip point and the clear, calm sky is the reason it
// can fall further, so the line names both — "Frost watch tonight — clear and calm, low 42°F. …".
// V5-TODAYFROSTLINEGAPS-001 — a watch whose email printed a colder second forecast for its night says so, at that
// figure: "Frost watch tonight — clear and calm, as low as 35°F. …". Decided on the ROUNDED figures (QA M2): a 38.6
// second forecast under a 39 watch prints 39 either way, and "as low as 39°F" would claim a lower number it does not
// show. handler.frostSubject applies the same rounded rule to the email subject.
function lineFor(a, lowShown) {
  const night = resolveNight(a)
  const when = nightPhrase(night)
  const own = Number(a.lowF)
  const raw = lineLowRaw(a)
  const low = Number.isFinite(lowShown) ? lowShown : Math.round(raw)
  return {
    text: a.trip === 'radiative'
      ? `Frost watch ${when} — clear and calm, ${Math.round(raw) < Math.round(own) ? 'as low as' : 'low'} ${low}°F. Plan cover for tender plants.`
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
// V5-TODAYFROSTWARMEDADVISORY-001 — `current` (currentLows(plan)) lets a same-night advisory retire (see the header).
// Today passes it built from the SAME plan tonightLow.js reads, so the card, the cue and this line decide on one row. A
// retired advisory's warmed line prints current's plan low, the figure pickFrostLines checked it could speak with, so a
// retirement can never leave tonight with no line at all.
export function buildFrostAlertLines(alertsSent, { lowShown, planLow, current } = {}) {
  const { tonight, ahead, imminent, warmed } = pickFrostLines(alertsSent, current)
  const lines = []
  if (tonight) lines.push(lineFor(tonight, lowShown))
  else {
    const line = warmed ? warmedLine(warmed, current.planLow) : warmedLine(imminent, planLow)
    if (line) lines.push(line)
  }
  if (ahead) lines.push(lineFor(ahead, null))
  return lines
}

// -> the FIRST line, or null. Without `planLow` its output is the one-argument output, and for an entry list stored
// before V5-TODAYFROSTLINEGAPS-001 it is byte for byte what it returned before, except the F1 case pickAdvisory names:
// the server's PARITY suites (lambda/daily-plan/advisorynight.test.js, frostsubject.test.js, …) call it that way.
export function buildFrostAlertLine(alertsSent, opts = {}) {
  return buildFrostAlertLines(alertsSent, opts)[0] || null
}
