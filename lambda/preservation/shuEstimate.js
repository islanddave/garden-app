// Release F — the estimated heat (SHU), Dave's recipe convention (06-ferment-path §2.6; coordination
// 15:55, 17:1x). PURE: no driver, no clock. kitchenRoutes.js loads the lines and ratings and calls this.
//
// THE CONVENTION, as Dave writes it on his cards:
//   * a line contributes  grams × form factor × rating;
//   * the form factor is ×1 for fresh, frozen and cooked and ×7 (low) to ×10 (high) for DRIED;
//   * the rating is the line's typed "listed heat" — which is ALWAYS the FRESH pepper's rating, the app
//     applies the dried factor (Dave 17:1x) — otherwise the variety's scoville_min..max;
//   * the result is contributions ÷ a denominator in grams, rounded half-up to whole SHU.
// NEVER 0 FROM ABSENCE (§2.6.2). The answer is exactly one of: a figure (every heat line has grams and a
// rating), "can't work it out" naming each heat line that lacks either, or "nothing with a listed heat".
// A line typed 0 counts as 0 — that is a rating, not an absence.
import { gramsOf, isMassUnit } from './kitchenBatch.js';

// Dried chilies are counted ×7 (low) to ×10 (high) the fresh figure (recipes-v3.md l.3).
export const DRIED_FACTOR = Object.freeze({ low: 7, high: 10 });
// The crop_types slugs that ARE peppers (pinned from crop_types: the catalogue has one, 'pepper').
export const PEPPER_CROP_SLUGS = Object.freeze(['pepper']);
// The lane-pinned chili words (§2.6.2): a typed line naming one of these is a heat line.
export const CHILI_WORDS = Object.freeze(['chili', 'chile', 'chilli', 'pepper', 'gochugaru', 'cayenne', 'paprika', 'flakes']);

export const halfUp = (x) => Math.floor(x + 0.5);

export function formFactor(form) {
  return form === 'dried' ? { low: DRIED_FACTOR.low, high: DRIED_FACTOR.high } : { low: 1, high: 1 };
}

// The rating a line carries: typed on the line first (high defaults to low), else the variety's.
export function lineRating(line) {
  if (line.shu_rating_low != null) {
    const low = Number(line.shu_rating_low);
    return { low, high: line.shu_rating_high != null ? Number(line.shu_rating_high) : low, source: 'typed' };
  }
  const v = line.variety_rating;
  if (v && v.low != null) {
    const low = Number(v.low);
    return { low, high: v.high != null ? Number(v.high) : low, source: 'variety' };
  }
  return null;
}

// What went in, in grams, or null. A counted draw with no qty derives count × (bag g ÷ packages) when
// the jar was logged in a mass unit ("≈ N g, from the bag size"). quantity_value is the jar's TOTAL.
export function lineGrams(line) {
  const g = gramsOf(line.qty, line.qty_unit, { water: line.role === 'water' });
  if (g != null) return { grams: g, derived: false };
  const d = line.draw;
  if (line.qty == null && d && d.count_drawn != null && d.jar_quantity_value != null
      && isMassUnit(d.jar_quantity_unit) && Number(d.jar_package_count) > 0) {
    const bag = gramsOf(d.jar_quantity_value, d.jar_quantity_unit);
    return { grams: Number(d.count_drawn) * (bag / Number(d.jar_package_count)), derived: true };
  }
  return null;
}

const words = (s) => String(s ?? '').toLowerCase();
export function isHeatLine(line, { pepperNames = [] } = {}) {
  if (line.role != null) return false;
  if (lineRating(line)) return true;
  if (line.crop_type_slug && PEPPER_CROP_SLUGS.includes(line.crop_type_slug)) return true;
  if (line.is_pepper_crop === true) return true;
  const label = words(line.label);
  if (!label) return false;
  if (CHILI_WORDS.some((w) => new RegExp(`\\b${w}s?\\b`).test(label))) return true;
  return pepperNames.some((n) => n && label.includes(words(n)));
}

// Contributions over a set of lines. Returns { low, high, breakdown, missing, not_counted, heat }.
export function contributions(lines, opts = {}) {
  const out = { low: 0, high: 0, breakdown: [], missing: [], not_counted: [], heat: 0 };
  for (const line of lines) {
    if (line.role === 'salt') continue;
    if (!isHeatLine(line, opts)) {
      out.not_counted.push({ line_id: line.id, label: line.label });
      continue;
    }
    out.heat += 1;
    const rating = lineRating(line);
    const g = lineGrams(line);
    if (!rating) out.missing.push({ line_id: line.id, label: line.label, why: 'no_rating' });
    if (!g) out.missing.push({ line_id: line.id, label: line.label, why: 'no_weight' });
    if (!rating || !g) continue;
    const f = formFactor(line.form);
    out.low += g.grams * f.low * rating.low;
    out.high += g.grams * f.high * rating.high;
    out.breakdown.push({
      line_id: line.id, label: line.label, grams: g.grams, grams_derived: g.derived, form: line.form ?? null,
      factor_low: f.low, factor_high: f.high, rating_low: rating.low, rating_high: rating.high,
      rating_source: rating.source,
    });
  }
  return out;
}

// "In the jar now" (§2.6.3): live lines with no put_up_stage_id and no salt role, in mass units, plus
// water lines ml→g; or the started row's "About ___ in it" when its unit is g or kg (typed wins). In
// cups or qt the About is ignored and the sheet says "used the weight of what went in".
export function batchDenominator(batchLines, about) {
  const aboutG = about ? gramsOf(about.amount, about.amount_unit) : null;
  if (aboutG != null && aboutG > 0) return { grams: aboutG, source: 'about', about_ignored: false };
  let sum = 0;
  for (const l of batchLines) {
    if (l.role === 'salt') continue;
    const g = gramsOf(l.qty, l.qty_unit, { water: l.role === 'water' });
    if (g != null) sum += g;
  }
  return { grams: sum, source: 'lines', about_ignored: about != null && about.amount != null };
}

function refusalOf(c) {
  if (c.heat === 0) return { refusal: 'no_heat_lines', not_counted: c.not_counted };
  if (c.missing.length) return { refusal: 'cannot_work_it_out', missing: c.missing, not_counted: c.not_counted };
  return null;
}

function figure(c, denom, extra = {}) {
  return {
    low: halfUp(c.low / denom.grams),
    high: halfUp(c.high / denom.grams),
    breakdown: c.breakdown,
    not_counted: c.not_counted,
    denominator_g: denom.grams,
    denominator_source: denom.source,
    ...extra,
  };
}

// ── the three scopes (contract-F §2.5) ────────────────────────────────────────────────────────────
// input: { lines (LIVE lines of the batch, with variety_rating / draw resolved), about, sittings:
//   [{id, made_g, mash_in_g}] (LIVE put_up rows), sitting_id?, jar?: {id, put_up_stage_id,
//   quantity_value, quantity_unit}, pepperNames }
export function estimateShu({ scope, lines, about = null, sittings = [], sitting_id = null, jar = null, pepperNames = [] }) {
  const opts = { pepperNames };
  const batchLines = lines.filter((l) => l.put_up_stage_id == null);
  if (scope === 'batch') {
    const c = contributions(batchLines, opts);
    const r = refusalOf(c);
    if (r) return r;
    const d = batchDenominator(batchLines, about);
    if (!(d.grams > 0)) return { refusal: 'cannot_work_it_out', missing: [{ line_id: null, label: 'what went in', why: 'no_weight' }], not_counted: c.not_counted };
    return figure(c, d, { about_ignored: d.about_ignored });
  }
  const sid = scope === 'jar' ? jar?.put_up_stage_id : sitting_id;
  const sitting = sittings.find((s) => s.id === sid);
  if (!sitting) return { refusal: 'not_found' };
  const sittingOwn = lines.filter((l) => l.put_up_stage_id === sid && l.output_id == null);
  const conc = sittingConcentration(batchLines, sittingOwn, sitting, sittings, opts);
  const { exact_low: _l, exact_high: _h, ...shown } = conc;
  if (scope === 'sitting' || conc.refusal) return shown;
  // Row (§2.6.3): no own additions → the sitting figure. With own additions →
  // [sitting conc × (row net g − row added g) + Σ row added contributions] ÷ row net g.
  const rowOwn = lines.filter((l) => l.output_id === jar.id);
  if (!rowOwn.length) return { ...shown, denominator_source: 'sitting' };
  const net = gramsOf(jar.quantity_value, jar.quantity_unit);
  if (net == null || !(net > 0)) return { refusal: 'row_net_unknown' };
  const c = contributions(rowOwn, opts);
  if (c.missing.length) return { refusal: 'cannot_work_it_out', missing: c.missing, not_counted: c.not_counted };
  let added = 0;
  for (const l of rowOwn) {
    const g = gramsOf(l.qty, l.qty_unit, { water: l.role === 'water' });
    if (g != null) added += g;
  }
  const base = Math.max(net - added, 0);
  return {
    low: halfUp((conc.exact_low * base + c.low) / net),
    high: halfUp((conc.exact_high * base + c.high) / net),
    breakdown: [...shown.breakdown, ...c.breakdown],
    not_counted: [...shown.not_counted, ...c.not_counted],
    denominator_g: net,
    denominator_source: 'row',
  };
}

// Sitting (§2.6.3): batch contributions × this sitting's mash_in_g ÷ Σ mash_in_g over all live
// sittings, plus this sitting's own lines, ÷ this sitting's Made g. One live sitting → fraction 1.
function sittingConcentration(batchLines, sittingOwn, sitting, sittings, opts) {
  const all = contributions([...batchLines, ...sittingOwn], opts);
  const r = refusalOf(all);
  if (r) return r;
  const b = contributions(batchLines, opts);
  const s = contributions(sittingOwn, opts);
  let share = 1;
  if (sittings.length > 1) {
    if (sittings.some((x) => x.mash_in_g == null)) return { refusal: 'mash_in_missing' };
    const total = sittings.reduce((a, x) => a + Number(x.mash_in_g), 0);
    share = Number(sitting.mash_in_g) / total;
  }
  const made = sitting.made_g == null ? null : Number(sitting.made_g);
  if (!(made > 0)) {
    return { refusal: 'cannot_work_it_out', missing: [{ line_id: null, label: 'Made ___ g in all', why: 'no_weight' }], not_counted: all.not_counted };
  }
  const low = (b.low * share + s.low) / made;
  const high = (b.high * share + s.high) / made;
  return {
    low: halfUp(low), high: halfUp(high), exact_low: low, exact_high: high,
    breakdown: all.breakdown, not_counted: all.not_counted, denominator_g: made, denominator_source: 'made',
    share,
  };
}

// A stored COMPUTED estimate is flagged stale (never recomputed silently) when today's recompute
// differs or refuses (§2.6.4). 'typed' is never flagged.
export function isStale(stored, recomputed) {
  if (!stored || stored.shu_est_basis !== 'computed') return false;
  if (!recomputed || recomputed.refusal) return true;
  return Number(stored.shu_est_low) !== recomputed.low || Number(stored.shu_est_high) !== recomputed.high;
}
