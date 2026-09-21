// V5-RADIATIVESUBJECTCOPY-001 — what the radiative-only frost ADVISORY is called, and the same-night "Colder ahead".
//
// THE DEFECTS (live: FROST_RADIATIVE_ENABLED=true in prod).
//   1. A radiative-only advisory fires on a forecast low ABOVE the 40F trip point (a clear, calm night can fall
//      further than forecast). Its email subject read "Garden alert - Frost advisory tonight (low 42F)" and its body
//      "FROST ADVISORY — tonight looks clear and calm (low 42°F …)", while the imminent tier already calls the same
//      case a "Frost watch" / "FROST WATCH TONIGHT".
//   2. A radiative imminent (tonight) carrying a colder advisory for the SAME night printed "Colder ahead: 35°F
//      tonight" — the same night on the other forecast, not a night ahead.
//
// THE FIX, pinned here. The radiative-only advisory is labelled a watch wherever the tier name reaches Dave: the
// body head ("FROST WATCH — …") and the email subject ("Garden alert - Frost watch <night> (low NNF)"). Copy only —
// tier, level and dedup key stay 'advisory'. The same-night clause reads "Colder on a second forecast: 35°F tonight,
// <date> — …"; the different-night clause is byte-identical to before. (The Today line names no tier and is untouched.)
// CHANGED by V5-TODAYRADIATIVEWATCH-001 (lane frostwatch, 2026-09-21): no longer untouched. The advisory entry now records
// `trip: 'radiative'` and the Today line says "Frost watch <night> — clear and calm, low N°F. …" (Dave: "Show it on
// Today"); the two cases below that pinned the old entry and line are marked.
//
// Every decision here comes out of the real frostEval, and every subject out of the real handler.frostSubject.
// Run under TZ=UTC and TZ=America/New_York.
//
// MUTATION LOG — 2026-09-19, lane-radiativefix-20260919. Each applied alone to frostEval.js / handler.js; the 11 frost
// test files (362 tests) run under BOTH zones; restored and sha256-checked against HEAD. All RED, same tests in both
// zones; every test in this file is killed by at least one. RED counts over the 362:
//   body label reverted 16 · subject label reverted 7 · subject "watch" for every advisory 19 · subject reads the flag
//   before the tier 1 · record never flagged 8 · every advisory flagged 17 · flag from the unfiltered set 1 · the watch
//   changes the level 2 · same-night wording never used 6 / always used 3 / keyed on dayOffset 3 / keyed on the
//   base-rate night 3.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fe from './frostEval.js';
import h from './handler.js';
import _cf from './_coverFlags.js';
import { buildFrostAlertLine } from '../../src/lib/frostAlertLine.js';

const { frostEval, dedupKey } = fe;
const { run, frostSubject, frostWeatherFacts } = h;
const { withCoverFlags } = _cf;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────
const PLAN = '2026-10-09';                                    // Fri; D1 Sat 10-10, D2 Sun 10-11, D3 Mon 10-12
const DATES = ['2026-10-10', '2026-10-11', '2026-10-12'];
const T = { ADVISORY_LOW_F: 40, IMMINENT_LOW_F: 38, HARD_FREEZE_LOW_F: 33 };
const tender = (over = {}) => ({ slug: 'pepper', label: 'peppers', band: 'tender', count: 5, containers: 1, thresholds: T, ...over });
const pad = (n) => String(n).padStart(2, '0');
const stamps = (date) => Array.from({ length: 24 }, (_, i) => `${date}T${pad(i)}:00`);
const dayCurve = (low, hour) => Array.from({ length: 24 }, (_, i) => (i === hour ? low : low + 4 + Math.abs(i - hour) * 0.5));
const minAt = (date, low, hour) => ({ time: stamps(date), temperature_2m: dayCurve(low, hour) });
const clear = (date, minDewpointF = 33) => ({ date, minDewpointF, meanCloudPct: 5, meanWindMph: 2, hours: 15, radiative: true });
const cloudy = (date) => ({ date, minDewpointF: 33, meanCloudPct: 95, meanWindMph: 12, hours: 15, radiative: false });

const ev = (over = {}, opts = {}) => frostEval({
  tonightLow: 55, highToday: 60, forecastLows: [42, 50, 51], forecastDates: DATES, lowSource: 'forecast',
  forecastHourly: minAt('2026-10-10', 42, 5), radiativeNights: [clear('2026-10-09')],
  exposure: { tender: 5, unknown: 0, tenderContainers: 1, atRisk: 5, byCropType: [tender()] },
  spaceId: 'S1', eventDate: PLAN, ...over,
}, { frostSeason: true, radiativeEnabled: true, ...opts });

const TAIL = ' At risk: peppers (5). 5 plantings, 1 in containers. Harvest ahead and stage row cover.';
// CHANGED by V5-TODAYFROSTLINEGAPS-001 follow-up F3 (Dave 2026-09-21): an advisory naming TONIGHT closes with what to do
// tonight. Both cases below that used TAIL name tonight, so they now use TAIL_TONIGHT; TAIL stays for a later night.
const TAIL_TONIGHT = ' At risk: peppers (5). 5 plantings, 1 in containers. Pick what\'s ripe and cover tender plants tonight.';

// ── 1 — the radiative-only advisory is a WATCH, in the body and the subject ─────────────────────────────
describe('radiative-only advisory — labelled a watch where the tier name reaches Dave', () => {
  it('body and subject, exact: tonight (morning minimum)', () => {
    const r = ev();
    expect(r.tier).toBe('advisory');
    expect(r.message).toBe('FROST WATCH — tonight looks clear and calm (low 42°F, 2026-10-10, dewpoint 33°F), so it can fall ' +
      `further than the forecast.${TAIL_TONIGHT}`);
    expect(frostSubject(r)).toBe('Garden alert - Frost watch tonight (low 42F)');
    // BEFORE (base 10452156): 'Garden alert - Frost advisory tonight (low 42F)' over 'FROST ADVISORY — tonight looks …'
  });

  it('every night phrase: tomorrow night (evening minimum) and a weekday (D3)', () => {
    const late = ev({ forecastHourly: minAt('2026-10-10', 42, 23), radiativeNights: [clear('2026-10-10')] });
    expect(late.message.startsWith('FROST WATCH — tomorrow night looks clear and calm (low 42°F, 2026-10-10, dewpoint 33°F)')).toBe(true);
    expect(frostSubject(late)).toBe('Garden alert - Frost watch tomorrow night (low 42F)');
    const d3 = ev({ forecastLows: [50, 51, 42], forecastHourly: minAt('2026-10-12', 42, 7), radiativeNights: [clear('2026-10-11')] });
    expect(d3.message.startsWith('FROST WATCH — Sunday night looks clear and calm (low 42°F, 2026-10-12, dewpoint 33°F)')).toBe(true);
    expect(frostSubject(d3)).toBe('Garden alert - Frost watch Sunday night (low 42F)');
  });

  it('a crop the global gate filtered out does not stop the watch label (the named set is what counts)', () => {
    // 42 > 40: the global gate is shut. Basil's own band (47) is met, but it is filtered from the named set; the
    // only NAMED crop tripped radiatively, so the body is the watch copy and the subject agrees.
    const chill = { ADVISORY_LOW_F: 47, IMMINENT_LOW_F: 45, HARD_FREEZE_LOW_F: 36 };
    const r = ev({ exposure: { tender: 9, unknown: 0, atRisk: 9, byCropType: [tender(), tender({ slug: 'basil', label: 'basil', count: 4, thresholds: chill })] } });
    expect(r.trippedCrops.map((c) => c.slug)).toEqual(['pepper']);
    expect(r.message.startsWith('FROST WATCH — tonight looks clear and calm')).toBe(true);
    expect(frostSubject(r)).toBe('Garden alert - Frost watch tonight (low 42F)');
  });

  it('copy only: tier, level and dedup key are the advisory\'s, as before; the stored entry adds the trip basis', () => {
    const r = ev();
    expect([r.tier, r.level]).toEqual(['advisory', 'advisory']);
    expect(r.dedupKey).toBe(dedupKey({ spaceId: 'S1', eventDate: PLAN, tier: 'advisory', level: 'advisory', crops: r.trippedCrops }));
    expect(r.dedupKey.startsWith('S1|2026-10-09|advisory|advisory|')).toBe(true);
    expect(r.observability).toMatchObject({ tier: 'advisory', level: 'advisory' });
    // CHANGED by V5-TODAYRADIATIVEWATCH-001 (lane frostwatch, 2026-09-21): the entry also records the trip basis, so
    // the Today line can say watch. It was { lowF, dayOffset, date, nightOffset } exactly; tier/level/key are unchanged.
    expect(frostWeatherFacts(r)).toEqual({ lowF: 42, dayOffset: 1, date: '2026-10-10', nightOffset: 0, trip: 'radiative' });
    expect(r.advisory.radiativeOnly).toBe(true);
  });
});

describe('every OTHER advisory keeps "Frost advisory" — the label follows the body', () => {
  it('a threshold advisory: body and subject unchanged', () => {
    const r = ev({ forecastLows: [37, 50, 51], forecastHourly: minAt('2026-10-10', 37, 5) });
    expect(r.message).toBe(`FROST ADVISORY — frost possible tonight (low 37°F, 2026-10-10).${TAIL_TONIGHT}`);
    // ...and the same threshold advisory for TOMORROW night keeps the old close, byte for byte (evening minimum)
    const later = ev({ forecastLows: [37, 50, 51], forecastHourly: minAt('2026-10-10', 37, 23) });
    expect(later.message).toBe(`FROST ADVISORY — frost possible tomorrow night (low 37°F, 2026-10-10).${TAIL}`);
    expect(frostSubject(r)).toBe('Garden alert - Frost advisory tonight (low 37F)');
    expect(r.advisory).not.toHaveProperty('radiativeOnly');
  });

  it('a MIXED advisory (one crop on its trip point, one radiative) keeps the plain copy and the plain label', () => {
    const cold = { ADVISORY_LOW_F: 36, IMMINENT_LOW_F: 34, HARD_FREEZE_LOW_F: 30 };
    const r = ev({ forecastLows: [39, 50, 51], forecastHourly: minAt('2026-10-10', 39, 5),
      exposure: { tender: 9, unknown: 0, atRisk: 9, byCropType: [tender(), tender({ slug: 'chard', label: 'chard', count: 4, thresholds: cold })] } });
    expect(r.trippedCrops.map((c) => c.trip || 'threshold').sort()).toEqual(['radiative', 'threshold']);
    expect(r.message.startsWith('FROST ADVISORY — frost possible tonight (low 39°F, 2026-10-10).')).toBe(true);
    expect(frostSubject(r)).toBe('Garden alert - Frost advisory tonight (low 39F)');
  });

  it('no crop breakdown (the legacy global path) is never a watch', () => {
    const r = ev({ forecastLows: [39, 50, 51], forecastHourly: minAt('2026-10-10', 39, 5), exposure: { tender: 3, unknown: 0, tenderContainers: 0 } });
    expect(r.message.startsWith('FROST ADVISORY — frost possible tonight')).toBe(true);
    expect(frostSubject(r)).toBe('Garden alert - Frost advisory tonight (low 39F)');
  });

  it('LABEL PARITY GRID — body WATCH <=> subject "Frost watch"; and a watch is only ever a radiative-only set', () => {
    let watch = 0; let plain = 0;
    const cold = { ADVISORY_LOW_F: 36, IMMINENT_LOW_F: 34, HARD_FREEZE_LOW_F: 30 };
    const sets = [[tender()], [tender(), tender({ slug: 'chard', label: 'chard', count: 4, thresholds: cold })], [tender({ thresholds: cold })]];
    for (const low of [35, 38, 39, 40, 41, 42, 44, 45]) {
      for (const hour of [5, 23, null]) {
        for (const nights of [[], [clear('2026-10-09')], [clear('2026-10-10')], [clear('2026-10-09', 39), clear('2026-10-10', 30)], [cloudy('2026-10-09')]]) {
          for (const byCropType of sets) {
            const r = ev({ forecastLows: [low, 55, 56], forecastHourly: hour == null ? null : minAt('2026-10-10', low, hour), radiativeNights: nights,
              exposure: { tender: 9, unknown: 0, atRisk: 9, byCropType } });
            if (r.tier !== 'advisory') continue;
            const at = `low=${low} hour=${hour} nights=${nights.map((n) => n.date).join('+')} crops=${byCropType.length}`;
            const s = frostSubject(r);
            const bodyWatch = r.message.startsWith('FROST WATCH — ');
            expect(bodyWatch || r.message.startsWith('FROST ADVISORY — '), at).toBe(true);
            expect(s.startsWith(bodyWatch ? 'Garden alert - Frost watch ' : 'Garden alert - Frost advisory '), at).toBe(true);
            if (bodyWatch) {
              expect(r.trippedCrops.every((c) => c.trip === 'radiative'), at).toBe(true);
              watch++;
            } else plain++;
          }
        }
      }
    }
    expect(watch).toBeGreaterThan(10);
    expect(plain).toBeGreaterThan(10);
  });

  it('imminent and heat subjects do not move (the radiative imminent was already a watch)', () => {
    const im = ev({ tonightLow: 39, forecastLows: [45, 46, 47], forecastHourly: null });
    expect(im.tier).toBe('imminent');
    expect(frostSubject(im)).toBe('Garden alert - Frost watch tonight (low 39F)');
    expect(frostSubject(ev({ tonightLow: 36 }))).toBe('Garden alert - Frost protect tonight (low 36F)');
    expect(frostSubject({ tier: 'heat', level: 'heat', advisory: { radiativeOnly: true }, observability: { tonightLowF: 70 } }))
      .toBe('Garden alert - Heat advisory (low 70F)');
  });
});

// ── 2 — "Colder ahead" when the colder advisory is about the SAME night ─────────────────────────────────
describe('radiative imminent + colder advisory — the same night is not "ahead"', () => {
  // Imminent: NWS 39F tonight (above 38), night 10-09 clear and calm -> FROST WATCH TONIGHT. Advisory: D1 35F.
  const watch = (hourly, over = {}) => ev({ tonightLow: 39, forecastLows: [35, 50, 51], forecastHourly: hourly, ...over });
  const IMMINENT = 'FROST WATCH TONIGHT — forecast low 39°F, but clear and calm (5% cloud, wind 2 mph) and the dewpoint is 33°F, ' +
    'so it can fall further than the forecast. Cover, or bring containers in: peppers (5). 5 plantings, 1 in containers.';

  it('D1 minimum at 04:00 is tonight\'s own minimum on the other forecast: exact message', () => {
    const r = watch(minAt('2026-10-10', 35, 4));
    expect(r.tier).toBe('imminent');
    // CHANGED by V5-TODAYFROSTLINEGAPS-001 (lane frostlinegaps, 2026-09-21): the same-night close was "— harvest ahead
    // and stage row cover." (Dave: a same-night clause says what to do tonight). The later-night close is unchanged.
    expect(r.message).toBe(`${IMMINENT} Colder on a second forecast: 35°F tonight, 2026-10-10 — pick what's ripe and cover tender plants tonight.`);
    // BEFORE (base 10452156): `${IMMINENT} Colder ahead: 35°F tonight, 2026-10-10 — harvest ahead and stage row cover.`
    expect(frostSubject(r)).toBe('Garden alert - Frost watch tonight (low 39F)');
  });

  it('no hourly series: the base-rate night of D1 is tonight too, so the same wording', () => {
    const r = watch(null);
    expect(r.advisory).toMatchObject({ nightOffset: 0, nightBasis: 'base_rate' });
    // CHANGED by V5-TODAYFROSTLINEGAPS-001: the same-night close (was "— harvest ahead and stage row cover.").
    expect(r.message.endsWith(' Colder on a second forecast: 35°F tonight, 2026-10-10 — pick what\'s ripe and cover tender plants tonight.')).toBe(true);
  });

  it('a DIFFERENT night keeps the old wording byte for byte', () => {
    // The old clause, verbatim from base 10452156 (frostEval.js), for a record naming a night other than tonight.
    const legacy = (a) => ` Colder ahead: ${a.minLowF}°F ${fe.nightPhrase(fe.advisoryNight(a))}${a.date ? `, ${a.date}` : ''} — harvest ahead and stage row cover.`;
    const d1Evening = watch(minAt('2026-10-10', 35, 22));
    expect(d1Evening.message).toBe(`${IMMINENT}${legacy(d1Evening.advisory)}`);
    expect(d1Evening.message.endsWith(' Colder ahead: 35°F tomorrow night, 2026-10-10 — harvest ahead and stage row cover.')).toBe(true);
    const d2 = watch(minAt('2026-10-11', 35, 6), { forecastLows: [50, 35, 51] });
    expect(d2.message.endsWith(' Colder ahead: 35°F tomorrow night, 2026-10-11 — harvest ahead and stage row cover.')).toBe(true);
    const d3 = watch(minAt('2026-10-12', 35, 23), { forecastLows: [50, 51, 35] });
    expect(d3.message.endsWith(' Colder ahead: 35°F Monday night, 2026-10-12 — harvest ahead and stage row cover.')).toBe(true);
  });

  it('GRID — "Colder ahead" never describes tonight, and the colder figure always survives', () => {
    let same = 0; let ahead = 0;
    for (const day of [0, 1, 2]) {
      for (const hour of [0, 4, 7, 11, 12, 18, 23, null]) {
        for (const low of [30, 34.5, 36, 37]) {
          const lows = [50, 51, 52]; lows[day] = low;
          const r = watch(hour == null ? null : minAt(DATES[day], low, hour), { forecastLows: lows });
          const at = `D${day + 1} hour=${hour} low=${low}`;
          expect(r.tier, at).toBe('imminent');
          expect(r.message, at).not.toMatch(/Colder ahead: [^,]* tonight/);
          expect(r.message, at).toContain(`${low}°F`);
          const tonight = r.advisory.nightOffset === 0;
          expect(r.message.includes(' Colder on a second forecast: '), at).toBe(tonight);
          expect(r.message.includes(' Colder ahead: '), at).toBe(!tonight);
          // V5-TODAYFROSTLINEGAPS-001 — each lead keeps its own close: tonight's says what to do tonight.
          expect(r.message.endsWith(tonight ? ' — pick what\'s ripe and cover tender plants tonight.' : ' — harvest ahead and stage row cover.'), at).toBe(true);
          expect(r.message.includes('harvest ahead'), at).toBe(!tonight);
          if (tonight) same++; else ahead++;
        }
      }
    }
    expect(same).toBeGreaterThan(0);
    expect(ahead).toBeGreaterThan(0);
  });

  // V5-TODAYFROSTLINEGAPS-001 — the same-night close is 15 characters longer than the old one. The whole message still
  // goes through truncate() (the SMS-era cap, MAX_MESSAGE_CHARS 900): a big garden keeps the clause whole under it, and
  // a message that would pass it is cut and marked, never sent long. The subject is built separately and does not move.
  it('LENGTH — the longer close stays inside the cap on a big garden, and truncate() still owns the cap', () => {
    const many = (n, label) => Array.from({ length: n }, (_, i) => tender({ slug: `c${i}`, label: label(i), count: 9, containers: 9 }));
    const big = watch(minAt('2026-10-10', 34.5, 4), { forecastLows: [34.5, 50, 51],
      exposure: { tender: 360, unknown: 12, tenderContainers: 360, atRisk: 360, byCropType: many(40, (i) => `crop-with-a-long-name-${i}`) } });
    expect(big.tier).toBe('imminent');
    expect(big.message.length).toBeLessThanOrEqual(fe.MAX_MESSAGE_CHARS);
    expect(big.message.endsWith(' Colder on a second forecast: 34.5°F tonight, 2026-10-10 — pick what\'s ripe and cover tender plants tonight.')).toBe(true);
    expect(frostSubject(big)).toBe('Garden alert - Frost watch tonight (low 39F)');
    // A crop list long enough to pass the cap: the combined message is cut at the cap and marked, never sent long.
    const huge = watch(minAt('2026-10-10', 34.5, 4), { forecastLows: [34.5, 50, 51],
      exposure: { tender: 54, unknown: 0, tenderContainers: 54, atRisk: 54, byCropType: many(6, (i) => `${'x'.repeat(130)}${i}`) } });
    expect(huge.tier).toBe('imminent');
    expect(huge.message.length).toBeLessThanOrEqual(fe.MAX_MESSAGE_CHARS);
    expect(huge.message.length).toBeGreaterThan(fe.MAX_MESSAGE_CHARS - 10);
    expect(huge.message.endsWith('…')).toBe(true);
  });
});

// ── 2b — V5-TODAYFROSTLINEGAPS-001 follow-up F3: an ADVISORY about tonight closes with what to do tonight ──────────
// Dave (2026-09-21): the close of an advisory email naming TONIGHT is "Pick what's ripe and cover tender plants tonight."
// (capital P: it starts a sentence here), for the FROST ADVISORY head and the advisory-tier FROST WATCH head alike; an
// advisory about a later night keeps "Harvest ahead and stage row cover.". The night is the one the head names.
describe('advisory close — tonight says what to do tonight, a later night keeps the lead-time close', () => {
  const PICK = ' Pick what\'s ripe and cover tender plants tonight.';
  const HARVEST = ' Harvest ahead and stage row cover.';
  const nights = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'].map((d) => clear(d));

  it('GRID — both heads, every night the hours (or their absence) can name: the close follows the head\'s night', () => {
    const seen = { advisoryTonight: 0, advisoryLater: 0, watchTonight: 0, watchLater: 0 };
    for (const [low, radiativeNights] of [[37, []], [42, nights]]) {
      for (const day of [0, 1, 2]) {
        for (const hour of [0, 5, 11, 12, 18, 23, null]) {
          const lows = [50, 51, 52]; lows[day] = low;
          const r = ev({ forecastLows: lows, forecastHourly: hour == null ? null : minAt(DATES[day], low, hour), radiativeNights });
          const at = `low=${low} D${day + 1} hour=${hour}`;
          expect(r.tier, at).toBe('advisory');
          const watch = r.message.startsWith('FROST WATCH — ');
          const tonight = fe.advisoryNight(r.advisory).nightOffset === 0;
          // the head's own night phrase agrees with the predicate that picks the close
          expect(r.message.startsWith(watch ? 'FROST WATCH — tonight ' : 'FROST ADVISORY — frost possible tonight '), at).toBe(tonight);
          expect(r.message.endsWith(tonight ? PICK : HARVEST), at).toBe(true);
          expect(r.message.includes(tonight ? HARVEST : PICK), at).toBe(false);
          seen[`${watch ? 'watch' : 'advisory'}${tonight ? 'Tonight' : 'Later'}`]++;
        }
      }
    }
    for (const [k, n] of Object.entries(seen)) expect(n, k).toBeGreaterThan(0);
  });

  it('the no-crop-breakdown path (untruncated) closes the same way', () => {
    const legacy = (hour) => ev({ forecastLows: [37, 50, 51], forecastHourly: minAt('2026-10-10', 37, hour), exposure: { tender: 3, unknown: 0, tenderContainers: 0 } });
    expect(legacy(5).message).toBe(`FROST ADVISORY — frost possible tonight (low 37°F, 2026-10-10). ~3 tender plantings.${PICK}`);
    expect(legacy(23).message).toBe(`FROST ADVISORY — frost possible tomorrow night (low 37°F, 2026-10-10). ~3 tender plantings.${HARVEST}`);
  });

  it('LENGTH — a big garden keeps the whole tonight close under the cap; a list that passes it is cut and marked', () => {
    const many = (n, label) => Array.from({ length: n }, (_, i) => tender({ slug: `c${i}`, label: label(i), count: 9, containers: 9 }));
    for (const [low, radiativeNights] of [[37, []], [42, nights]]) {
      const big = ev({ forecastLows: [low, 50, 51], forecastHourly: minAt('2026-10-10', low, 5), radiativeNights,
        exposure: { tender: 360, unknown: 12, tenderContainers: 360, atRisk: 360, byCropType: many(40, (i) => `crop-with-a-long-name-${i}`) } });
      expect(big.message.length, `low ${low}`).toBeLessThanOrEqual(fe.MAX_MESSAGE_CHARS);
      expect(big.message.endsWith(PICK), `low ${low}`).toBe(true);
      const huge = ev({ forecastLows: [low, 50, 51], forecastHourly: minAt('2026-10-10', low, 5), radiativeNights,
        exposure: { tender: 54, unknown: 0, tenderContainers: 54, atRisk: 54, byCropType: many(6, (i) => `${'x'.repeat(140)}${i}`) } });
      expect(huge.message.length, `low ${low}`).toBeLessThanOrEqual(fe.MAX_MESSAGE_CHARS);
      expect(huge.message.length, `low ${low}`).toBeGreaterThan(fe.MAX_MESSAGE_CHARS - 10);
      expect(huge.message.endsWith('…'), `low ${low}`).toBe(true);
    }
  });
});

// ── 3 — end to end through the real run() ───────────────────────────────────────────────────────────────
const SPACE = 'sp1';
const planting = (id, slug) => withCoverFlags({
  id, name: `${slug} ${id}`, project_id: 'pj1', status: 'fruiting', container_type: 'pot',
  container_size: '5gal', rain_exposed: null, variety: slug, genus: null, project: 'Garden',
  project_status: 'active', workspace_id: SPACE, crop_type_slug: slug, covered: false,
  assignee_user_id: 'user_dave', db_cadence: null, last_water: '2026-10-08', last_fert: '2026-09-20',
  substrate_start: '2026-05-01', transplant_at: null,
});
// A clear, calm night keyed 10-09 (18:00 -> 08:00), index.js hourly_frost shape.
const clearBlock = () => {
  const time = [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8].map((hr) => `${hr >= 18 ? '2026-10-09' : '2026-10-10'}T${pad(hr)}:00`);
  return { time, dew_point_2m: time.map(() => 33), cloud_cover: time.map(() => 4), wind_speed_10m: time.map(() => 2), timezone: 'America/New_York' };
};

async function drive({ lows, hourlyTemp, tonightLow }) {
  vi.stubEnv('FROST_ALERT_ENABLED', 'true');
  vi.stubEnv('FROST_RADIATIVE_ENABLED', 'true');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const writes = [];
  const pg = { query: vi.fn(async (sql, params) => {
    if (/insert into daily_plan/.test(sql)) { writes.push(JSON.parse(params[2])); return { rows: [] }; }
    if (/from plants/.test(sql)) return { rows: [planting('p1', 'pepper')] };
    if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
    return { rows: [] };
  }) };
  const publishAlert = vi.fn(async () => ({ messageId: 'mid-1' }));
  await run({
    pg, today: PLAN, dryRun: false, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow, highToday: 60, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: async () => ({ forecast_lows: lows, forecast_dates: DATES, hourly_temp: hourlyTemp, hourly_frost: clearBlock(),
      recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0,
      yesterday_precip_actual_in: 0 }),
    fetchStation: async () => null, publishAlert, etHour: 15, event: {},
  });
  return { frost: publishAlert.mock.calls.map(([a]) => a).filter((a) => a.topic === 'frost'), row: writes.at(-1) };
}

describe('END TO END — what the real run() publishes', () => {
  it('a radiative-only advisory goes out as a watch; the stored entry records the trip and the Today line says watch', async () => {
    const { frost, row } = await drive({ lows: [42, 50, 51], hourlyTemp: minAt('2026-10-10', 42, 5), tonightLow: 55 });
    expect(frost).toHaveLength(1);
    expect(frost[0].subject).toBe('Garden alert - Frost watch tonight (low 42F)');
    expect(frost[0].message.startsWith('FROST WATCH — tonight looks clear and calm (low 42°F, 2026-10-10, dewpoint 33°F), so it can fall further than the forecast.')).toBe(true);
    // CHANGED by V5-TODAYRADIATIVEWATCH-001 (lane frostwatch, 2026-09-21): the entry records the radiative trip and the
    // Today line says watch, as the email does. Was: no `trip`, and "Frost possible tonight — low 42°F. …".
    expect(row.alerts_sent.at(-1)).toMatchObject({ tier: 'advisory', level: 'advisory', lowF: 42, nightOffset: 0, trip: 'radiative' });
    expect(buildFrostAlertLine(row.alerts_sent).text).toBe('Frost watch tonight — clear and calm, low 42°F. Plan cover for tender plants.');
  });

  it('a radiative imminent with a colder same-night advisory: the second forecast is named, not "ahead"', async () => {
    const { frost } = await drive({ lows: [35, 50, 51], hourlyTemp: minAt('2026-10-10', 35, 4), tonightLow: 39 });
    expect(frost).toHaveLength(1);
    expect(frost[0].subject).toBe('Garden alert - Frost watch tonight (low 39F)');
    // CHANGED by V5-TODAYFROSTLINEGAPS-001: the same-night close (was "— harvest ahead and stage row cover.").
    expect(frost[0].message.endsWith(' Colder on a second forecast: 35°F tonight, 2026-10-10 — pick what\'s ripe and cover tender plants tonight.')).toBe(true);
  });
});
