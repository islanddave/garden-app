// aggregate.js — DB-free pure helpers for the harvests read model. Deliberately imports NOTHING
// runtime (no neon/clerk/aws), so lambda/harvests/index.test.js can unit-test the query-param, cursor,
// week-bucketing and aggregation logic WITHOUT the handler's runtime deps (which are absent from the
// root package.json under `npm ci` in CI). Same split rationale as lambda/preservation/attribution.js.

// timeframe ∈ {today, yesterday, 7d, month, season:<year>, all}; absent -> 'all' (comprehensive
// aggregates/crop list). Unknown -> null (handler returns 400). season:<year> parses the 4-digit
// grow-year label. V4-HARVEXPORTDAYS-001 (BD-018): today/yesterday are DAY-GRAIN and resolve in
// HARVEST_TZ server-side like every other arm — never against the client clock, which is why they
// are kinds here rather than a client-computed from/to.
export function parseTimeframe(raw) {
  if (raw == null || raw === '') return { kind: 'all' };
  if (raw === 'today' || raw === 'yesterday' || raw === '7d' || raw === 'month' || raw === 'all') return { kind: raw };
  const m = /^season:(\d{4})$/.exec(raw);
  if (m) return { kind: 'season', year: Number(m[1]) };
  return null;
}

// Keyset cursor = base64("<event_date ISO>|<uuid>"). Opaque to the client; decodes to the (date,id)
// tuple the next page compares against. Malformed -> null (treated as first page, never a 500).
export function encodeCursor(eventDate, id) {
  const iso = eventDate instanceof Date ? eventDate.toISOString() : String(eventDate);
  return Buffer.from(`${iso}|${id}`, 'utf8').toString('base64');
}
export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const s = Buffer.from(String(cursor), 'base64').toString('utf8');
    const i = s.lastIndexOf('|');
    if (i < 0) return null;
    const eventDate = s.slice(0, i);
    const id = s.slice(i + 1);
    if (!eventDate || !id) return null;
    return { eventDate, id };
  } catch { return null; }
}

// Monday (ISO week start) of the ET day, as YYYY-MM-DD. Pure string math on the server-computed
// day_key (already in HARVEST_TZ) — no Date/tz coupling. getUTCDay: 0=Sun..6=Sat -> back to Monday.
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

// Map a raw entries row to the wire entry. planting_removed distinguishes a DELETED planting
// (plant_id set but the soft-delete-filtered garden_node join produced no row) from a genuinely
// unassigned row (plant_id null) — both render, with different copy (design §3b special rows).
export function projectEntry(r) {
  return {
    event_id: r.event_id,
    event_type: r.event_type,
    event_date: r.event_date instanceof Date ? r.event_date.toISOString() : r.event_date,
    // V4-COMPOSEPOST-001 — the LOGGING instant, distinct from event_date (which is date-grained and
    // ~1.2% backdated). src/lib/harvestPost.js clusters on (created_by, created_at) to recover the
    // evening batch; day_key cannot do it. Nullable in the projector only so a hand-built row in a
    // test never crashes the mapping — the column itself is NOT NULL in prod.
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
    // V4-HARVWEIGHTREAD-001. These live HERE, in the one shared projector, and not in a wrapper at
    // the call site: BUG-HARVWEIGHTWIRE-001 happened precisely because the wire shape was listed in
    // two places (this explicit field list, and the SELECT) and slice 1 updated only one of them. A
    // third list would widen that gap, not close it. weight_grams is `numeric` -> the driver hands
    // back a STRING, so Number() here keeps the client's sums out of string concatenation. Null must
    // survive as null: "no weight yet" is the ratchet state, and Number(null) is 0, which the client
    // would render as a real measurement of nothing (see src/lib/harvestWeight.js).
    weight_grams: r.weight_grams == null ? null : Number(r.weight_grams),
    weight_estimated: r.weight_estimated ?? null,
    weight_basis: r.weight_basis ?? null,
  };
}

// Accumulate a per-native-unit sum. unit key = trimmed lowercase (design: normalized
// case-insensitive/trimmed); DOMINANT raw form displayed. NO unit conversion, ever.
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

// Live aggregates over the FULL filter range (design §3c / §7). Pure over the fetched rows so Log and
// Totals reconcile from one source. Produces: per-crop -> per-unit sums + variety sub-totals + a
// per-crop unquantified count; the "Other" bucket (unattributed rows, per project per unit); weekly
// event-count buckets (ISO-Mon, grow-year span follows the filter); first-pick per planting
// (min day_key — NEVER the first_harvest marker, per design §3b); the distinct crop list that feeds
// the crop picker; and the total unquantified (quantity-less) event count.
// V4-HARVESTVIEW-001 S4 (sparkline): each crops[] element additionally carries its OWN weekly[]
// buckets — same ISO-Monday keys and {week_start, count} shape as the top-level weekly[]. ADDITIVE
// field only (no contract bump): the per-crop sparkline needs per-row distribution, and the global
// weekly[] cannot be attributed to a crop row without inviting gestalt misreads (design §2b). Old
// clients ignore it; new clients MUST branch on absence (a frontend can deploy ahead of this Lambda
// and a rollback must hold — the TotalsWeight precedent). Unattributed rows keep counting toward the
// top-level weekly[] only; other[] deliberately carries no weekly (no sparkline renders there).
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

    // V4-HARVCROPTABLE-001: first_pick[] rows now also carry their planting's per-unit totals, so the
    // crop-detail table's Count column comes off the SAME planting-grain rowset that already carries
    // the name and the weight. Purely additive, and computed here from the fetched rows — the weight
    // GROUPING SETS pass is untouched. The accumulate can no longer live inside the earlier-date
    // branch (that re-created the entry and would restart the sum at every new minimum), so the entry
    // is created once and only the date-derived fields move when an earlier row arrives.
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
      if (!c) { c = { crop_type_slug: r.crop_slug, crop_name: r.crop_name ?? r.crop_slug, units: new Map(), varieties: new Map(), unquantified: 0, weekly: new Map() }; crops.set(r.crop_slug, c); }
      c.weekly.set(wk, (c.weekly.get(wk) ?? 0) + 1);
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

  // Name order here is the BASE ordering only. applyWeights() re-sorts crops and varieties by grams
  // once the weight rowset is merged — it cannot happen at this point because weight is a separate
  // SQL pass and these rows carry no total yet. Keeping a deterministic name order rather than Map
  // insertion order matters anyway: it is the tie-break every weightless row falls back to.
  return {
    crops: [...crops.values()].map((c) => ({
      crop_type_slug: c.crop_type_slug,
      crop_name: c.crop_name,
      units: serializeUnits(c.units),
      unquantified: c.unquantified,
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
// Both functions below started life in index.js and moved here, which is the point rather than a
// tidy-up: index.js imports neon/clerk/aws at module load and CANNOT be imported by the root vitest
// run at all, so every guard on the merge was necessarily a source-shape regex over the file's text.
// The merge is exactly the part that fails silently — see the Map-key note on applyWeights — and no
// regex can prove a Map key. Pure and exported, it is tested by calling it with a rowset.

// Shape one GROUPING-SETS row into the wire weight object. Vocabulary is deliberately IDENTICAL to
// sumHarvestWeights() in src/lib/harvestWeight.js (grams / measured / estimated / unweighed) so the
// per-planting client total and the server's season total cannot drift apart in naming or meaning.
// measured_grams and estimated_grams are carried SEPARATELY on purpose: `grams` is the honest sum
// (an estimate IS the best available value for its row), but a surface that prints it without
// saying how much of it was inferred is claiming a precision the number does not have.
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

// computeAggregates keys a cultivar-less variety bucket with this sentinel; the merge key must use
// the SAME one or those rows silently miss their weight.
const NO_VARIETY = '__novar__';
const varietyKey = (cropSlug, varietyId) => `${cropSlug}|${varietyId ?? NO_VARIETY}`;

// ORDER BY YIELD, name as the tie-break. computeAggregates cannot do this (no weight yet), and
// alphabetical was actively misleading on the one screen whose question is "which of these
// produced": live prod ranks Cherry Falls (128 fruit, 763 g, a currant type) above Moskvich
// Heirloom (65 fruit, 8,233 g). Name order survives as the tie-break so the rows with no derivable
// weight — which all compare equal at 0 — keep a stable, deterministic order rather than whatever
// order the Map happened to yield.
const byWeightThenName = (name) => (a, b) => (
  (b.weight?.grams ?? 0) - (a.weight?.grams ?? 0)
  || String(name(a) ?? '').localeCompare(String(name(b) ?? ''))
);

// Merge the four-level weight rowset onto what computeAggregates() returned, then re-order by it.
//
// THE MAP KEY IS THE WHOLE BUG. The two-level predecessor merged with
// `weightByCrop.set(r.crop_slug, ...)` — keyed on crop ALONE. Adding a (crop, cultivar) member to
// the GROUPING SETS without changing that key makes every variety row re-set() the crop entry, so
// the LAST variety's grams overwrite the crop total: tomato would render Cherry Falls' 763 g in
// place of 27,712 g, destroying the one number this surface already got right. Three levels of
// grain need three Maps and three discriminators, not one Map and one bit.
//
// GROUPING(x) is 1 when x was rolled up in that row's grouping set, so the bits read as a level
// ladder: (1,1,1) grand total · (0,1,1) crop · (0,0,1) variety · (0,0,0) planting. Reading only
// `is_total` is not enough — a (crop, NULL-cultivar) row is byte-identical to the (crop) row (same
// crop_slug, same NULL variety_id) and would land on whichever key was written last.
//
// Mutates `aggregates` in place, as the caller's own local: it is a fresh object off
// computeAggregates and the weight fields are additive keys on it, so copying would only buy a
// second shape to keep in step.
export function applyWeights(aggregates, weightRows) {
  const byCrop = new Map();
  const byVariety = new Map();
  const byPlanting = new Map();
  let total = null;
  for (const r of weightRows ?? []) {
    if (Number(r.is_total) === 1) { total = shapeWeightRow(r); continue; }
    // Crop-less rows at every level are the unattributed bucket (no cultivar -> no crop_slug).
    // aggregates.other holds those picks and deliberately carries no weight, so they are dropped
    // here rather than folded into a crop that did not produce them.
    if (r.crop_slug == null) continue;
    if (Number(r.varieties_rolled_up) === 1) { byCrop.set(r.crop_slug, shapeWeightRow(r)); continue; }
    if (Number(r.plantings_rolled_up) === 1) { byVariety.set(varietyKey(r.crop_slug, r.variety_id), shapeWeightRow(r)); continue; }
    if (r.gn_id != null) byPlanting.set(r.gn_id, shapeWeightRow(r));
  }

  // Every row gets a weight object even when nothing under it is weighable: an ABSENT key makes a
  // surface branch on undefined and print nothing, where a zeroed object with unweighed > 0 says
  // the true thing ("nothing here is weighed yet").
  aggregates.weight = total ?? shapeWeightRow(null);
  for (const c of aggregates.crops ?? []) {
    c.weight = byCrop.get(c.crop_type_slug) ?? shapeWeightRow(null);
    for (const v of c.varieties ?? []) {
      v.weight = byVariety.get(varietyKey(c.crop_type_slug, v.variety_id)) ?? shapeWeightRow(null);
    }
    c.varieties?.sort(byWeightThenName((v) => v.variety_name));
  }
  // Per-planting weight rides first_pick[] rather than a new plantings[] array: that array is
  // ALREADY the planting-grain row set (one row per plant_id, with its display name) and the
  // Totals expansion already renders it, so a parallel array would duplicate plant_id and
  // planting_name to carry one extra field.
  for (const f of aggregates.first_pick ?? []) {
    f.weight = byPlanting.get(f.plant_id) ?? shapeWeightRow(null);
  }
  aggregates.crops?.sort(byWeightThenName((c) => c.crop_name));
  return aggregates;
}
