// DB-free pure helpers for the harvests read model. Imports NOTHING runtime (no neon/clerk/aws), so
// index.test.js can unit-test them without the handler's runtime deps, which are absent from the root
// package.json under `npm ci` in CI.

// timeframe is one of today, yesterday, 7d, month, season:<year>, all. Absent -> 'all'; unknown -> null
// (the handler returns 400). today/yesterday are day-grain and resolve in HARVEST_TZ server-side, never
// against the client clock, which is why they are kinds here rather than a client-computed from/to.
export function parseTimeframe(raw) {
  if (raw == null || raw === '') return { kind: 'all' };
  if (raw === 'today' || raw === 'yesterday' || raw === '7d' || raw === 'month' || raw === 'all') return { kind: raw };
  const m = /^season:(\d{4})$/.exec(raw);
  if (m) return { kind: 'season', year: Number(m[1]) };
  return null;
}

// Keyset cursor = base64("<event_date ISO>|<created_at ISO>|<uuid>"). Opaque to the client. Malformed ->
// null (treated as first page, never 500).
//
// created_at is the middle component because `event_log.id` is a uuid, so (event_date, id) alone ordered
// entries within a day effectively at random. `id` STAYS last as the strictly unique tiebreaker: rows from
// one bulk fan-out can share a created_at to the microsecond, and a non-unique keyset drops or repeats
// rows at a page boundary.
export function encodeCursor(eventDate, createdAt, id) {
  const iso = (v) => (v instanceof Date ? v.toISOString() : String(v));
  return Buffer.from(`${iso(eventDate)}|${iso(createdAt)}|${id}`, 'utf8').toString('base64');
}
export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const s = Buffer.from(String(cursor), 'base64').toString('utf8');
    const parts = s.split('|');
    // BACKWARD COMPATIBLE: a client mid-pagination across a deploy holds a 2-part cursor, and rejecting
    // it would throw them back to page 1. It keeps its old meaning and the caller falls back to the old
    // comparison for that one page.
    if (parts.length === 2) {
      const [eventDate, id] = parts;
      if (!eventDate || !id) return null;
      return { eventDate, createdAt: null, id };
    }
    if (parts.length !== 3) return null;
    const [eventDate, createdAt, id] = parts;
    if (!eventDate || !createdAt || !id) return null;
    return { eventDate, createdAt, id };
  } catch { return null; }
}

// Monday (ISO week start) of the ET day, as YYYY-MM-DD. Pure string math on the server-computed
// day_key (already in HARVEST_TZ), so there is no Date/tz coupling. getUTCDay: 0=Sun..6=Sat.
export function isoWeekStart(dayKey) {
  const [y, m, d] = String(dayKey).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  const delta = dow === 0 ? 6 : dow - 1;
  dt.setUTCDate(dt.getUTCDate() - delta);
  return dt.toISOString().slice(0, 10);
}

function noteExcerpt(notes) {
  if (!notes) return null;
  const first = String(notes).split('\n')[0].trim();
  return first ? first.slice(0, 200) : null;
}

// Map a raw entries row to the wire entry. planting_removed distinguishes a DELETED planting (plant_id
// set but the soft-delete-filtered garden_node join produced no row) from an unassigned row (plant_id null).
export function projectEntry(r) {
  return {
    event_id: r.event_id,
    event_type: r.event_type,
    event_date: r.event_date instanceof Date ? r.event_date.toISOString() : r.event_date,
    // The LOGGING instant, distinct from event_date (date-grained, often backdated).
    // src/lib/harvestPost.js clusters on (created_by, created_at) to recover the evening batch. Nullable
    // only so a hand-built test row never crashes the mapping; the column is NOT NULL in prod.
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : (r.created_at ?? null),
    created_by: r.created_by ?? null,
    day_key: r.day_key,
    plant_id: r.plant_id ?? null,
    planting_name: r.planting_name ?? null,
    planting_removed: r.plant_id != null && r.gn_id == null,
    crop_type_slug: r.crop_slug ?? null,
    crop_name: r.crop_name ?? (r.crop_slug ?? null),
    variety_id: r.variety_id ?? null,
    variety_name: r.variety_name ?? null,
    project_id: r.project_id,
    project_name: r.project_name ?? null,
    quantity: r.quantity ?? null,
    unit: r.unit ?? null,
    quality_rating: r.quality_rating ?? null,
    note_excerpt: noteExcerpt(r.notes),
    photos: Array.isArray(r.photos) ? r.photos : [],
    harvest_log_id: r.harvest_log_id ?? null,
    // These live in this one shared projector, not in a wrapper at the call site: the wire shape used to
    // be listed in two places (this field list and the SELECT) and one drifted (BUG-HARVWEIGHTWIRE-001).
    // weight_grams is `numeric`, so the driver returns a STRING; Number() keeps client sums out of string
    // concatenation. Null must stay null: "no weight yet" is a real state, and Number(null) is 0, which
    // the client would render as a measurement of nothing (see src/lib/harvestWeight.js).
    weight_grams: r.weight_grams == null ? null : Number(r.weight_grams),
    weight_estimated: r.weight_estimated ?? null,
    weight_basis: r.weight_basis ?? null,
  };
}

// Accumulate a per-native-unit sum. unit key = trimmed lowercase; the DOMINANT raw form is displayed.
// NO unit conversion, ever.
function addUnit(unitMap, unit, qty) {
  const raw = unit == null ? '' : String(unit);
  const key = raw.trim().toLowerCase();
  let u = unitMap.get(key);
  if (!u) { u = { key, total: 0, count: 0, raw: new Map() }; unitMap.set(key, u); }
  u.total += qty;
  u.count += 1;
  u.raw.set(raw, (u.raw.get(raw) ?? 0) + 1);
}
function serializeUnits(unitMap) {
  return [...unitMap.values()].map((u) => {
    let dom = u.key, best = -1;
    for (const [raw, n] of u.raw) if (n > best) { best = n; dom = raw; }
    return { unit: dom, unit_key: u.key, total: Number(u.total.toFixed(4)), count: u.count };
  }).sort((a, b) => a.unit_key.localeCompare(b.unit_key));
}

// Live aggregates over the FULL filter range, pure over the fetched rows so Log and Totals reconcile
// from one source. Produces: per-crop -> per-unit sums + variety sub-totals + an unquantified count; the
// "Other" bucket (unattributed rows, per project per unit); weekly event-count buckets (ISO-Mon); first
// pick per planting (min day_key, NEVER the first_harvest marker); the distinct crop list for the crop
// picker; and the total unquantified event count.
// Each crops[] element also carries its OWN weekly[] (same {week_start, count} shape). ADDITIVE, no
// contract bump: new clients MUST branch on absence, because a frontend can deploy ahead of this Lambda
// and a rollback must hold. Unattributed rows count toward the top-level weekly[] only; other[] carries
// no weekly.
export function computeAggregates(rows) {
  const crops = new Map();
  const other = new Map();
  const firstPick = new Map();
  const weekly = new Map();
  const cropList = new Map();
  let unquantifiedTotal = 0;

  for (const r of rows) {
    const wk = isoWeekStart(r.day_key);
    weekly.set(wk, (weekly.get(wk) ?? 0) + 1);
    if (r.crop_slug) cropList.set(r.crop_slug, r.crop_name ?? r.crop_slug);

    const q = r.quantity == null ? null : Number(r.quantity);
    const hasQty = r.harvest_log_id != null && q != null && !Number.isNaN(q);
    if (!hasQty) unquantifiedTotal += 1;

    // first_pick[] rows also carry their planting's per-unit totals, so the crop-detail Count column
    // comes off the same planting-grain rowset. The entry is created once and only the date-derived
    // fields move when an earlier row arrives; accumulating inside that branch would restart the sum.
    if (r.plant_id != null && r.gn_id != null) {
      let fp = firstPick.get(r.plant_id);
      if (!fp) {
        fp = {
          plant_id: r.plant_id,
          planting_name: r.planting_name ?? null,
          crop_type_slug: r.crop_slug ?? null,
          first_pick_date: r.day_key,
          units: new Map(),
          unquantified: 0,
        };
        firstPick.set(r.plant_id, fp);
      } else if (r.day_key < fp.first_pick_date) {
        fp.planting_name = r.planting_name ?? null;
        fp.crop_type_slug = r.crop_slug ?? null;
        fp.first_pick_date = r.day_key;
      }
      if (hasQty) addUnit(fp.units, r.unit, q); else fp.unquantified += 1;
    }

    if (r.crop_slug) {
      let c = crops.get(r.crop_slug);
      if (!c) { c = { crop_type_slug: r.crop_slug, crop_name: r.crop_name ?? r.crop_slug, units: new Map(), varieties: new Map(), unquantified: 0, weekly: new Map(), hero: null }; crops.set(r.crop_slug, c); }
      c.weekly.set(wk, (c.weekly.get(wk) ?? 0) + 1);
      // The crop's MOST RECENTLY HARVESTED planting. Ordered (day_key, event_id) DESC: day_key is
      // date-grain, and event_id is the only strictly unique field here, so WITHOUT it the winner would
      // depend on Postgres row order. gn_id gates it as it does first_pick: a soft-deleted planting
      // LEFT-JOINs to NULL, and naming it hero would resolve a photo off a row the page cannot show.
      if (r.plant_id != null && r.gn_id != null
          && (!c.hero || r.day_key > c.hero.day_key
              || (r.day_key === c.hero.day_key && String(r.event_id) > String(c.hero.event_id)))) {
        c.hero = { plant_id: r.plant_id, day_key: r.day_key, event_id: r.event_id };
      }
      if (hasQty) addUnit(c.units, r.unit, q); else c.unquantified += 1;
      const vkey = r.variety_id ?? '__novar__';
      let v = c.varieties.get(vkey);
      if (!v) { v = { variety_id: r.variety_id ?? null, variety_name: r.variety_name ?? null, units: new Map(), unquantified: 0 }; c.varieties.set(vkey, v); }
      if (hasQty) addUnit(v.units, r.unit, q); else v.unquantified += 1;
    } else {
      let o = other.get(r.project_id);
      if (!o) { o = { project_id: r.project_id, project_name: r.project_name ?? null, units: new Map(), unquantified: 0 }; other.set(r.project_id, o); }
      if (hasQty) addUnit(o.units, r.unit, q); else o.unquantified += 1;
    }
  }

  // Name order is the BASE ordering only; applyWeights() re-sorts by grams once the weight rowset is
  // merged. It stays deterministic rather than Map insertion order because it is the tie-break for every
  // weightless row.
  return {
    crops: [...crops.values()].map((c) => ({
      crop_type_slug: c.crop_type_slug,
      crop_name: c.crop_name,
      units: serializeUnits(c.units),
      unquantified: c.unquantified,
      // ADDITIVE, same contract as weekly[]: the planting whose photo represents this crop. The photo id
      // is resolved by applyCropHeroPhotos() and this field keys the two together.
      hero_plant_id: c.hero?.plant_id ?? null,
      weekly: [...c.weekly.entries()].map(([week_start, count]) => ({ week_start, count })).sort((a, b) => a.week_start.localeCompare(b.week_start)),
      varieties: [...c.varieties.values()].map((v) => ({
        variety_id: v.variety_id, variety_name: v.variety_name, units: serializeUnits(v.units), unquantified: v.unquantified,
      })).sort((a, b) => String(a.variety_name ?? '').localeCompare(String(b.variety_name ?? ''))),
    })).sort((a, b) => a.crop_name.localeCompare(b.crop_name)),
    other: [...other.values()].map((o) => ({
      project_id: o.project_id, project_name: o.project_name, units: serializeUnits(o.units), unquantified: o.unquantified,
    })).sort((a, b) => String(a.project_name ?? '').localeCompare(String(b.project_name ?? ''))),
    weekly: [...weekly.entries()].map(([week_start, count]) => ({ week_start, count })).sort((a, b) => a.week_start.localeCompare(b.week_start)),
    first_pick: [...firstPick.values()].map((f) => ({
      plant_id: f.plant_id,
      planting_name: f.planting_name,
      crop_type_slug: f.crop_type_slug,
      first_pick_date: f.first_pick_date,
      units: serializeUnits(f.units),
      unquantified: f.unquantified,
    })).sort((a, b) => a.first_pick_date.localeCompare(b.first_pick_date)),
    crop_list: [...cropList.entries()].map(([crop_type_slug, display_name]) => ({ crop_type_slug, display_name })).sort((a, b) => a.display_name.localeCompare(b.display_name)),
    unquantified_total: unquantifiedTotal,
  };
}

// ── Weight, merged onto the aggregate shape (V4-HARVGRAIN-001) ──────────────────────────────────────
//
// These live here, not in index.js, because index.js imports neon/clerk/aws at load and the root vitest
// run cannot import it. The merge fails silently (see the Map-key note on applyWeights) and no regex can
// prove a Map key, so it is pure, exported and tested by calling it with a rowset.

// Shape one GROUPING-SETS row into the wire weight object. Vocabulary is IDENTICAL to sumHarvestWeights()
// in src/lib/harvestWeight.js (grams / measured / estimated / unweighed) so client and server totals
// cannot drift in naming or meaning. measured_grams and estimated_grams are carried SEPARATELY on
// purpose: `grams` is the honest sum, but printing it without saying how much was inferred claims a
// precision the number does not have.
export function shapeWeightRow(r) {
  const measuredGrams = Number(r?.measured_grams ?? 0);
  const estimatedGrams = Number(r?.estimated_grams ?? 0);
  return {
    grams: measuredGrams + estimatedGrams,
    measured_grams: measuredGrams,
    estimated_grams: estimatedGrams,
    measured: Number(r?.measured_count ?? 0),
    estimated: Number(r?.estimated_count ?? 0),
    unweighed: Number(r?.unweighed_count ?? 0),
  };
}

// computeAggregates keys a cultivar-less variety bucket with this sentinel; the merge key must use the
// SAME one or those rows silently miss their weight.
const NO_VARIETY = '__novar__';
const varietyKey = (cropSlug, varietyId) => `${cropSlug}|${varietyId ?? NO_VARIETY}`;

// ORDER BY YIELD, name as the tie-break. computeAggregates cannot do this (no weight yet), and
// alphabetical misleads on the one screen whose question is "which of these produced". Name order keeps
// rows with no derivable weight (all 0) in a stable order instead of Map order.
const byWeightThenName = (name) => (a, b) => (
  (b.weight?.grams ?? 0) - (a.weight?.grams ?? 0)
  || String(name(a) ?? '').localeCompare(String(name(b) ?? ''))
);

// Merge the four-level weight rowset onto what computeAggregates() returned, then re-order by it.
//
// THE MAP KEY IS THE WHOLE BUG. The two-level predecessor keyed on crop ALONE; adding a (crop, cultivar)
// member to the GROUPING SETS without changing that key makes every variety row re-set() the crop entry,
// so the LAST variety's grams overwrite the crop total. Three levels of grain need three Maps and three
// discriminators.
//
// GROUPING(x) is 1 when x was rolled up in that row's grouping set: (1,1,1) grand total, (0,1,1) crop,
// (0,0,1) variety, (0,0,0) planting. Reading only `is_total` is not enough: a (crop, NULL-cultivar) row is
// byte-identical to the (crop) row and would land on whichever key was written last.
//
// Mutates `aggregates` in place: it is a fresh object off computeAggregates and the weight fields are
// additive keys on it.
export function applyWeights(aggregates, weightRows) {
  const byCrop = new Map();
  const byVariety = new Map();
  const byPlanting = new Map();
  let total = null;
  for (const r of weightRows ?? []) {
    if (Number(r.is_total) === 1) { total = shapeWeightRow(r); continue; }
    // Crop-less rows at every level are the unattributed bucket. aggregates.other carries no weight, so
    // they are dropped here rather than folded into a crop that did not produce them.
    if (r.crop_slug == null) continue;
    if (Number(r.varieties_rolled_up) === 1) { byCrop.set(r.crop_slug, shapeWeightRow(r)); continue; }
    if (Number(r.plantings_rolled_up) === 1) { byVariety.set(varietyKey(r.crop_slug, r.variety_id), shapeWeightRow(r)); continue; }
    if (r.gn_id != null) byPlanting.set(r.gn_id, shapeWeightRow(r));
  }

  // Every row gets a weight object even when nothing under it is weighable: an ABSENT key makes a surface
  // print nothing, where a zeroed object with unweighed > 0 says "nothing here is weighed yet".
  aggregates.weight = total ?? shapeWeightRow(null);
  for (const c of aggregates.crops ?? []) {
    c.weight = byCrop.get(c.crop_type_slug) ?? shapeWeightRow(null);
    for (const v of c.varieties ?? []) {
      v.weight = byVariety.get(varietyKey(c.crop_type_slug, v.variety_id)) ?? shapeWeightRow(null);
    }
    c.varieties?.sort(byWeightThenName((v) => v.variety_name));
  }
  // Per-planting weight rides first_pick[], which is already the planting-grain row set (one row per
  // plant_id with its display name) that the Totals expansion renders.
  for (const f of aggregates.first_pick ?? []) {
    f.weight = byPlanting.get(f.plant_id) ?? shapeWeightRow(null);
  }
  aggregates.crops?.sort(byWeightThenName((c) => c.crop_name));
  return aggregates;
}

// ── Crop hero photo, merged onto the aggregate shape (V4-HARVCROPPHOTO-001) ─────────────────────
//
// rows = [{ plant_id, photo_id }] for the plantings computeAggregates named in hero_plant_id. Pure and
// exported for the same reason as applyWeights: a key mismatch is invisible to a regex over source.
//
// EVERY crop gets the key, null included. Absent says "this Lambda predates the feature"; null says
// "asked, and this crop has no photo". The client branches on absence to survive a rollback.
//
// A photo id is NOT a URL and never becomes one here: resolving it would mean copying photo-access.js
// into this function and granting it the photos bucket. The client resolves each id against the
// household-scoped GET /api/photos/view-url/:id, which also keeps a leaked id unviewable.
export function applyCropHeroPhotos(aggregates, rows) {
  const byPlanting = new Map();
  for (const r of rows ?? []) {
    if (r?.plant_id != null && r.photo_id != null) byPlanting.set(r.plant_id, r.photo_id);
  }
  for (const c of aggregates?.crops ?? []) {
    c.hero_photo_id = (c.hero_plant_id != null ? byPlanting.get(c.hero_plant_id) : null) ?? null;
  }
  return aggregates;
}
