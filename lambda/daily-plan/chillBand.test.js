// V5-CHILLBAND-001 — the 45-50F chilling band.
//
// Every boundary below is a LITERAL, never the constant it tests. A threshold case written as
// `THRESHOLD` and `THRESHOLD - 1` makes the fixture track the constant, so moving the constant moves
// the test with it and the case can never fail — a mistake made and caught by mutation elsewhere in
// this same change set.
//
// The real nights are used as fixtures on purpose: 2026-09-07 (45.6F) and 2026-09-08 (49.7F) are the
// two that passed in silence and are the reason this rule exists.

import { describe, it, expect } from 'vitest';
import engine from './engine.js';

const { computeCallout } = engine;
const DRY = { recent_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 };
const wx = (tonightLow, highToday = 74) => ({ tonightLow, highToday });

describe('the 45-50F chilling band', () => {
  it('speaks on the two real September nights that used to pass in silence', () => {
    // Before this rule both returned null. These are the actual stored tmin values.
    expect(computeCallout(wx(45.6), DRY).text).toMatch(/Chilly night \(45\.6°F\)/);
    expect(computeCallout(wx(49.7), DRY).text).toMatch(/Chilly night \(49\.7°F\)/);
  });

  it('stops at 50 — the band is a floor, not an open-ended cool warning', () => {
    expect(computeCallout(wx(49.9), DRY)).not.toBeNull();
    expect(computeCallout(wx(50), DRY)).toBeNull();
    expect(computeCallout(wx(55), DRY)).toBeNull();
  });

  it('does NOT steal the colder bands — priority order is preserved', () => {
    // A 38F night is a freeze and must keep saying so; a 43F night stays the existing cool-night
    // rule. Placing the new band above either of these in the chain would silently downgrade them.
    expect(computeCallout(wx(38), DRY).icon).toBe('freeze');
    expect(computeCallout(wx(43), DRY).icon).toBe('cold');
    expect(computeCallout(wx(47), DRY).icon).toBe('cool');
  });

  it('names chilling damage as happening ABOVE freezing — the point a frost forecast misses', () => {
    const t = computeCallout(wx(47), DRY).text;
    expect(t).toMatch(/above freezing/);
    expect(t).toMatch(/sweet potato/);
    // It must not tell him to cover for frost: at 47F there is no frost to cover against, and the
    // existing <40 rule already owns that instruction.
    expect(t).not.toMatch(/cover|bring .* in/i);
  });

  it('yields to a hot day only when no cold band applies', () => {
    // 88F+ is a real callout, but a night in the chilling band outranks it — the low is the risk.
    expect(computeCallout(wx(47, 90), DRY).icon).toBe('cool');
    expect(computeCallout(wx(60, 90), DRY).icon).toBe('heat');
  });

  it('says nothing when the low is unknown, rather than guessing', () => {
    expect(computeCallout(wx(null), DRY)).toBeNull();
    expect(computeCallout({}, DRY)).toBeNull();
  });
});
