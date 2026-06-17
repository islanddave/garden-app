// Daily Plan — watering-can scale (0-3, half steps). Derives a GENERAL widget-level watering
// suggestion from the weather + hydrology the engine already assembles (engine v4:
// recent_precip_in, upcoming/tomorrow precip + pop, rain_coming, hot, highToday) and the existing
// container-vs-in-ground split. 0 = don't water · 1 = light · 2 = normal · 3 = deep soak. Rounded to
// nearest 0.5. Intentionally COARSE: a glanceable widget cue, NOT per-plant cadence (that lives in the
// per-task rows). Two lanes only: containers (dry fast; rain under-serves dense/covered bags) and
// in-ground beds (hold moisture; benefit from rain -> defer for an incoming soak).
// Source of truth: daily-plan-engine-build/weather-widget-redesign/wateringScale.js (LOCKED v1, DRG-TODAY-002).

const clampHalf = (n) => Math.max(0, Math.min(3, Math.round(n * 2) / 2));

// hydrology: { recent_precip_in, tomorrow_precip_in, tomorrow_pop, rain_coming }
// weather:   { hot:boolean, highToday:number }
export function computeWateringScale(hydrology = {}, weather = {}) {
  const recent = hydrology.recent_precip_in ?? 0;
  const tmrwIn = hydrology.tomorrow_precip_in ?? hydrology.upcoming_precip_in ?? 0;
  const tmrwPop = hydrology.tomorrow_pop ?? 0;
  const hot = !!weather.hot;
  // A "real" incoming soak the beds can rely on: >=0.3in at >=50% PoP (engine v4 threshold).
  const rainComing = hydrology.rain_coming ?? (tmrwIn >= 0.3 && tmrwPop >= 50);

  // Containers: base 2 (normal). Rain coming does NOT lower them (it under-serves bags).
  let containers = 2;
  if (hot) containers += 1;                 // hot/dry -> deep soak
  if (recent >= 0.8) containers -= 2;        // heavy recent rain reached the bags
  else if (recent >= 0.4) containers -= 1;   // some recent rain

  // In-ground beds: base 1.5 (hold moisture longer than containers).
  let beds = 1.5;
  if (hot) beds += 1;
  if (recent >= 0.8) beds = 0;               // already soaked
  else if (recent >= 0.4) beds = Math.min(beds, 0.5);
  if (rainComing) beds = 0;                  // wait for the incoming rain (the "wait" pill)

  return {
    containers: clampHalf(containers),
    beds: clampHalf(beds),
    rainComing,
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
