// vesselData.test.js — BUG-CADENCESIZE-001: the ambient surface for missing/suspect vessel records.
//
// WHAT THIS PROTECTS. The watering interval now reads `container_size` for some vessels, and the engine's
// response to a gap is to DECLINE (unknown vessel keeps today's cadence). That is safe but silent, and
// silence is what let the gaps accumulate: 98 of 228 active plantings have no recorded size, 22 have no
// type at all, and a location literally named "Bag Area" holds 26 rows recorded as `plastic_pot` beside
// 78 `fabric_bag` — three of those plastic_pots were photographed and are black fabric grow bags.
//
// THE FIXTURES BELOW ARE THE REAL SHAPES, from live prod 2026-08-18. The "Bag Area plastic_pot with a
// NULL size" case is the motivating row, not an invented one.
import { describe, it, expect } from 'vitest';
import { vesselDataGaps, vesselGapFor } from '../lib/vesselData.js';

const kinds = (pl) => vesselDataGaps(pl).map((g) => g.kind);

describe('vesselDataGaps — a complete record says nothing', () => {
  it('is silent when type and size are both recorded and consistent', () => {
    expect(vesselDataGaps({ container_type: 'fabric_bag', container_size: '10 gal', location_path: 'Gardens / Bag Area' })).toEqual([]);
    expect(vesselDataGaps({ container_type: 'plastic_pot', container_size: '6 in', location_path: 'Gardens / Stable' })).toEqual([]);
  });

  // Silence must be the DEFAULT for anything it cannot judge — this surface exists to prompt Dave, and a
  // surface that prompts on rows that are fine is the chore list it was explicitly not supposed to be.
  it('says nothing about a null/garbage planting', () => {
    for (const bad of [null, undefined, 'x', 42]) expect(vesselDataGaps(bad)).toEqual([]);
  });

  // Size is implied by these types, so asking for one is noise. A trough is a trough at any size.
  it('does not ask for a size on types whose size is implied', () => {
    for (const t of ['in_ground', 'raised_bed', 'trough', 'whiskey_barrel', 'tray_cell', 'soil_block', 'solo_cup']) {
      expect(kinds({ container_type: t, container_size: null }), `${t} should not be asked for a size`).toEqual([]);
    }
  });
});

describe('vesselDataGaps — missing records are stated, not hidden', () => {
  it('flags a missing size on a type where size matters', () => {
    expect(kinds({ container_type: 'plastic_pot', container_size: null })).toEqual(['missing_size']);
    expect(kinds({ container_type: 'fabric_bag', container_size: '' })).toEqual(['missing_size']);
    expect(kinds({ container_type: 'ceramic', container_size: '   ' })).toEqual(['missing_size']);
  });

  it('flags a missing type', () => {
    expect(kinds({ container_type: null, container_size: '5 gal' })).toEqual(['missing_type']);
    // Both missing — 22 live rows are in exactly this state.
    expect(kinds({ container_type: null, container_size: null })).toEqual(['missing_type', 'missing_size']);
  });

  // The engine declines on an unreadable string; this tells Dave WHY nothing happened. The probe is
  // deliberately loose (see vesselData.js): its job is obvious garbage, not the engine's gallon math.
  it('flags a size string with no readable number+unit', () => {
    for (const s of ['big', 'large', 'huge', 'medium pot']) {
      expect(kinds({ container_type: 'plastic_pot', container_size: s }), `"${s}" should read as unreadable`).toEqual(['unreadable_size']);
    }
    expect(vesselDataGaps({ container_type: 'plastic_pot', container_size: 'big' })[0].text).toContain('"big"');
  });

  // Every distinct container_size string in live prod must be accepted as readable, or this surface
  // would nag Dave about 100+ rows that are already fine — which is precisely the chore list to avoid.
  it('accepts every container_size string that exists in prod today', () => {
    const PROD = ['5 gal', '10 gal', '4 in', '6 in', '6x2 ft', '3 in', '1 gal', '2 in', '7 gal',
      '20 gal', '8 in', '2 gal', '15 gall', '3 gal', '15 gal', '10 in', '20 oz'];
    for (const s of PROD) {
      expect(kinds({ container_type: 'plastic_pot', container_size: s }), `prod string "${s}" flagged`).toEqual([]);
    }
  });
});

describe('vesselDataGaps — a recorded type that contradicts its location', () => {
  // THE MOTIVATING CASE. 26 active rows are recorded plastic_pot in a location named "Bag Area";
  // photos of three of them show black fabric grow bags. A wrong value is worse than a missing one,
  // because the interval derivation and the rest of the app treat it as known.
  it('flags a plastic_pot sitting in the Bag Area', () => {
    const pl = { container_type: 'plastic_pot', container_size: null, location_path: 'Gardens at Mathews Ridge / Bag Area' };
    expect(kinds(pl)).toContain('type_conflicts_location');
    expect(vesselDataGaps(pl)[0].kind, 'a wrong value must be listed above a missing one').toBe('type_conflicts_location');
    expect(vesselDataGaps(pl)[0].text).toBe('Recorded as plastic pot, but this location is grow bags');
  });

  it('says nothing when the type agrees with the location', () => {
    expect(kinds({ container_type: 'fabric_bag', container_size: '5 gal', location_path: 'Bag Area' })).toEqual([]);
    expect(kinds({ container_type: 'trough', container_size: '6x2 ft', location_path: 'Trough' })).toEqual([]);
  });

  // All 8 live troughs sit in a location named "Trough" — the corroboration that made the floor
  // trustworthy for exactly those rows. If a trough is ever recorded elsewhere, that is worth saying.
  it('flags a non-trough recorded in a Trough location', () => {
    expect(kinds({ container_type: 'fabric_bag', container_size: '5 gal', location_path: 'Gardens / Trough' })).toContain('type_conflicts_location');
  });

  it('is case- and path-insensitive, and needs a location to speak', () => {
    expect(kinds({ container_type: 'PLASTIC_POT', container_size: '5 gal', location_path: 'BAG AREA' })).toContain('type_conflicts_location');
    // No location on the row -> no claim. Never guess a conflict from a missing input.
    expect(kinds({ container_type: 'plastic_pot', container_size: '5 gal', location_path: null })).toEqual([]);
  });
});

describe('vesselGapFor — per-row lookup', () => {
  it('returns the gap for the requested field only', () => {
    const pl = { container_type: null, container_size: null };
    expect(vesselGapFor(pl, 'container_type').kind).toBe('missing_type');
    expect(vesselGapFor(pl, 'container_size').kind).toBe('missing_size');
    expect(vesselGapFor({ container_type: 'fabric_bag', container_size: '5 gal' }, 'container_size')).toBe(null);
  });
});
