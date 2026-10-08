// BUG-FEEDINTERVALZERO-001 -- a non-positive feeding interval is a MISTAKE, and the plant falls back
// to the default interval. Owner decision 2026-10-08: "Ignore zero, use crop default". Explicitly NOT
// "zero means never remind" -- that is what no_calendar_feed says, in words.
//
// WHY IT IS NOT ALREADY TRUE: v_resolved_care merges system||cultivar||leaf with jsonb || (shallow,
// right-wins). The system row carries fertilize_interval_days:14, and a cultivar row that writes 0
// OVERWRITES it before the engine sees anything, so the 14 is gone by the time fertilizeRec runs.
// BUG-CAREFEEDINHERIT-001 (item 3) stopped 0 from meaning "due every day" by normalizing it to null
// inside fertilizeRec -- but null is "unknown", not "14": no recency gate, so a heavy feeder in fruit
// or anything past 24 weeks is recommended EVERY morning however recently it was fed, and
// daily-plan-read/doneEvents.js:93 refuses to tick such a row done (`if (!(iv > 0)) return false`).
//
// WHAT THIS PINS: resolveCadence, the one place every engine consumer gets its cadence from, restores
// the default (cadence.default.fertilize_interval_days, the bundled mirror of the system row) when the
// resolved value is a non-positive number or NaN. An ABSENT/null interval is left alone, a positive one
// is left alone, and no_calendar_feed still wins.
import { describe, it, expect } from 'vitest';
import engine from './engine.js';
import cad from './cadence-data-v2.json';
import fm from './fertilization-model.json';
import _cf from './_coverFlags.js';
const { withCoverFlags } = _cf;

const { generatePlan, fertilizeRec, resolveCadence } = engine;

const TODAY = '2026-09-08';
const START = '2026-05-01'; // 19 weeks -> mg_tapering_13_24wk: the card is reachable, and not via the phase
const DEFAULT_IV = cad.default.fertilize_interval_days;

const dbP = (profile, o = {}) => ({
  id: 'z1', name: 'Subject', status: 'vegetative', project: 'Bench', project_id: 'pb',
  variety: null, genus: null, substrate_start: START, last_fert: null,
  cadence_scopes: ['cultivar'], db_cadence: { crop: 'houseplant', water_interval_days_container: 7, ...profile }, ...o,
});
const rec = (profile, o) => { const p = dbP(profile, o); return fertilizeRec(p, resolveCadence(p, cad), fm, TODAY); };
const daysAgo = (n) => new Date(Date.parse(TODAY + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);

describe('fixture guard', () => {
  it('the bundled default mirrors the system row (14) and the db profile really is adopted', () => {
    expect(DEFAULT_IV).toBe(14);
    expect(resolveCadence(dbP({ fertilize_interval_days: 30 }), cad)._via).toBe('db');
  });
});

describe('BUG-FEEDINTERVALZERO-001 -- resolveCadence restores the default feeding interval', () => {
  for (const [label, bad] of [['0', 0], ['negative', -5], ['NaN', NaN]]) {
    it(`cultivar ${label} resolves to the default ${DEFAULT_IV}, still via db`, () => {
      const c = resolveCadence(dbP({ fertilize_interval_days: bad }), cad);
      expect(c.fertilize_interval_days).toBe(DEFAULT_IV);
      expect(c._via).toBe('db');
      expect(c.water_interval_days_container).toBe(7); // nothing else in the profile moves
    });

    it(`cultivar ${label} behaves as ${DEFAULT_IV}: held at 5 days since a feed, released at 14 and beyond`, () => {
      expect(rec({ fertilize_interval_days: bad }, { last_fert: daysAgo(5) })).toBeNull();
      expect(rec({ fertilize_interval_days: bad }, { last_fert: daysAgo(13) })).toBeNull();
      const due = rec({ fertilize_interval_days: bad }, { last_fert: daysAgo(14) });
      expect(due).not.toBeNull();
      expect(due.never).toBe(false);
      expect(due.interval).toBe(DEFAULT_IV);
      expect(rec({ fertilize_interval_days: bad }, { last_fert: daysAgo(40) }).interval).toBe(DEFAULT_IV);
    });
  }

  it('THE REGRESSION 0-AS-UNKNOWN LEFT OPEN -- a heavy feeder in fruit, fed 5 days ago, is held', () => {
    // With iv null the recency gate cannot fire and the heavy-feeder arm has no recency check of its
    // own, so this carded every morning. Positive control: the same plant fed 20 days ago does card.
    const hv = { status: 'fruiting' };
    expect(rec({ crop: 'pepper', fertilize_interval_days: 0 }, { ...hv, last_fert: daysAgo(5) })).toBeNull();
    expect(rec({ crop: 'pepper', fertilize_interval_days: 0 }, { ...hv, last_fert: daysAgo(20) })).not.toBeNull();
  });

  it('never fed + interval 0 still cards, now carrying the default rather than null', () => {
    const r = rec({ fertilize_interval_days: 0 });
    expect(r.never).toBe(true);
    expect(r.interval).toBe(DEFAULT_IV);
  });
});

// "Use crop default" means the normal interval for THAT KIND OF PLANT, so the restored value comes from
// the same ladder a planting with no DB profile already climbs -- bundled variety, then genus, then
// cadence.default -- and the first POSITIVE interval on it wins. Straight to the global 14 would make a
// Lithops (bundled: twice a year) a fortnightly feeder. Expected values are read from the data file.
describe('BUG-FEEDINTERVALZERO-001 -- the restored interval is the plant\'s own bundled one first', () => {
  const LITHOPS_IV = cad.by_variety.Lithops.fertilize_interval_days;
  const CAPSICUM_IV = cad.by_genus_fallback.Capsicum.fertilize_interval_days;
  const NULL_GENUS = 'Sempervivum'; // bundled genus entry that ships a null interval
  const NULL_VARIETY = 'Garlic (hardneck)'; // bundled variety entry that ships a null interval
  const ALLIUM_IV = cad.by_genus_fallback.Allium.fertilize_interval_days;

  it('fixture guard: the bundled rungs hold the values these cases lean on', () => {
    expect(LITHOPS_IV).toBe(180);
    expect(CAPSICUM_IV).toBeGreaterThan(0);
    expect(CAPSICUM_IV).not.toBe(DEFAULT_IV);
    expect(cad.by_variety['No Such Pepper']).toBeUndefined();
    expect(cad.by_genus_fallback[NULL_GENUS].fertilize_interval_days).toBe(null);
    expect(cad.by_variety[NULL_VARIETY].fertilize_interval_days).toBe(null);
    expect(ALLIUM_IV).toBeGreaterThan(0);
    expect(ALLIUM_IV).not.toBe(DEFAULT_IV);
  });

  for (const [label, bad] of [['0', 0], ['negative', -5], ['NaN', NaN]]) {
    it(`${label} on a Lithops -> the bundled variety interval (${LITHOPS_IV}), rest of the db profile as adopted`, () => {
      const p = dbP({ crop: 'succulent (Lithops / living stone)', fertilize_interval_days: bad }, { variety: 'Lithops' });
      expect(resolveCadence(p, cad)).toEqual({
        crop: 'succulent (Lithops / living stone)', water_interval_days_container: 7,
        fertilize_interval_days: LITHOPS_IV, _via: 'db',
      });
    });

    it(`${label}, variety not bundled but genus is -> the genus interval (${CAPSICUM_IV})`, () => {
      const c = resolveCadence(dbP({ fertilize_interval_days: bad }, { variety: 'No Such Pepper', genus: 'Capsicum' }), cad);
      expect(c.fertilize_interval_days).toBe(CAPSICUM_IV);
      expect(c._via).toBe('db');
      expect(c.crop).toBe('houseplant');
    });

    it(`${label}, neither variety nor genus bundled -> the global default (${DEFAULT_IV})`, () => {
      const c = resolveCadence(dbP({ fertilize_interval_days: bad }, { variety: 'nope', genus: 'nope' }), cad);
      expect(c.fertilize_interval_days).toBe(DEFAULT_IV);
    });
  }

  it('the variety is found by name too, exactly as the bundled path finds it', () => {
    const p = dbP({ fertilize_interval_days: 0 }, { name: 'Lithops' });
    expect(resolveCadence(p, cad).fertilize_interval_days).toBe(LITHOPS_IV);
  });

  it('a rung with no positive interval is stepped over, not adopted', () => {
    // variety null -> genus positive
    expect(resolveCadence(dbP({ fertilize_interval_days: 0 }, { variety: NULL_VARIETY, genus: 'Allium' }), cad)
      .fertilize_interval_days).toBe(ALLIUM_IV);
    // genus null -> default
    expect(resolveCadence(dbP({ fertilize_interval_days: 0 }, { genus: NULL_GENUS }), cad)
      .fertilize_interval_days).toBe(DEFAULT_IV);
  });

  it('a Lithops with 0 is held on its own clock: silent at 40 days since a feed, due at 180', () => {
    const o = { variety: 'Lithops' };
    expect(rec({ fertilize_interval_days: 0 }, { ...o, last_fert: daysAgo(40) })).toBeNull();
    expect(rec({ fertilize_interval_days: 0 }, { ...o, last_fert: daysAgo(LITHOPS_IV - 1) })).toBeNull();
    expect(rec({ fertilize_interval_days: 0 }, { ...o, last_fert: daysAgo(LITHOPS_IV) }).interval).toBe(LITHOPS_IV);
  });

  it('a POSITIVE, absent or null db interval never consults the bundle, even on a Lithops', () => {
    const o = { variety: 'Lithops' };
    expect(resolveCadence(dbP({ fertilize_interval_days: 30 }, o), cad).fertilize_interval_days).toBe(30);
    expect('fertilize_interval_days' in resolveCadence(dbP({}, o), cad)).toBe(false);
    expect(resolveCadence(dbP({ fertilize_interval_days: null }, o), cad).fertilize_interval_days).toBe(null);
  });

  it('no rung positive (a cadence file with no default) leaves the profile as adopted', () => {
    const bare = { by_variety: {}, by_genus_fallback: {} };
    expect(resolveCadence(dbP({ fertilize_interval_days: 0 }), bare).fertilize_interval_days).toBe(0);
  });
});

describe('BUG-FEEDINTERVALZERO-001 -- everything else is untouched', () => {
  it('a positive cultivar interval is carried as written (both the gate and the release)', () => {
    expect(resolveCadence(dbP({ fertilize_interval_days: 30 }), cad).fertilize_interval_days).toBe(30);
    expect(rec({ fertilize_interval_days: 30 }, { last_fert: daysAgo(20) })).toBeNull();
    expect(rec({ fertilize_interval_days: 30 }, { last_fert: daysAgo(30) }).interval).toBe(30);
    expect(resolveCadence(dbP({ fertilize_interval_days: 1 }), cad).fertilize_interval_days).toBe(1);
  });

  it('an absent or null interval is NOT filled in -- only a number that cannot be a cadence is', () => {
    const absent = resolveCadence(dbP({}), cad);
    expect('fertilize_interval_days' in absent).toBe(false);
    expect(resolveCadence(dbP({ fertilize_interval_days: null }), cad).fertilize_interval_days).toBe(null);
    // and the adopted object is otherwise exactly the profile plus _via
    expect(absent).toEqual({ crop: 'houseplant', water_interval_days_container: 7, _via: 'db' });
  });

  it('the bundled paths resolve exactly as before', () => {
    expect(resolveCadence({ variety: 'Lithops', genus: 'Lithops' }, cad))
      .toEqual({ ...cad.by_variety.Lithops, _via: 'variety:Lithops' });
    expect(resolveCadence({ variety: 'nope', genus: 'nope' }, cad))
      .toEqual({ crop: 'nope', ...cad.default, _via: 'default' });
    // Garlic (hardneck) ships a null interval in the bundle: unknown stays unknown.
    expect(resolveCadence({ variety: 'Garlic (hardneck)' }, cad).fertilize_interval_days).toBe(null);
  });

  it('does not mutate the planting\'s own db_cadence', () => {
    const p = dbP({ fertilize_interval_days: 0 });
    resolveCadence(p, cad);
    expect(p.db_cadence.fertilize_interval_days).toBe(0);
  });
});

describe('BUG-FEEDINTERVALZERO-001 -- no_calendar_feed still wins over the restored default', () => {
  it('fertilizeRec: 0 + no_calendar_feed is silent in every arm (never fed, overdue, heavy in fruit)', () => {
    const lith = { crop: 'succulent (Lithops / living stone)', fertilize_interval_days: 0, no_calendar_feed: true };
    expect(rec({ ...lith, no_calendar_feed: undefined })).not.toBeNull(); // positive control: the key is what silences
    expect(rec(lith)).toBeNull();
    expect(rec(lith, { last_fert: daysAgo(40) })).toBeNull();
    expect(rec({ ...lith, crop: 'pepper' }, { status: 'fruiting', last_fert: daysAgo(40) })).toBeNull();
  });

  it('generatePlan: the Lithops-class row lands in feed_suppressed; a plain 0 row feeds on the default', () => {
    const P = (o) => withCoverFlags({
      assignee_user_id: 'dave', project: 'Bench', project_id: 'pb', project_status: 'active',
      status: 'vegetative', variety: null, genus: null, container_type: 'pot', container_size: '4 in',
      substrate_start: START, transplant_at: null, last_fert: null, last_water: '2026-09-07',
      covered: true, cadence_scopes: ['cultivar'], ...o,
    });
    const prof = { crop: 'houseplant', water_interval_days_container: 7, fertilize_interval_days: 0 };
    const u = generatePlan({
      plantings: [
        P({ id: 'sup', name: 'Lithops', db_cadence: { ...prof, no_calendar_feed: true } }),
        P({ id: 'due', name: 'Fed long ago', last_fert: daysAgo(14), db_cadence: prof }),
        P({ id: 'held', name: 'Fed last week', last_fert: daysAgo(5), db_cadence: prof }),
      ],
      cadence: cad, fertModel: fm, today: TODAY,
      weather: { tonightLow: 62, highToday: 78, unit: 'F' },
      ownerFallback: 'dave',
    }).users.dave;
    expect(u.tasks.fertilize.map((x) => x.id)).toEqual(['due']);
    expect(u.tasks.fertilize[0].interval).toBe(DEFAULT_IV);
    expect(u.tasks.feed_suppressed.map((x) => x.id)).toEqual(['sup']);
  });
});
