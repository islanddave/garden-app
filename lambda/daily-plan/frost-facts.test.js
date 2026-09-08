// BUG-FROSTALERTNOAPP-001 — the persisted weather facts.
//
// frostEval computes WHEN the cold night is and HOW COLD, and until this change the handler threw
// both away one line after using them: an alerts_sent entry carried key/tier/level/at, all of which
// describe the NOTIFICATION rather than the weather. A client reading those could say no more than
// "an advisory was sent at 11:27pm".
//
// These pin the SHAPE that reaches the stored payload. The client half (src/lib/frostAlertLine.js)
// declines to render an entry with no lowF, so a regression here does not paint a wrong line — it
// silently paints nothing, which is precisely why it needs its own guard rather than relying on the
// UI test to notice.
import { describe, it, expect } from 'vitest';
import h from './handler.js';

const { frostWeatherFacts } = h;

// frostEval's real return shape (frostEval.js: evalAdvisory -> minLowF/dayOffset/date,
// evalImminent -> lowF/level, both carried on the decision record alongside observability).
const advisoryDecision = (over = {}) => ({
  tier: 'advisory', level: 'advisory',
  advisory: { fires: true, minLowF: 38, dayOffset: 2, date: '2026-09-09', coveredDays: 3 },
  imminentGlobal: { fires: false, lowF: 55, level: null },
  ...over,
});

const imminentDecision = (over = {}) => ({
  tier: 'imminent', level: 'protect',
  advisory: { fires: true, minLowF: 34, dayOffset: 1, date: '2026-09-08' },
  imminentGlobal: { fires: true, lowF: 36, level: 'protect' },
  ...over,
});

describe('frostWeatherFacts — what an alerts_sent entry now carries', () => {
  it('takes the ADVISORY window figures, not tonight, for an advisory', () => {
    // The distinction IS the feature: on the night this was written tonight was 55F and the
    // advisory was about a 38F night two days out. Taking imminentGlobal.lowF here would persist
    // 55 and describe the wrong night entirely.
    expect(frostWeatherFacts(advisoryDecision())).toEqual({ lowF: 38, dayOffset: 2, date: '2026-09-09' });
  });

  it('marks an imminent alert as tonight with dayOffset 0', () => {
    // 0 is what the client reads as "tonight" and REFUSES to render, because the freeze cue on
    // Today already covers tonight. An advisory's dayOffset starts at 1 (evalAdvisory: i + 1), so
    // 0 is unambiguous and cannot collide with a real advisory offset.
    expect(frostWeatherFacts(imminentDecision())).toEqual({ lowF: 36, dayOffset: 0 });
  });

  it('carries nothing for heat — its cue is already on Today', () => {
    expect(frostWeatherFacts({ tier: 'heat', level: 'heat', heat: { highF: 91 } })).toEqual({});
  });

  it('omits the facts rather than writing nulls when the engine had no figure', () => {
    // A null lowF must not be persisted as `lowF: null` — the client's guard is `lowF == null`, so
    // either shape renders nothing, but an absent key keeps the stored payload honest about what
    // was actually known. Absence must never be read as 0F (same rule as yesterday_precip_actual_in).
    expect(frostWeatherFacts(advisoryDecision({ advisory: { minLowF: null, dayOffset: 2 } }))).toEqual({});
    expect(frostWeatherFacts(imminentDecision({ imminentGlobal: { lowF: null } }))).toEqual({});
  });

  it('survives a malformed or absent decision without throwing', () => {
    // This runs inside the publish try-block; throwing here would convert a delivered alert into a
    // failed invocation and, worse, skip recording the send — the dedup store would then re-send.
    expect(frostWeatherFacts(null)).toEqual({});
    expect(frostWeatherFacts(undefined)).toEqual({});
    expect(frostWeatherFacts({})).toEqual({});
    expect(frostWeatherFacts({ tier: 'advisory' })).toEqual({});
  });

  it('drops a missing date but keeps the temperature and the offset', () => {
    // forecastDates is optional in evalAdvisory (`(forecastDates && forecastDates[i]) || null`), so
    // a null date is a real state. The line only needs lowF + dayOffset to word itself.
    expect(frostWeatherFacts(advisoryDecision({ advisory: { minLowF: 40, dayOffset: 3, date: null } })))
      .toEqual({ lowF: 40, dayOffset: 3 });
  });
});
