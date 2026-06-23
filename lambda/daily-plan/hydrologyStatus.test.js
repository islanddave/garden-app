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
