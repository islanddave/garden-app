// DRG-WX Phase 2 — uncertainty.flag for the frozen 2AM precip snapshot.
// The OLD predicate fired ONLY for tomorrow_pop in [40,60] with >=0.3", so the common high-PoP cases
// (88% PoP with a trace OR a modest amount — bell's 2026-06-22 0.21"->0.61" case) rendered with NO
// caveat. These guard the showery/convective + data-missing behavior. Metadata only: no watering
// recommendation reads this flag, so the golden watercredit fixture is unaffected.
import { describe, it, expect } from 'vitest';
import engine from './engine.js';
const { hydrologyStatus } = engine;

const base = { recent_precip_in: 0.05, upcoming_precip_in: 0.1, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 };
const H = (o) => ({ ...base, ...o });

describe('hydrologyStatus — snapshot-volatility uncertainty (DRG-WX Phase 2)', () => {
  it('flags + not-ok when precip data is missing entirely', () => {
    const r = hydrologyStatus(null);
    expect(r.ok).toBe(false);
    expect(r.uncertainty.flag).toBe(true);
  });

  it('flags when a window field is null (incomplete fetch)', () => {
    const r = hydrologyStatus(H({ recent_precip_in: null }));
    expect(r.ok).toBe(false);
    expect(r.uncertainty.flag).toBe(true);
  });

  it('does NOT flag a clear, low-PoP day', () => {
    const r = hydrologyStatus(H({ today_pop: 10, tomorrow_pop: 5 }));
    expect(r.ok).toBe(true);
    expect(r.uncertainty.flag).toBe(false);
  });

  it("flags bell's case: high PoP today with a modest amount (88% / 0.21\")", () => {
    const r = hydrologyStatus(H({ today_pop: 88, today_precip_in: 0.21, tomorrow_pop: 63, tomorrow_precip_in: 0.74, upcoming_precip_in: 0.74 }));
    expect(r.uncertainty.flag).toBe(true);
    expect(r.uncertainty.reason).toMatch(/today/i);
  });

  it('flags the high-PoP / trace-amount case the old 40-60 band missed (88% / 0")', () => {
    const r = hydrologyStatus(H({ today_pop: 88, today_precip_in: 0 }));
    expect(r.uncertainty.flag).toBe(true);
    expect(r.uncertainty.reason).toMatch(/climb/i);
  });

  it('still flags the classic coin-flip band tomorrow (50% on 0.3")', () => {
    const r = hydrologyStatus(H({ tomorrow_pop: 50, tomorrow_precip_in: 0.3, upcoming_precip_in: 0.3 }));
    expect(r.uncertainty.flag).toBe(true);
  });

  it('flags a 40-49% band day with a real amount (broad uncertainty, below showery cut)', () => {
    const r = hydrologyStatus(H({ tomorrow_pop: 45, tomorrow_precip_in: 0.2, upcoming_precip_in: 0.2 }));
    expect(r.uncertainty.flag).toBe(true);
  });

  it('does NOT flag a low-PoP modest forecast', () => {
    const r = hydrologyStatus(H({ today_pop: 20, today_precip_in: 0, tomorrow_pop: 30, tomorrow_precip_in: 0.2, upcoming_precip_in: 0.2 }));
    expect(r.uncertainty.flag).toBe(false);
  });
});

// BUG-WXBANNERSHOWERYCOPY-001 — the incomplete reason must be TRUE of what the credit path does, so each
// case asserts the reason and windowPrecip (the function rain credit and every rain skip read) together.
describe('hydrologyStatus — the incomplete reason says what watering really credits', () => {
  it('no recent figure (outage, no gauge): "assumes no rain credit", and windowPrecip is null', () => {
    for (const hy of [null, H({ recent_precip_in: null, upcoming_precip_in: null })]) {
      expect(hydrologyStatus(hy).uncertainty.reason).toMatch(/assumes no rain credit/);
      expect(engine.windowPrecip(hy)).toBeNull();
    }
  });

  it('gauge-supplied recent with no forecast (the 2026-09-02 shape): says recent rain still credits', () => {
    const hy = { recent_precip_in: 0.5, today_precip_in: 0.01, today_observed_in: 0.01, today_remaining_in: 0,
      today_pop: null, upcoming_precip_in: null, tomorrow_precip_in: null, tomorrow_pop: null };
    const r = hydrologyStatus(hy);
    expect(r.ok).toBe(false);
    expect(r.uncertainty.reason).toMatch(/still credits recent rain/);
    expect(r.uncertainty.reason).not.toMatch(/no rain credit/);
    expect(engine.windowPrecip(hy)).toBeCloseTo(0.51);
  });
});
