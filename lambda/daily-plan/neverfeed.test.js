// BUG-CAREFEEDINHERIT-001 — "never feed" must be EXPRESSIBLE, plus two defects found on the same path.
//
// THE MECHANISM: v_resolved_care merges system||cultivar||leaf with the jsonb || operator — shallow,
// top-level, right-wins. The system row carries fertilize_interval_days:14, so a cultivar profile that
// OMITS the key silently INHERITS 14 (51 cultivar rows / 52 live plantings on prod, 2026-09-08).
//
// WHY NO NUMBER CAN FIX IT, which is the whole reason this file exists: `never` (engine.js :672) cards
// any planting with no feed history REGARDLESS of interval, and the recency gate (:651) only holds a
// card down once a feed exists. Prod carded "Greek Oregano" (interval 30) and "Oregano" (interval 60)
// on 2026-09-08, both never=true. So suppression had to be a BRANCH: no_calendar_feed:true, the feed
// twin of the shipped no_calendar_water.
//
// ANTI-VACUITY IS THE POINT OF THE FIXTURES. All five ticket plantings are in establishment_0_2wk,
// where fertilizeRec returns null at :622 for its own reasons — a "no feed card" test built on them
// would pass with this entire change deleted. Every fixture below is at 19 weeks (mg_tapering_13_24wk)
// and every suppression case is paired with a POSITIVE CONTROL asserting the card is there first.
//
// Per-test mutation proofs are recorded in the commit body and in
// project-state/_lane-neverfeed-20260908.md. Every assertion here was watched to fail.
import { describe, it, expect } from 'vitest';
import engine from './engine.js';
import cad from './cadence-data-v2.json';
import fm from './fertilization-model.json';
import _cf from './_coverFlags.js';
const { withCoverFlags } = _cf;

const { generatePlan, fertilizeRec, feedSuppression, feedPhase, isMedHerb } = engine;

const TODAY = '2026-09-08';
// 2026-05-01 -> 19 weeks: past the MG-active window, short of needs_feed_24wk_plus. The card can appear,
// and it appears for a REASON THAT IS NOT THE PHASE — which is what makes suppression observable.
const START = '2026-05-01';

const p = (o = {}) => ({
  id: 'x1', name: 'Subject', status: 'vegetative', project: 'Bench', project_id: 'pb',
  substrate_start: START, last_fert: null, ...o,
});

// The prod shape of the 51 affected rows: no feed key of its own, so the view handed it the system 14.
const INHERITED = { crop: 'perennial (Solidago)', fertilize_interval_days: 14 };
// Penstemon's ACTUAL prod value — a cultivar author reaching for a number to mean "basically never".
const YEARLY = { crop: 'perennial (Penstemon)', fertilize_interval_days: 365 };

describe('fixture guard — the card is reachable at all (this file is worthless if it is not)', () => {
  it('19 weeks is mg_tapering_13_24wk, not the establishment phase the ticket plants sit in', () => {
    expect(feedPhase(19)).toBe('mg_tapering_13_24wk');
    expect(feedPhase(1)).toBe('establishment_0_2wk');
    expect(fertilizeRec(p(), INHERITED, fm, TODAY).phase).toBe('mg_tapering_13_24wk');
    // And the establishment fixture really is silent for its own reason — the trap this file avoids.
    expect(fertilizeRec(p({ substrate_start: '2026-09-01' }), INHERITED, fm, TODAY)).toBeNull();
  });
});

describe('feedSuppression (pure)', () => {
  it('reads no_calendar_feed from the resolved cadence', () => {
    expect(feedSuppression({}, { no_calendar_feed: true })).toBe('no_calendar_feed');
  });
  it('reads the RAW db_cadence even when resolveCadence dropped the profile (live unseeded shape)', () => {
    // The load-bearing half: a profile can refuse feeding while contributing no WATER cadence key, so
    // cadence_scopes is empty, the bundled JSON wins, and `c` never contains the key at all.
    expect(feedSuppression({ db_cadence: { no_calendar_feed: true } }, { crop: 'unknown' })).toBe('no_calendar_feed');
  });
  it('null for a plain profile; truthy-but-not-true does NOT suppress', () => {
    expect(feedSuppression({}, INHERITED)).toBe(null);
    expect(feedSuppression({}, { no_calendar_feed: 'yes' })).toBe(null);
    expect(feedSuppression({}, { no_calendar_feed: 1 })).toBe(null);
    expect(feedSuppression({}, {})).toBe(null);
    expect(feedSuppression(null, null)).toBe(null);
  });
});

describe('BUG-CAREFEEDINHERIT-001 — no_calendar_feed suppresses where no interval can', () => {
  it('the INHERITED-14 row: carded via `never`, then silenced by the key', () => {
    expect(fertilizeRec(p(), INHERITED, fm, TODAY).never).toBe(true);          // positive control
    expect(fertilizeRec(p(), { ...INHERITED, no_calendar_feed: true }, fm, TODAY)).toBeNull();
  });

  it('A HUGE INTERVAL DOES NOT SUPPRESS — 365 still cards; only the key silences it', () => {
    // This is the ticket's central claim, executable. Penstemon's real prod row is 365 and it is
    // cardable; if this first assertion ever goes green-by-null the fix has been rewritten as a number
    // again and the mechanism is back.
    const rec = fertilizeRec(p(), YEARLY, fm, TODAY);
    expect(rec).not.toBeNull();
    expect(rec.never).toBe(true);
    expect(rec.interval).toBe(365);
    expect(fertilizeRec(p(), { ...YEARLY, no_calendar_feed: true }, fm, TODAY)).toBeNull();
  });

  it('beats `due` as well as `never` — a fed, overdue planting is suppressed too', () => {
    // `never` is not the only way in. A row 20 days past a 17-day cadence qualifies via `due`, so this
    // proves the guard is not merely shadowing the no-history arm.
    const fed = p({ last_fert: '2026-08-19' });
    const c = { crop: 'perennial (Penstemon)', fertilize_interval_days: 17 };
    expect(fertilizeRec(fed, c, fm, TODAY).never).toBe(false);                 // positive control: due
    expect(fertilizeRec(fed, { ...c, no_calendar_feed: true }, fm, TODAY)).toBeNull();
  });

  it('beats the heavy-feeder-in-fruit arm, the one branch with no recency check of its own', () => {
    const hv = p({ status: 'fruiting', last_fert: '2026-08-19' });
    const c = { crop: 'pepper', fertilize_interval_days: 17 };
    expect(fertilizeRec(hv, c, fm, TODAY)).not.toBeNull();                     // positive control
    expect(fertilizeRec(hv, { ...c, no_calendar_feed: true }, fm, TODAY)).toBeNull();
  });

  it('a non-suppressed planting is untouched (the guard is scoped, not a blanket off-switch)', () => {
    expect(fertilizeRec(p(), INHERITED, fm, TODAY)).not.toBeNull();
    expect(fertilizeRec(p(), { ...INHERITED, no_calendar_water: true }, fm, TODAY)).not.toBeNull();
  });
});

// ── ITEM 3 — fertilize_interval_days:0 read as "always due" ────────────────────────────────────────
describe('BUG-CAREFEEDINHERIT-001 (item 3) — a non-positive interval is not a cadence', () => {
  const ZERO = { crop: 'succulent (Lithops / living stone)', fertilize_interval_days: 0 };

  it('0 no longer manufactures a `due` the day after a feed (the prod Lithops shape)', () => {
    // Pre-change: iv=0 => the recency gate needs dF<0 and can never fire, and due is dF>=0, so this
    // carded EVERY morning for as long as the plant lived.
    expect(fertilizeRec(p({ last_fert: '2026-09-07' }), ZERO, fm, TODAY)).toBeNull();
    expect(fertilizeRec(p({ last_fert: '2026-06-01' }), ZERO, fm, TODAY)).toBeNull();
    expect(fertilizeRec(p({ last_fert: '2026-09-07', status: 'flowering' }), { ...ZERO, crop: 'houseplant' }, fm, TODAY)).toBeNull();
  });

  it('a negative interval is treated the same way', () => {
    expect(fertilizeRec(p({ last_fert: '2026-09-07' }), { ...ZERO, fertilize_interval_days: -5 }, fm, TODAY)).toBeNull();
  });

  it('0 is NOT read as never-feed — a never-fed row still cards, carrying interval null not 0', () => {
    // Deliberate non-decision, pinned so nobody quietly promotes 0 to a suppression sentinel: that is
    // what no_calendar_feed is for, and an overloaded number is what made this ambiguous to begin with.
    const rec = fertilizeRec(p(), ZERO, fm, TODAY);
    expect(rec).not.toBeNull();
    expect(rec.never).toBe(true);
    expect(rec.interval).toBe(null);   // normalized at the source, not carried into the payload
  });

  it('positive intervals are untouched — both the gate and the release', () => {
    const c = { crop: 'houseplant', fertilize_interval_days: 30 };
    expect(fertilizeRec(p({ last_fert: '2026-09-07' }), c, fm, TODAY)).toBeNull();   // 1d < 30 => held
    const due = fertilizeRec(p({ last_fert: '2026-07-01' }), c, fm, TODAY);          // 69d => released
    expect(due.never).toBe(false);
    expect(due.interval).toBe(30);
  });
});

// ── ITEM 2 — isMedHerb, the existing never-feed class, does not fire on prod ───────────────────────
describe('BUG-CAREFEEDINHERIT-001 (item 2) — the crop-regex never-feed class is leaky; the fix is data', () => {
  it('CHARACTERIZES the measured leak: 6 of 9 live Mediterranean herbs carry a crop value it misses', () => {
    // Verbatim prod crop values, 2026-09-08. Not aspirational — this is what the column contains.
    expect(isMedHerb('herb (oregano)')).toBe(true);              // Hot & Spicy Oregano  — caught
    expect(isMedHerb('thyme')).toBe(true);                       // Lemon Thyme          — caught
    expect(isMedHerb('sage')).toBe(true);                        // Pineapple Sage       — caught
    expect(isMedHerb('herb')).toBe(false);                       // Greek Oregano, Oregano, 2x Tarragon
    expect(isMedHerb('herb (Salvia officinalis)')).toBe(false);  // Garden Sage
    expect(isMedHerb('herb (Salvia rosmarinus)')).toBe(false);   // Rosemary
  });

  it('records WHY widening the regex was refused: it misfires on the live corpus', () => {
    // The obvious repair is the isCucurbit/isLeek idiom — match name+variety+crop instead of crop alone.
    // Run over all 271 live plantings it catches the 6 misses AND this row, on sau-SAGE: a tomato,
    // a heavy feeder, silently never fed. `crop` is uncontrolled free text (265 cultivar profiles,
    // 149 distinct strings), so the false-negative class a wider substring match opens is unenumerable.
    const wide = (r) => /oregano|rosemary|sage|thyme|tarragon|lavender/i.test(`${r.name} ${r.variety} ${r.crop}`);
    const tomato = { name: 'Creme Sausage', variety: 'Banana Creme', crop: 'tomato' };
    expect(wide(tomato)).toBe(true);          // the rejected alternative WOULD have matched it
    expect(isMedHerb(tomato.crop)).toBe(false); // what ships does not
  });

  it('THE ACTUAL FIX — the prod Oregano row (crop "herb", interval 30) cards, and the key silences it', () => {
    const oregano = { crop: 'herb', fertilize_interval_days: 30 };
    const rec = fertilizeRec(p({ name: 'Greek Oregano' }), oregano, fm, TODAY);
    expect(rec).not.toBeNull();               // today's live prod behaviour, reproduced
    expect(rec.never).toBe(true);
    expect(fertilizeRec(p({ name: 'Greek Oregano' }), { ...oregano, no_calendar_feed: true }, fm, TODAY)).toBeNull();
  });
});

// ── generatePlan integration — the LOUD bucket, on the real path ───────────────────────────────────
describe('BUG-CAREFEEDINHERIT-001 — suppression is LOUD and reaches the plan payload', () => {
  const P = (o) => withCoverFlags({
    assignee_user_id: 'dave', project: 'Bench', project_id: 'pb', project_status: 'active',
    variety: null, genus: null, container_type: 'pot', container_size: '4 in',
    substrate_start: START, transplant_at: null, last_fert: null, last_water: '2026-09-07',
    covered: true, cadence_scopes: ['cultivar'], ...o,
  });
  const planFor = (plantings) => generatePlan({
    plantings, cadence: cad, fertModel: fm, today: TODAY,
    weather: { tonightLow: 62, highToday: 78, unit: 'F' },
    hydrology: { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
    ownerFallback: 'dave',
  }).users.dave;

  const SUPPRESSED = P({ id: 's1', name: 'Goldenrod', db_cadence: { crop: 'perennial (Solidago)', water_interval_days_container: 7, no_calendar_feed: true } });
  // The live prod shape: the key present with NO water cadence key and no _seeded marker, so
  // cadence_scopes is empty, resolveCadence DROPS the profile, and only the raw db_cadence read sees it.
  const UNSEEDED = P({ id: 's2', name: 'Yarrow (live shape)', cadence_scopes: [], db_cadence: { crop: 'perennial (Achillea)', no_calendar_feed: true } });
  const NORMAL = P({ id: 'n1', name: 'Fittonia', db_cadence: { crop: 'houseplant', water_interval_days_container: 7, fertilize_interval_days: 14 } });

  it('a suppressed planting gets NO feed card and lands in tasks.feed_suppressed with a rule + reason', () => {
    const u = planFor([SUPPRESSED, NORMAL]);
    expect(u.tasks.fertilize.map((x) => x.id)).not.toContain('s1');
    const row = u.tasks.feed_suppressed.find((x) => x.id === 's1');
    expect(row).toBeTruthy();
    expect(row.rule).toBe('no_calendar_feed');
    expect(row.reason).toMatch(/suppressed/i);
    expect(row.name).toBe('Goldenrod');
    expect(u.counts.feed_suppressed).toBe(1);
    // Positive control in the same plan: the machinery still feeds everything else.
    expect(u.tasks.fertilize.map((x) => x.id)).toContain('n1');
    expect(u.tasks.feed_suppressed.map((x) => x.id)).not.toContain('n1');
  });

  it('LIVE UNSEEDED SHAPE — a profile that contributes no water key still suppresses', () => {
    // Without the raw db_cadence read in feedSuppression this row feeds on the bundled 14-day default.
    const u = planFor([UNSEEDED]);
    expect(u.tasks.fertilize).toEqual([]);
    expect(u.tasks.feed_suppressed.map((x) => x.id)).toEqual(['s2']);
    expect(u.counts.feed_suppressed).toBe(1);
  });

  it('the fixture is not silent for some other reason (anti-vacuity: drop the key, get a card)', () => {
    const noKey = { ...UNSEEDED, db_cadence: { crop: 'perennial (Achillea)' } };
    expect(planFor([noKey]).tasks.fertilize.map((x) => x.id)).toEqual(['s2']);
  });

  it('the key set is INERT until a row is suppressed — absent, not present-and-zero', () => {
    // Why this matters: it is what keeps all 25 parity goldens byte-identical, so this feature cannot
    // be shipped by regenerating goldens that would then hide a silent revert of it.
    const u = planFor([NORMAL]);
    expect(Object.prototype.hasOwnProperty.call(u.counts, 'feed_suppressed')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(u.tasks, 'feed_suppressed')).toBe(false);
    expect(u.tasks.fertilize.map((x) => x.id)).toContain('n1');
  });

  it('feeding suppression is FEED-ONLY — the planting still waters', () => {
    // Last watered 38d against a 7d cadence, so it is unambiguously water-due: a fixture that simply
    // was not thirsty would make "still waters" true by accident.
    const u = planFor([{ ...SUPPRESSED, last_water: '2026-08-01' }]);
    const watered = u.tasks.water_due.concat(u.tasks.no_history, u.tasks.rain_skipped).map((x) => x.id);
    expect(watered).toContain('s1');
    expect(u.counts.dormancy_suppressed).toBe(0);
  });
});
