// Today weather card — the rain line and the following-day line, lifted verbatim out of
// src/components/today/WeatherWidget.jsx (V5-TODAYREDESIGN-001 S3a, 2026-09-28) so the V2 glance card
// prints the same sentences from the same code. WeatherWidget renders exactly what rainSentences returns;
// the move changed no byte of the card's DOM.
//
// PURE: the result depends on the arguments alone — no React, no clock, no network, no mutation.
// The regime flags are the CARD'S and are passed in rather than re-derived here, because the card's
// banners and stamp read the same flags: `live` (the overlay carries a rain figure), `uncertain` (the
// engine's uncertainty flag on a same-day plan), `showery` (uncertain, and not the missing-data verdict)
// and `noForecast` (WeatherWidget's forecastMissing). A second consumer must derive them exactly as the
// card does, or the two surfaces will print different sentences for one plan.
//
// Deliberate — do NOT "fix" (forecast session, 2026-09-28): the amount and the chance print side by
// side, never their product; the following-day line opens only for >= 0.10″ and only when it brings
// more than the line above; a gauge measurement outranks a forecast.
// Owner amendment (Dave, 2026-10-08, BUG-RAINTOMORROWMISLABEL-001 b): tomorrow's line ALSO opens under a
// today line whenever tomorrow clears the engine's watering bar (rainChangesWatering), bigger or not.

// DRG-WXPROB-001 — probability-gate the INFORMATIONAL rain line. Below this PoP the line still opens only
// when some other reason does (an amount, a showery day, the live overlay, a gauge reading).
//
// BUG-RAINFCSTONEMODEL-001 (b) — the amount is NO LONGER multiplied by the chance. DRG-WXPROB-001 printed
// `amount × PoP / 100`, an expected value, to stop a low-chance forecast overstating rain. On 2026-09-25 it
// did the opposite: a forecast of 0.14″ at 37% printed as "0.05″ rain expected tomorrow" while every other
// source was saying 0.4–0.95″, and Dave read it as the app forecasting a dry day. An expected value is
// neither what falls if it rains nor how likely rain is, so the card now prints both, side by side, and the
// reader combines them. Dave's call (2026-09-25): "Amount + chance".
const RAIN_POP_DISPLAY_THRESHOLD = 30 // percent; display gate for the rain line
// The following-day line (see nextNote below) opens only for a measurable rain. 0.10″ is the drought
// signal's `light` tier and the smallest bucket the gauge comparison scores, so below it the line would
// be announcing a trace.
const NEXT_DAY_MIN_IN = 0.1
// BUG-RAINTOMORROWMISLABEL-001 (b) — the engine's own "enough rain tomorrow to change watering" bar
// (lambda/daily-plan/engine.js rainCalloutFires, its unarmed branch: >= 0.30″, chance unknown or >= 50%).
// A copy, because the client cannot import the lambda; src/__tests__/rainCardEngineParity.test.jsx sweeps the
// card against the engine across both edges, so moving either copy alone reds. The engine's stricter armed
// bar (0.50″ / 60%, when dry beds are actually deferred) gates ADVICE; this row only reports, so it keeps the
// wider one — every day the engine's rain cue could speak, tomorrow's figure is on the card.
const WATERING_RAIN_MIN_IN = 0.3
const WATERING_RAIN_MIN_POP = 50
export const rainChangesWatering = (amountIn, pop) =>
  Number.isFinite(amountIn) && amountIn >= WATERING_RAIN_MIN_IN && (pop == null || pop >= WATERING_RAIN_MIN_POP)
// A chance that was never reported is not 0%: the segment is left out, as the engine's own line leaves it out.
const chanceBit = (pop, tail = '% chance') => (pop != null ? ` · ${pop}${tail}` : '')
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100
// 'YYYY-MM-DD' (an America/New_York civil day, as Open-Meteo labels its daily rows) -> 'Sunday'. Read at
// noon UTC so no offset can move it across midnight. Anything else -> null, and the caller prints nothing.
function weekdayOf(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null
  const d = new Date(`${ymd}T12:00:00Z`)
  if (isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(d)
}

// The ET TIME half of asOfLabel's grammar (WeatherWidget.jsx), for inline use inside a sentence. Not a
// second vocabulary: same formatter, same "as of {time}" phrasing Today.jsx already stamps the care list
// with (V4-TODAYBASIS-001), just without the "Jun 22 · " that would collide with a ·-separated sentence.
// The card's liveTimeLabel is this plus its 'just now' fallback, so there is one formatter, not two.
export function basisTimeLabel(at) {
  if (!at) return null
  const d = new Date(at)
  if (isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(d)
}

// hydrology: the plan's stored hydrology, an object (as WeatherWidget passes it). liveHydrology: the
// client-side overlay, read only when `live`. generatedAt: the plan's generation time, which stamps the
// measured figure when the overlay owns the card's stamp.
// Returns { rainNote, nextNote, gaugeMeasured }: rainNote is the rain line, or null while its display gate
// is shut; nextNote the following-day line or null; gaugeMeasured whether the gauge has measured rain today
// (the card's live stamp reads it too).
export function rainSentences({ hydrology, liveHydrology = null, live = false, uncertain = false, showery = false, noForecast = false, generatedAt = null }) {
  // The NOTE's softened phrasing stays live-gated, unlike the banner. That copy restates the STORED
  // snapshot's own figures ("~0.21″ today — could climb") and drops the PoP weighting; applied to the
  // overlay it would swap a hedged number for a raw one while adding a hedging word, and would assert
  // the engine's verdict over figures the engine never saw. Regime-level caveat: shown either way.
  // Number-level caveat: only over the numbers it was computed from.
  const softenedNote = showery && !live

  // BUG-LIVEWEATHERNUMOR0-001 — the rain AMOUNT is nullable and is kept nullable to the point of use.
  // src/lib/liveWeather.js used to coerce a missing precipitation_sum to 0, which put a confident
  // `0.00″ rain expected` on the card precisely when the forecast was unavailable; a `?? 0` here
  // would move that same fabrication one layer down instead of removing it. Unknown amount falls
  // back to the pop-only sentence that already exists for the below-threshold case — "we know the
  // chance, not the amount" is a thing the card can honestly say.
  //
  // POP is kept nullable too since BUG-RAINTOMORROWMISLABEL-001 (b): it was floored to 0 here and a forecast
  // with no chance printed "0.40″ tomorrow · 0% chance". The comparisons below read the same either way —
  // `null > 0` and `null >= 50` are both false, exactly as `0` was — and each sentence drops the segment.
  const rainSrc = live ? liveHydrology : hydrology
  const todayIn = rainSrc.today_precip_in ?? null
  const todayPop = rainSrc.today_pop ?? null
  const showToday = todayIn > 0 || ((uncertain || live) && todayPop >= 50)
  // BUG-RAINTOMORROWMISLABEL-001 (a) — the `?? rainSrc.upcoming_precip_in` fallback is GONE.
  // `upcoming_precip_in` is D+1 PLUS D+2 (lambda/daily-plan/index.js), so whenever tomorrow's own amount
  // was null the card printed a TWO-DAY total under copy that says "tomorrow" — and `rainWhen` on the very
  // next line still said 'tomorrow', so nothing downstream could tell. A number for the wrong window is
  // worse than no number: when tomorrow's amount is unknown, rainAmtKnown goes false and the card shows
  // the honest "{pop}% chance of rain tomorrow" string instead. That string already existed but was
  // UNREACHABLE — the render gate below keyed on `rainIn > 0`, so a row with no amount showed no line at
  // all; the gate is widened there so dropping a wrong number does not also drop the right one.
  //
  // It matters more since OPS-PLANDEFER-001: the 'incoming_dry' branch defers watering on
  // `tomorrow_precip_in` ALONE, so a card showing D+1+D+2 would have Dave sanity-checking a deferral
  // against a larger number than the engine ever saw. The card and the engine must read the same window.
  const rainIn = showToday ? todayIn : (rainSrc.tomorrow_precip_in ?? null)
  const rainPop = showToday ? todayPop : (rainSrc.tomorrow_pop ?? null)
  const rainWhen = showToday ? 'today' : 'tomorrow'
  // BUG-RAINFCSTONEMODEL-001 (b) — "known" now also means non-zero: a known 0.00″ has no amount worth
  // printing beside its chance, so it keeps the chance-only sentence it always got.
  const rainAmtKnown = rainIn != null && round2(rainIn) > 0

  // BUG-RAINCARDFORECASTONLY-001 — the card used to print a PoP-WEIGHTED FORECAST as the day's rain figure even
  // when the WS-2902 in the yard had already measured the rain. Reported by Dave 2026-09-06: the card read
  // "0.03″ rain expected" on a morning the gauge finished at 0.29″. Both numbers were "right" and neither was
  // what he wanted to know. Three different quantities were in play — the gauge, the plan's snapshot, and a
  // client-side Open-Meteo fetch — and the ONLY one the card showed was the one that never consults the gauge
  // (DRG-WXROLL-001 deliberately scopes the live overlay to the informational figure; that is unchanged, and is
  // exactly why this figure can drift from the yard).
  //
  // A MEASUREMENT OUTRANKS A FORECAST, so it leads. Both halves are read off `hydrology` — never `rainSrc` —
  // because the live overlay carries no station provenance at all (see stationProv in WeatherWidget.jsx):
  // pairing a measured number with a forecast from a different source would put two incompatible bases in one
  // sentence. The still-expected half is the plan's `today_remaining_in`, the same hourly-scoped remainder the
  // watering engine uses, so the card and the list can no longer disagree about how much more is coming.
  //
  // Unweighted, deliberately. `rainIn * pop / 100` is an expected VALUE and is the right shape for a forecast;
  // applying it to rain that has physically fallen would be nonsense (0.29″ at 40% is not 0.12″).
  const measuredToday = Number.isFinite(hydrology?.today_observed_in) ? hydrology.today_observed_in : null
  const gaugeMeasured = measuredToday != null && measuredToday > 0
  const remainingToday = Number.isFinite(hydrology?.today_remaining_in) ? hydrology.today_remaining_in : null

  // BUG-WXLIVESTAMPSTALE-001 — the whole sentence below is frozen at plan generation (deliberately:
  // see above), but the live branch takes over the card's stamp line and prints `Updated 12:10 PM` under
  // it. On 2026-09-13 that put a current timestamp over a 05:30 measurement. So when the overlay owns the
  // stamp, the measurement carries its own basis inline; when it does not, the card's `As of …` stamp
  // already IS that basis and repeating it would only lengthen the line. Time-only is safe here
  // because a previous-day plan now raises the stale banner instead of hiding behind the overlay.
  const measuredAt = live ? basisTimeLabel(generatedAt) : null
  // …and the chance in that sentence comes off `hydrology` for the same reason its two amounts do.
  // It had been riding on `rainSrc`, so with the overlay on, a LIVE chance sat between two stored
  // figures — the exact mixing the block above forbids, and it matters more now that the sentence is
  // explicitly stamped `as of {measuredAt}`.
  const measuredPop = hydrology?.today_pop ?? null
  const fallenSuffix = measuredAt ? ` as of ${measuredAt}` : ''

  // BUG-RAINFCSTONEMODEL-001 (b) — the FOLLOWING day, on its own line, when it brings more rain than the
  // line above describes. The card showed one day and one day only, so on 2026-09-25 a forecast 1.72″
  // Sunday was nowhere on it while the line read 0.05″ for Saturday. "The line above" is today whenever
  // the gauge has measured rain or today is the rainy day, and tomorrow otherwise; the next line is the day
  // after that. It reads `rainSrc` like the forecast half above (live overlay when present), and it is a
  // separate sentence, so it never mixes a forecast basis into the measured one.
  const firstIsToday = gaugeMeasured || showToday
  const firstAmt = gaugeMeasured ? measuredToday + (remainingToday ?? 0) : (rainAmtKnown ? rainIn : 0)
  const nextIn = firstIsToday ? (rainSrc.tomorrow_precip_in ?? null) : (rainSrc.day2_precip_in ?? null)
  const nextPop = firstIsToday ? (rainSrc.tomorrow_pop ?? null) : (rainSrc.day2_pop ?? null)
  const nextWhen = firstIsToday ? 'tomorrow' : weekdayOf(rainSrc.day2_date)
  // BUG-RAINTOMORROWMISLABEL-001 (b) — …or when it is TOMORROW and brings enough to change watering, whatever
  // today holds. The engine's rain cue reads tomorrow alone, and it loses the one cue slot to a freeze, cold or
  // heat cue; on a day that also rained, "more than the line above" then left tomorrow's rain nowhere on Today.
  // The rule reads the RAW amount, as the engine does (0.2999″ does not fire, though it prints as 0.30″); the
  // older "more than the line above" test beside it compares what is printed, so it stays on rounded figures.
  const nextMatters = firstIsToday && rainChangesWatering(nextIn, nextPop)
  const nextNote = (Number.isFinite(nextIn) && round2(nextIn) >= NEXT_DAY_MIN_IN && (round2(nextIn) > round2(firstAmt) || nextMatters) && nextWhen)
    ? `${nextIn.toFixed(2)}″ ${nextWhen}${chanceBit(nextPop)}`
    : null
  const beside = nextNote != null

  // BUG-WXOUTAGESTAMPCOPY-001 — "none more expected" is a forecast statement. With no forecast behind it the
  // remainder is the merge's placeholder 0, so the measurement stands alone.
  //
  // BUG-RAINTOMORROWMISLABEL-001 (b) — the measured line has a SHORT form for when tomorrow's note sits beside
  // it (`beside`, below). The glance card's row B is 360 px at 426 and holds both notes on one row; the full
  // measured line plus tomorrow's is 397–465 px, wraps, and pushes Needs care off the first screen. So beside
  // tomorrow's note the line keeps its two amounts and drops the rest: `N″ fallen today` (no "none more
  // expected", and no "as of H:MM": with a time the pair has 7.8 px to spare at 10:00 AM and a wider time
  // wraps) or `N″ fallen · M″ more` (no chance). Alone, it is the full sentence it always was. Chosen here,
  // from the sentences, not by CSS, so the row and the weather card print the same words; the card stacks
  // the two lines and had room for the long form, and takes the short one anyway so the two surfaces never
  // disagree. KNOWN COST: under the live overlay the short form carries no basis time, and the card's stamp
  // then reads "Updated {now} · live forecast" over a measurement taken at plan generation — the "· live
  // forecast" wording (BUG-WXLIVESTAMPSTALE-001) is what still tells the two apart.
  const rainNote = gaugeMeasured
    ? (remainingToday != null && remainingToday > 0
        ? (beside
            ? `${measuredToday.toFixed(2)}″ fallen · ${remainingToday.toFixed(2)}″ more`
            : `${measuredToday.toFixed(2)}″ fallen${fallenSuffix} · ${remainingToday.toFixed(2)}″ more expected${chanceBit(measuredPop, '%')}`)
        : (beside
            ? `${measuredToday.toFixed(2)}″ fallen today`
            : `${measuredToday.toFixed(2)}″ fallen${fallenSuffix || ' today'}${noForecast ? '' : ' · none more expected'}`))
    // The showery line is short beside the next note too, by the same rule: the full line plus tomorrow's is
    // 364–427 px against the row's 360. Beside, `~N″ today · P%` drops "— could climb" (the `~` already says the
    // figure is soft) and the no-amount line keeps its lead alone (`P% chance today` / `Showers today`).
    : softenedNote
    ? (rainAmtKnown && rainIn >= 0.1
        ? `~${rainIn.toFixed(2)}″ ${rainWhen}${chanceBit(rainPop, '%')}${beside ? '' : ' — could climb'}`
        // With no chance to lead it the line still names its day ("Showers today · …"), never a bare clause.
        : `${rainPop != null ? `${rainPop}% chance ${rainWhen}` : `Showers ${rainWhen}`}${beside ? '' : ' · little so far, could climb'}`)
    : (!rainAmtKnown
        ? (rainPop != null ? `${rainPop}% chance of rain ${rainWhen}` : null)
        : `${rainIn.toFixed(2)}″ ${rainWhen}${chanceBit(rainPop)}`)

  // The rain line's display gate (was the card's render condition).
  // BUG-RAINCARDFORECASTONLY-001 adds `gaugeMeasured`: a day whose rain has ALREADY FALLEN can leave every
  // forecast field at 0 (Open-Meteo drops a delivered event from the current day's total — measured
  // 2026-09-06: 0.0" reported for a day the gauge finished at 0.29"), so the old gate hid the line
  // precisely when the card had a real number to show.
  // `rainPop >= RAIN_POP_DISPLAY_THRESHOLD` added with BUG-RAINTOMORROWMISLABEL-001 (a). Dropping the
  // bad `?? upcoming_precip_in` fallback leaves rainIn null when tomorrow's own amount is unknown,
  // and this gate reads rainIn — so removing a wrong number would have silently removed the whole
  // line, costing Dave the one honest thing still known: the probability. The rainNote ternary
  // already has a `{pop}% chance of rain {when}` branch for exactly this case; it was simply
  // unreachable, because a row with no amount could never open the gate.
  const open = rainIn > 0 || showery || live || gaugeMeasured || rainPop >= RAIN_POP_DISPLAY_THRESHOLD
  return { rainNote: open ? rainNote : null, nextNote, gaugeMeasured }
}
