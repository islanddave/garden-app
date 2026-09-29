// Release F — the salt arithmetic (06-ferment-path, the salt sections). PURE. The helper's numbers, stated once so
// the server, the client mirror and the golden table agree.
//
// THE BASES (the % is "of" one of these; 'peppers' is a 1b-era word no F writer writes):
//   produce = every live weighed line with no role and no put_up_stage_id (spices and sugar included);
//   water   = the role='water' lines, volume at 1 g/ml;
//   all     = produce + water ("Veg + water" — Dave's "3.5% of water+ingr").
// Salt lines and sitting lines are never in a base. A line in no mass unit is "no weight" (named, never
// guessed). base_from 'scale' is one typed reading (a rinsed soak's water is always that — it is never a
// line, so it is in no base, no denominator and no placeholder).
// Salt grams are computed in decimal and stored unrounded (15.68); the display rounds to one decimal.
// The aimed % is what he aimed for; the actual % is always re-derived: qty ÷ base_g.
import { gramsOf } from './kitchenBatch.js';

export function saltBase(lines, base) {
  let produce = 0;
  let water = 0;
  const noWeight = [];
  const leftOut = [];
  for (const l of lines) {
    if (l.role === 'salt' || l.put_up_stage_id != null) continue;
    const isWater = l.role === 'water';
    const g = gramsOf(l.qty, l.qty_unit, { water: isWater });
    if (g == null) { noWeight.push(l.label); continue; }
    if (isWater) {
      if (base === 'produce') leftOut.push(l.label); else water += g;
    } else if (base === 'water') {
      leftOut.push(l.label);
    } else {
      produce += g;
    }
  }
  const grams = base === 'produce' ? produce : base === 'water' ? water : produce + water;
  return { grams, no_weight: noWeight, left_out: leftOut };
}

// "3.5% of veg + water (448 g) → 15.7 g" — unrounded here.
export const saltGrams = (pct, baseG) => (Number(pct) / 100) * Number(baseG);
// "put in 13.5 g = 3.0% of 448 g" — unrounded here.
export const actualPct = (qtyG, baseG) => (Number(qtyG) / Number(baseG)) * 100;
// One decimal, half-up, as shown ("15.7 g", "3.0%").
export const oneDecimal = (x) => (Math.floor(x * 10 + 0.5) / 10).toFixed(1);
