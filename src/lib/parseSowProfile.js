// src/lib/parseSowProfile.js — V4-SEEDINV-001 shared parsing lib.
// Pure ESM, zero dependencies, plain-node compatible (imported by
// migrations/v4-seedinv-001/0b-load-seeds.mjs as well as the frontend).
// Converts seed-load-dataset packets into plant_varieties column values
// (packetToVarietyCols) and inventory_items insert payloads
// (packetToInventoryPayload).

/** Live crop_types enum whitelist. 'other' and null guesses are omitted. */
export const CROP_TYPE_SLUGS = Object.freeze([
  'arugula', 'asparagus', 'avocado', 'basil', 'bee_balm', 'beet', 'begonia',
  'bitter_melon', 'black_raspberry', 'blueberry', 'broccoli', 'cabbage',
  'cactus', 'chard', 'chives', 'christmas_cactus', 'chrysanthemum',
  'cilantro', 'collard', 'crown_of_thorns', 'cucamelon', 'cucumber',
  'culantro', 'dill', 'dracaena', 'echeveria', 'eggplant', 'endive',
  'fittonia', 'garlic', 'geranium', 'haworthia', 'hosta', 'jade',
  'japanese_maple', 'leek', 'lemongrass', 'lettuce', 'lithops', 'luffa',
  'marigold', 'melon', 'mint', 'nasturtium', 'onion', 'oregano', 'parsley',
  'peach', 'pepper', 'pineapple', 'potato', 'pothos', 'radicchio', 'rose', 'rosemary',
  'sage', 'sedum', 'shallot', 'spinach', 'squash', 'strawberry', 'succulent',
  'sweet_potato', 'tarragon', 'tomatillo', 'tomato', 'tradescantia',
  'vietnamese_coriander', 'watermelon', 'wineberry',
]);

const RANGE_RE = /(\d+(?:\.\d+)?)\s*(?:[-–—]\s*(\d+(?:\.\d+)?))?/;

/**
 * Parse an integer range string. "6-8" -> {min:6, max:8}; "3" -> {min:3,
 * max:3}; ''/null/unparseable -> {min:null, max:null}. Numbers pass through.
 */
export function parseRange(value) {
  if (value == null || value === '') return { min: null, max: null };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { min: null, max: null };
    const n = Math.trunc(value);
    return { min: n, max: n };
  }
  const m = String(value).match(RANGE_RE);
  if (!m) return { min: null, max: null };
  const lo = parseInt(m[1], 10);
  const hi = m[2] != null ? parseInt(m[2], 10) : lo;
  return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
}

/**
 * Parse a numeric value keeping the LOW end of any range.
 * "0.5-1" -> 0.5; "0" -> 0; 12 -> 12; null/'' -> null.
 */
export function parseNumericLow(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const m = String(value).match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

const LIFECYCLE_TOKENS = ['tender perennial', 'perennial', 'biennial', 'annual'];

/**
 * Parse a life_cycle string into {lifecycle, grown_as} enum values.
 * Covers both 'biennial grown as annual' and 'tender perennial (grown as
 * annual)' forms. Unknown/null -> {lifecycle:null, grown_as:null}.
 */
export function parseLifecycle(str) {
  if (!str) return { lifecycle: null, grown_as: null };
  const s = String(str).toLowerCase();
  let lifecycle = null;
  for (const token of LIFECYCLE_TOKENS) {
    if (s.includes(token)) { lifecycle = token.replace(/\s+/g, '_'); break; }
  }
  let grownAs = null;
  const g = s.match(/grown\s+as\s+(?:an?\s+)?(tender\s+perennial|perennial|biennial|annual)/);
  if (g) grownAs = g[1].replace(/\s+/g, '_');
  return { lifecycle, grown_as: grownAs };
}

const SUN_TOKENS = [
  ['full sun', 'full_sun'],
  ['part sun', 'part_sun'],
  ['part shade', 'part_shade'],
  ['full shade', 'full_shade'],
];

/**
 * Parse a sun string to the sun_requirements enum. Compound strings collapse
 * to the first (sunniest-listed) token: 'full sun to part shade' -> 'full_sun'.
 */
export function parseSun(str) {
  if (!str) return null;
  const s = String(str).toLowerCase();
  let best = null;
  let bestIdx = Infinity;
  for (const [token, value] of SUN_TOKENS) {
    const idx = s.indexOf(token);
    if (idx !== -1 && idx < bestIdx) { best = value; bestIdx = idx; }
  }
  return best;
}

/** Parse a season string: 'cool/warm' (any separator) -> 'cool_warm'. */
export function parseSeason(str) {
  if (!str) return null;
  const s = String(str).toLowerCase();
  const cool = s.includes('cool');
  const warm = s.includes('warm');
  if (cool && warm) return 'cool_warm';
  if (cool) return 'cool';
  if (warm) return 'warm';
  return null;
}

/** Parse a start-method string to the start_method enum. */
export function parseStartMethod(str) {
  if (!str) return null;
  const s = String(str).toLowerCase();
  if (/indoor/.test(s) && /only|year.?round/.test(s)) return 'indoors_only';
  if (/both/.test(s)) return 'both';
  if (/direct/.test(s)) return 'direct_sow';
  if (/indoor/.test(s)) return 'start_indoors';
  return null;
}

function isCollapsedRange(value) {
  return typeof value === 'string' && /\d\s*[-–—]\s*\d/.test(value);
}

const NULL_SOW_FIELDS = Object.freeze({
  lifecycle: null,
  grown_as: null,
  days_to_maturity_min: null,
  days_to_maturity_max: null,
  sun_requirements: null,
  start_method: null,
  start_indoor_weeks_min: null,
  start_indoor_weeks_max: null,
  direct_sow_timing: null,
  sow_depth_in: null,
  seed_spacing_in: null,
  row_spacing_in: null,
  days_to_germ_min: null,
  days_to_germ_max: null,
  sow_season: null,
  sow_notes: null,
});

/**
 * Map a dataset packet to plant_varieties column values.
 * Null sow_profile -> all sow fields null. crop_type_slug is included only
 * when the guess is in the live enum whitelist ('other'/null omitted).
 * sow_notes = zone_notes + packet_notes + range-fidelity lines for any
 * collapsed depth/spacing range + sun nuance when a compound sun collapsed.
 */
export function packetToVarietyCols(packet, opts = {}) {
  const out = {
    name: packet.variety ?? packet.name ?? null,
    species: null,
  };
  const guess = packet.crop_type_slug_guess;
  // V4-SEEDLOAD-001 fix: gate crop_type_slug on the LIVE crop_types catalog when the caller
  // supplies it (opts.validSlugs — a Set or array of slugs read from the crop_types table),
  // falling back to the static CROP_TYPE_SLUGS list for callers without DB access. The static
  // list drifted behind crop_types (carrot, radish, four_o_clock, … were absent), so valid slugs
  // were dropped to null and the loaded varieties vanished from the by-type (faceted) views.
  const valid = opts.validSlugs;
  const slugOk = valid
    ? (valid instanceof Set ? valid.has(guess) : valid.includes(guess))
    : CROP_TYPE_SLUGS.includes(guess);
  if (guess && guess !== 'other' && slugOk) {
    out.crop_type_slug = guess;
  }
  const sp = packet.sow_profile;
  if (!sp) return { ...out, ...NULL_SOW_FIELDS };

  const { lifecycle, grown_as } = parseLifecycle(sp.life_cycle);
  const dtm = parseRange(sp.days_to_maturity);
  const weeks = parseRange(sp.start_indoor_weeks_before_lastfrost);
  const germ = parseRange(sp.days_to_germ);

  const fidelity = [];
  if (isCollapsedRange(sp.sow_depth_in)) fidelity.push(`Depth: ${sp.sow_depth_in} in`);
  if (isCollapsedRange(sp.seed_spacing_in)) fidelity.push(`Seed spacing: ${sp.seed_spacing_in} in`);
  if (isCollapsedRange(sp.row_spacing_in)) fidelity.push(`Row spacing: ${sp.row_spacing_in} in`);
  if (sp.sun && /\bto\b/i.test(sp.sun)) fidelity.push(`Sun: ${sp.sun}`);

  const notesParts = [sp.zone_notes, sp.packet_notes, fidelity.join('\n')]
    .map((p) => (p ? String(p).trim() : ''))
    .filter(Boolean);

  return {
    ...out,
    lifecycle,
    grown_as,
    days_to_maturity_min: dtm.min,
    days_to_maturity_max: dtm.max,
    sun_requirements: parseSun(sp.sun),
    start_method: parseStartMethod(sp.start_method),
    start_indoor_weeks_min: weeks.min,
    start_indoor_weeks_max: weeks.max,
    direct_sow_timing: sp.direct_sow_timing ?? null,
    sow_depth_in: parseNumericLow(sp.sow_depth_in),
    seed_spacing_in: parseNumericLow(sp.seed_spacing_in),
    row_spacing_in: parseNumericLow(sp.row_spacing_in),
    days_to_germ_min: germ.min,
    days_to_germ_max: germ.max,
    sow_season: parseSeason(sp.season),
    sow_notes: notesParts.length ? notesParts.join('\n\n') : null,
  };
}

const METADATA_MAX_BYTES = 8192;

function byteLength(str) {
  // TextEncoder exists in node >= 11 and all browsers; zero-dep UTF-8 size.
  return new TextEncoder().encode(str).length;
}

/**
 * Map a dataset packet to an inventory_items insert payload.
 * metadata = {...packet.metadata, sku, vendor, origin, needs_confirmation?}
 * and must serialize to fewer than 8192 bytes (DB CHECK) — throws otherwise.
 */
export function packetToInventoryPayload(packet, { variety_id, created_by } = {}) {
  const metadata = { ...(packet.metadata || {}) };
  metadata.sku = packet.sku ?? null;
  metadata.vendor = packet.vendor ?? null;
  metadata.origin = packet.origin ?? null;
  if (packet.needs_confirmation != null) {
    metadata.needs_confirmation = packet.needs_confirmation;
  }
  if (byteLength(JSON.stringify(metadata)) >= METADATA_MAX_BYTES) {
    throw new Error(`inventory metadata for "${packet.name}" exceeds ${METADATA_MAX_BYTES} bytes`);
  }
  const qty = Number(packet.quantity_on_hand);
  return {
    type: 'consumable',
    category: 'seeds',
    unit: 'packet',
    status: 'active',
    name: packet.name,
    quantity_on_hand: Number.isFinite(qty) && qty > 0 ? qty : 1,
    source: packet.source ?? null,
    source_url: packet.source_url ?? null,
    purchase_date: packet.purchase_date ?? null,
    unit_cost: packet.price_usd ?? null,
    notes: null,
    variety_id: variety_id ?? null,
    created_by: created_by ?? null,
    metadata,
  };
}
