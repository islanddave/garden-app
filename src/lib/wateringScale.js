// Daily Plan — watering-can scale (0-3, half steps). Derives a GENERAL widget-level watering
// suggestion from the weather + hydrology the engine already assembles (engine v4:
// recent_precip_in, upcoming/tomorrow precip + pop, rain_coming, hot, highToday) and the existing
// container-vs-in-ground split. 0 = don't water · 1 = light · 2 = normal · 3 = deep soak. Rounded to
// nearest 0.5. Intentionally COARSE: a glanceable widget cue, NOT per-plant cadence (that lives in the
// per-task rows). Two lanes only: containers (dry fast; rain under-serves dense/covered bags) and
// in-ground beds (hold moisture; benefit from rain -> defer for an incoming soak).
// Source of truth: daily-plan-engine-build/weather-widget-redesign/wateringScale.js (LOCKED v1, DRG-TODAY-002).

const clampHalf = (n) => Math.max(0, Math.min(3, Math.round(n * 2) / 2));

// hydrology: { recent_precip_in, today_precip_in, today_pop, tomorrow_precip_in, tomorrow_pop, rain_coming }
// weather:   { hot:boolean, highToday:number }
export function computeWateringScale(hydrology = {}, weather = {}) {
  const recent = hydrology.recent_precip_in ?? 0;
  const todayIn = hydrology.today_precip_in ?? 0;     // rain falling TODAY (D0) — the case this fixes
  const todayPop = hydrology.today_pop ?? 0;
  const tmrwIn = hydrology.tomorrow_precip_in ?? hydrology.upcoming_precip_in ?? 0;
  const tmrwPop = hydrology.tomorrow_pop ?? 0;
  const hot = !!weather.hot;
  // A "real" incoming soak the beds can rely on: >=0.3in at >=50% PoP (engine v4 threshold).
  const rainComing = hydrology.rain_coming ?? (tmrwIn >= 0.3 && tmrwPop >= 50);
  // Rain actually landing TODAY the plants get now: >=0.3in, or >=0.2in at a high PoP.
  const rainToday = todayIn >= 0.3 || (todayIn >= 0.2 && todayPop >= 60);
  // Water reaching the medium right now = recent actuals + today's rain. FUTURE-day forecast is NOT
  // counted here (it under-serves containers); only rain on/around today.
  const wetNow = recent + todayIn;

  // Containers: base 2 (normal). FUTURE rain does NOT lower them (under-serves covered/dense bags), but
  // rain that already fell or is falling TODAY does reach them.
  let containers = 2;
  if (hot) containers += 1;                  // hot/dry -> deep soak
  if (wetNow >= 0.8) containers -= 2;         // heavy rain reached the bags
  else if (wetNow >= 0.4) containers -= 1;    // some rain

  // In-ground beds: base 1.5 (hold moisture longer than containers).
  let beds = 1.5;
  if (hot) beds += 1;
  if (wetNow >= 0.8) beds = 0;                // already soaked
  else if (wetNow >= 0.4) beds = Math.min(beds, 0.5);
  if (rainToday) beds = 0;                    // it's raining enough today -> don't water beds
  if (rainComing) beds = 0;                   // a reliable soak is coming -> wait for it

  return {
    containers: clampHalf(containers),
    beds: clampHalf(beds),
    rainComing,
    rainToday,
  };
}

// Map a 0-3 level to a 3-slot can rail: [fill0, fill1, fill2] where each is 1 | 0.5 | 0.
export function canRail(level) {
  return [0, 1, 2].map((i) => clampHalf(Math.max(0, Math.min(1, level - i))));
}

// Pill state: active (>=0.5 -> emerald "do") vs wait (0 -> coral "pause").
export function pillState(level) {
  return level >= 0.5 ? 'do' : 'wait';
}

// ── V3-WATERWHY-001 — human explanation for the watering-can recommendation ──────────────
// Operational surface (not a reward): user taps a watering pill to understand WHY. Derived from the
// SAME hydrology/weather signals + thresholds computeWateringScale uses, so the explanation can never
// contradict the recommendation. A test cross-checks the stated level against computeWateringScale.
function railWords(level) {
  const cans = Math.round(level)
  return cans <= 1 ? 'a light pass (1 can)' : cans === 2 ? 'a normal soak (2 cans)' : 'a deep soak (3 cans)'
}
const inHg = (n) => `${(n ?? 0).toFixed(2)}″`

export function wateringReason(hydrology = {}, weather = {}) {
  const recent = hydrology.recent_precip_in ?? 0
  const todayIn = hydrology.today_precip_in ?? 0
  const tmrwIn = hydrology.tomorrow_precip_in ?? hydrology.upcoming_precip_in ?? 0
  const tmrwPop = hydrology.tomorrow_pop ?? 0
  const hot = !!weather.hot
  const { containers, beds, rainComing, rainToday } = computeWateringScale(hydrology, weather)
  const wetNow = recent + todayIn

  const cLines = ['Containers dry out fast, so they start at a normal soak.']
  if (hot) cLines.push('It’s hot today — bump to a deeper soak.')
  if (wetNow >= 0.8) cLines.push(`Heavy recent rain (${inHg(wetNow)}) already reached the pots — much less needed.`)
  else if (wetNow >= 0.4) cLines.push(`Some recent rain (${inHg(wetNow)}) reached the pots — a little less needed.`)
  cLines.push('Rain coming later isn’t counted for pots — covered or dense containers don’t catch it well.')
  const cVerdict = containers >= 0.5 ? `Water containers: ${railWords(containers)}.` : 'Hold — containers don’t need water right now.'

  const bLines = ['In-ground beds hold moisture longer, so they start lighter than pots.']
  if (hot) bLines.push('It’s hot today — they’d want a bit more.')
  if (rainToday) bLines.push('It’s raining enough today — skip the beds.')
  else if (rainComing) bLines.push(`A reliable soak is coming (${inHg(tmrwIn)} at ${tmrwPop}%) — wait for it.`)
  else if (wetNow >= 0.8) bLines.push(`The ground is already soaked (${inHg(wetNow)} recently) — skip.`)
  else if (wetNow >= 0.4) bLines.push(`Some moisture in the ground (${inHg(wetNow)}) — a light touch only.`)
  const bVerdict = beds >= 0.5 ? `Water beds: ${railWords(beds)}.` : 'Hold — beds don’t need water right now.'

  return {
    containers: { level: containers, verdict: cVerdict, lines: cLines },
    beds: { level: beds, verdict: bVerdict, lines: bLines },
  }
}
