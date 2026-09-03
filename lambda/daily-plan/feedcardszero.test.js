// BUG-FEEDCARDSZERO-001 -- a planting that has NEVER been fed must be able to produce a feed card.
//
// The recency gate (engine.js :539) deliberately lets dF==null through, and says so: the no-history
// case "is exactly what [the branches below] exist for". It was not. Every disjunct on the
// qualifying line was unsatisfiable for a never-fed planting that is not a heavy feeder in flower or
// fruit -- `due` needs a last-feed date by construction, and needs_feed_24wk_plus needs 24 weeks of
// substrate history. Measured on prod 2026-09-03 by running this engine over the live planting set:
// all 46 never-fed plantings produced no card, and the same set forward-simulated to 2026-10-01 and
// 2026-10-20 still produced none -- because the oldest substrate_start in the database is
// 2026-05-12, its own inception, which puts the first reachable needs_feed_24wk_plus at 2026-10-27.
//
// WHAT THIS PINS: that "never fed" qualifies on its own once the planting is past the MG-active
// window, that being past that window is still REQUIRED (the phase gate is not weakened), and that
// the resulting card clears on the CADENCE axis rather than becoming a nightly nag. That last one is
// the load-bearing half -- BUG-FEEDRECENCY-001 exists because a feed card that returns the morning
// after you act on it trains the user to ignore it, and a new qualifying reason is exactly the shape
// of change that can re-open it.
//
// WHAT IT DOES NOT PROVE: anything about substrate_start's DERIVATION. 124 of the 225 live plantings
// take substrate_start from plants.created_at (the DB row-creation date) because they carry no
// potting_up event and no transplant date, which is the same expression DRG-WATERCREDIT-002 already
// rejected on the water arm (engine.js :806). That is a separate, still-open defect; these tests
// pass the phase clock in directly and so are blind to it.
import { describe, it, expect } from 'vitest';
import engine from './engine.js';
import fm from './fertilization-model.json';

const { fertilizeRec, feedPhase } = engine;

// Fittonia, from the live never-fed set: a houseplant, so not a heavy feeder and not a Mediterranean
// herb, which is what makes it depend on the `never` arm and nothing else. 30-day interval as
// resolved on prod. substrate_start 13 weeks back puts it in mg_tapering_13_24wk -- the phase
// fertilization-model.json marks `feed: begin_light`.
const TODAY = '2026-09-03';
const c = { crop: 'houseplant', fertilize_interval_days: 30 };
const p = (last_fert, substrate_start = '2026-06-04') => ({
  id: 'fit', name: 'Green Fittonia', status: 'vegetative', project: 'House', project_id: 'ph',
  substrate_start, last_fert,
});

describe('BUG-FEEDCARDSZERO-001 -- never-fed plantings past the MG window', () => {
  it('the fixture really is in the tapering phase (guards the fixture, not the fix)', () => {
    expect(feedPhase(13)).toBe('mg_tapering_13_24wk');
    expect(fertilizeRec(p(null), c, fm, TODAY).phase).toBe('mg_tapering_13_24wk');
  });

  it('never fed + past the MG window -> a card, flagged never', () => {
    const rec = fertilizeRec(p(null), c, fm, TODAY);
    expect(rec).not.toBeNull();
    expect(rec.never).toBe(true);
    expect(rec.id).toBe('fit');
    expect(rec.interval).toBe(30);
  });

  it('still silent inside the MG-active window -- the phase gate is not weakened', () => {
    // Same never-fed planting, potted 8 weeks ago instead of 13. The mix IS feeding it.
    expect(fertilizeRec(p(null, '2026-07-09'), c, fm, TODAY)).toBeNull();
  });

  it('clears once fed, and the RECENCY GATE is what holds it -- not luck', () => {
    // Fed yesterday -> silent. Stated precisely, because the first version of this test claimed more
    // than it proved and a mutation caught it: for THIS fixture the qualifying line would drop the
    // row anyway (a fed, not-yet-due houseplant satisfies no disjunct), so this assertion shows the
    // card goes away but NOT which gate did it. Deleting :539 leaves it green.
    expect(fertilizeRec(p('2026-09-02'), c, fm, TODAY)).toBeNull();
    // A heavy feeder in fruit is the case where the qualifying line fires ANYWAY, so :539 is the
    // only thing that can suppress it. That is the BUG-FEEDRECENCY-001 shape, re-checked here rather
    // than left to its own file because `never` adds a second way IN and this is the way OUT: if a
    // future edit widens the recency gate to skip never-fed rows, the card returns the morning after
    // Dave feeds the plant and the affordance dies again.
    const hv = { crop: 'pepper', fertilize_interval_days: 17 };
    const hp = (last_fert) => ({ ...p(last_fert), status: 'fruiting' });
    expect(fertilizeRec(hp(null), hv, fm, TODAY).never).toBe(true);    // never fed -> card
    expect(fertilizeRec(hp('2026-09-02'), hv, fm, TODAY)).toBeNull();  // fed 1d ago -> held by :539
    const due = fertilizeRec(hp('2026-08-17'), hv, fm, TODAY);         // 17d -> released as `due`
    expect(due).not.toBeNull();
    expect(due.never).toBe(false);
  });

  it('a Mediterranean herb is still never force-fed, never-fed or not', () => {
    expect(fertilizeRec(p(null), { crop: 'oregano', fertilize_interval_days: 30 }, fm, TODAY)).toBeNull();
  });
});
