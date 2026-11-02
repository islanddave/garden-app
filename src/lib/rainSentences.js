// Today weather card: the rain line and the following-day line. WeatherWidget and the V2 glance card
// both print what rainSentences returns, so the two surfaces say the same words from the same code.
//
// PURE: the result depends on the arguments alone — no React, no clock, no network, no mutation.
// The regime flags are the CARD'S and are passed in rather than re-derived here, because the card's
// banners and stamp read the same flags: `live` (the overlay carries a rain figure), `uncertain` (the
// engine's uncertainty flag on a same-day plan), `showery` (uncertain, and not the missing-data verdict)
// and `noForecast` (WeatherWidget's forecastMissing). A second consumer must derive them exactly as the
// card does, or the two surfaces will print different sentences for one plan.
//
// Deliberate, do NOT "fix": the amount and the chance print side by side, never their product; the
// following-day line opens only for >= 0.10″ and only when it brings more than the line above (or
// clears the engine's watering bar, rainChangesWatering, bigger or not); a gauge measurement outranks
// a forecast.

// Probability gate for the INFORMATIONAL rain line. Below this PoP the line still opens only when some
// other reason does (an amount, a showery day, the live overlay, a gauge reading).
//
// The amount is never multiplied by the chance. An expected value (amount x PoP) is neither what falls
// if it rains nor how likely rain is, and it printed "0.05″ rain expected tomorrow" for a 0.14″ at 37%
// forecast while other sources said 0.4–0.95″. The card prints both, side by side, and the reader
// combines them.
const RAIN_POP_DISPLAY_THRESHOLD = 30 // percent; display gate for the rain line
// The following-day line (see nextNote below) opens only for a measurable rain. 0.10″ is the drought
// signal's `light` tier and the smallest bucket the gauge comparison scores, so below it the line would
// be announcing a trace.
const NEXT_DAY_MIN_IN = 0.1
// The engine's own "enough rain tomorrow to change watering" bar (lambda/daily-plan/engine.js
// rainCalloutFires, its unarmed branch: >= 0.30″, chance unknown or >= 50%). A copy, because the client
// cannot import the lambda; src/__tests__/rainCardEngineParity.test.jsx sweeps the card against the
// engine across both edges, so moving either copy alone reds. The engine's stricter armed bar (0.50″ /
// 60%, when dry beds are actually deferred) gates ADVICE; this row only reports, so it keeps the wider
// one: every day the engine's rain cue could speak, tomorrow's figure is on the card.
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
// second vocabulary: same formatter, same "as of {time}" phrasing as asOfLabel's,
// just without the "Jun 22 · " that would collide with a ·-separated sentence. The card's liveTimeLabel
// is this plus its 'just now' fallback, so there is one formatter, not two.
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

  // The rain AMOUNT and the POP are nullable and stay nullable to the point of use. Coercing a missing
  // amount to 0 would print a confident `0.00″ rain expected` precisely when the forecast was
  // unavailable; an unknown amount falls back to the pop-only sentence ("we know the chance, not the
  // amount"). A missing chance is not 0% either: the comparisons below read null and 0 the same, and
  // each sentence drops the segment.
  const rainSrc = live ? liveHydrology : hydrology
  const todayIn = rainSrc.today_precip_in ?? null
  const todayPop = rainSrc.today_pop ?? null
  const showToday = todayIn > 0 || ((uncertain || live) && todayPop >= 50)
  // Tomorrow has NO fallback to `upcoming_precip_in`: that is D+1 PLUS D+2 (lambda/daily-plan/index.js),
  // so it would print a TWO-DAY total under copy that says "tomorrow", and `rainWhen` below would still say
  // 'tomorrow'. A number for the wrong window is worse than no number: when tomorrow's own amount is
  // unknown, rainAmtKnown goes false and the card shows the honest "{pop}% chance of rain tomorrow" string.
  // The engine's 'incoming_dry' branch defers watering on `tomorrow_precip_in` ALONE, so the card and the
  // engine must read the same window.
  const rainIn = showToday ? todayIn : (rainSrc.tomorrow_precip_in ?? null)
  const rainPop = showToday ? todayPop : (rainSrc.tomorrow_pop ?? null)
  const rainWhen = showToday ? 'today' : 'tomorrow'
  // "Known" also means non-zero: a known 0.00″ has no amount worth printing beside its chance, so it keeps
  // the chance-only sentence.
  const rainAmtKnown = rainIn != null && round2(rainIn) > 0

  // A MEASUREMENT OUTRANKS A FORECAST, so it leads. The card must not print a PoP-weighted forecast as the
  // day's rain figure when the yard gauge has already measured the rain (a morning read "0.03″ rain
  // expected" when the gauge finished at 0.29″). Both halves are read off `hydrology`, never `rainSrc`,
  // because the live overlay carries no station provenance at all (see stationProv in WeatherWidget.jsx):
  // pairing a measured number with a forecast from a different source would put two incompatible bases in
  // one sentence. The still-expected half is the plan's `today_remaining_in`, the same hourly-scoped
  // remainder the watering engine uses, so the card and the list cannot disagree about how much more is
  // coming. Unweighted, deliberately: weighting by PoP is the right shape for a forecast and nonsense for
  // rain that has physically fallen (0.29″ at 40% is not 0.12″).
  const measuredToday = Number.isFinite(hydrology?.today_observed_in) ? hydrology.today_observed_in : null
  const gaugeMeasured = measuredToday != null && measuredToday > 0
  const remainingToday = Number.isFinite(hydrology?.today_remaining_in) ? hydrology.today_remaining_in : null

  // The sentence below is frozen at plan generation, but the live branch takes over the card's stamp line
  // and prints `Updated 12:10 PM` under it, which would put a current timestamp over an earlier
  // measurement. So when the overlay owns the stamp, the measurement carries its own basis inline; when it
  // does not, the card's `As of …` stamp already IS that basis. Time-only is safe because a previous-day
  // plan raises the stale banner instead of hiding behind the overlay.
  const measuredAt = live ? basisTimeLabel(generatedAt) : null
  // The chance in that sentence comes off `hydrology` for the same reason its two amounts do: a LIVE chance
  // between two stored figures would mix bases in a sentence explicitly stamped `as of {measuredAt}`.
  const measuredPop = hydrology?.today_pop ?? null
  const fallenSuffix = measuredAt ? ` as of ${measuredAt}` : ''

  // The FOLLOWING day, on its own line, when it brings more rain than the line above describes. "The line
  // above" is today whenever the gauge has measured rain or today is the rainy day, and tomorrow otherwise;
  // the next line is the day after that. It reads `rainSrc` like the forecast half above (live overlay when
  // present), and it is a separate sentence, so it never mixes a forecast basis into the measured one.
  const firstIsToday = gaugeMeasured || showToday
  const firstAmt = gaugeMeasured ? measuredToday + (remainingToday ?? 0) : (rainAmtKnown ? rainIn : 0)
  const nextIn = firstIsToday ? (rainSrc.tomorrow_precip_in ?? null) : (rainSrc.day2_precip_in ?? null)
  const nextPop = firstIsToday ? (rainSrc.tomorrow_pop ?? null) : (rainSrc.day2_pop ?? null)
  const nextWhen = firstIsToday ? 'tomorrow' : weekdayOf(rainSrc.day2_date)
  // …or when it is TOMORROW and brings enough to change watering, whatever today holds. The engine's rain
  // cue reads tomorrow alone, and it loses the one cue slot to a freeze, cold or heat cue; on a day that
  // also rained, "more than the line above" would leave tomorrow's rain nowhere on Today. The rule reads
  // the RAW amount, as the engine does (0.2999″ does not fire, though it prints as 0.30″); the "more than
  // the line above" test beside it compares what is printed, so it stays on rounded figures.
  const nextMatters = firstIsToday && rainChangesWatering(nextIn, nextPop)
  const nextNote = (Number.isFinite(nextIn) && round2(nextIn) >= NEXT_DAY_MIN_IN && (round2(nextIn) > round2(firstAmt) || nextMatters) && nextWhen)
    ? `${nextIn.toFixed(2)}″ ${nextWhen}${chanceBit(nextPop)}`
    : null
  const beside = nextNote != null

  // "none more expected" is a forecast statement. With no forecast behind it the remainder is the merge's
  // placeholder 0, so the measurement stands alone.
  //
  // The measured line has a SHORT form for when tomorrow's note sits beside it (`beside`). The glance
  // card's row B is 360 px at 426 and holds both notes on one row; the full measured line plus tomorrow's
  // is 397–465 px, wraps, and pushes Needs care off the first screen. Beside tomorrow's note the line keeps
  // its two amounts and drops the rest: `N″ fallen today` (no "none more expected", and no "as of H:MM":
  // with a time the pair has 7.8 px to spare at 10:00 AM and a wider time wraps) or `N″ fallen · M″ more`
  // (no chance). Alone, it is the full sentence. Chosen here, from the sentences, not by CSS, so the row
  // and the weather card print the same words; the card stacks the two lines and had room for the long
  // form, and takes the short one anyway so the two surfaces never disagree. KNOWN COST: under the live
  // overlay the short form carries no basis time, and the card's stamp then reads "Updated {now} · live
  // forecast" over a measurement taken at plan generation; the "· live forecast" wording is what still
  // tells the two apart.
  const rainNote = gaugeMeasured
    ? (remainingToday != null && remainingToday > 0
        ? (beside
            ? `${measuredToday.toFixed(2)}″ fallen · ${remainingToday.toFixed(2)}″ more`
            : `${measuredToday.toFixed(2)}″ fallen${fallenSuffix} · ${remainingToday.toFixed(2)}″ more expected${chanceBit(measuredPop, '%')}`)
        : (beside
            ? `${measuredToday.toFixed(2)}″ fallen today`
            : `${measuredToday.toFixed(2)}″ fallen${fallenSuffix || ' today'}${noForecast ? '' : ' · none more expected'}`))
    // The showery line is short beside the next note too: the full line plus tomorrow's is 364–427 px
    // against the row's 360. Beside, `~N″ today · P%` drops "— could climb" (the `~` already says the
    // figure is soft) and the no-amount line keeps its lead alone (`P% chance today` / `Showers today`).
    : softenedNote
    ? (rainAmtKnown && rainIn >= 0.1
        ? `~${rainIn.toFixed(2)}″ ${rainWhen}${chanceBit(rainPop, '%')}${beside ? '' : ' — could climb'}`
        // With no chance to lead it the line still names its day ("Showers today · …"), never a bare clause.
        : `${rainPop != null ? `${rainPop}% chance ${rainWhen}` : `Showers ${rainWhen}`}${beside ? '' : ' · little so far, could climb'}`)
    : (!rainAmtKnown
        ? (rainPop != null ? `${rainPop}% chance of rain ${rainWhen}` : null)
        : `${rainIn.toFixed(2)}″ ${rainWhen}${chanceBit(rainPop)}`)

  // The rain line's display gate.
  // `gaugeMeasured` opens it: a day whose rain has ALREADY FALLEN can leave every forecast field at 0
  // (Open-Meteo drops a delivered event from the current day's total), so without it the line would be hidden
  // precisely when the card has a real number to show.
  // `rainPop >= RAIN_POP_DISPLAY_THRESHOLD` opens it too: with no tomorrow amount rainIn is null, and without
  // this the whole line would vanish, costing the one honest thing still known, the probability. The
  // rainNote ternary has a `{pop}% chance of rain {when}` branch for exactly this case.
  const open = rainIn > 0 || showery || live || gaugeMeasured || rainPop >= RAIN_POP_DISPLAY_THRESHOLD
  return { rainNote: open ? rainNote : null, nextNote, gaugeMeasured }
}
