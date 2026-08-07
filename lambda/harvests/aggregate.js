// aggregate.js — DB-free pure helpers for the harvests read model. Deliberately imports NOTHING
// runtime (no neon/clerk/aws), so lambda/harvests/index.test.js can unit-test the query-param, cursor,
// week-bucketing and aggregation logic WITHOUT the handler's runtime deps (which are absent from the
// root package.json under `npm ci` in CI). Same split rationale as lambda/preservation/attribution.js.

// timeframe ∈ {7d, month, season:<year>, all}; absent -> 'all' (comprehensive aggregates/crop list).
// Unknown -> null (handler returns 400). season:<year> parses the 4-digit grow-year label.
export function parseTimeframe(raw) {
  if (raw == null || raw === '') return { kind: 'all' };
  if (raw === '7d' || raw === 'month' || raw === 'all') return { kind: raw };
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

    if (r.plant_id != null && r.gn_id != null) {
      const fp = firstPick.get(r.plant_id);
      if (!fp || r.day_key < fp.first_pick_date) {
        firstPick.set(r.plant_id, {
          plant_id: r.plant_id,
          planting_name: r.planting_name ?? null,
          crop_type_slug: r.crop_slug ?? null,
          first_pick_date: r.day_key,
        });
      }
    }

    const q = r.quantity == null ? null : Number(r.quantity);
    const hasQty = r.harvest_log_id != null && q != null && !Number.isNaN(q);
    if (!hasQty) unquantifiedTotal += 1;

    if (r.crop_slug) {
      let c = crops.get(r.crop_slug);
      if (!c) { c = { crop_type_slug: r.crop_slug, crop_name: r.crop_name ?? r.crop_slug, units: new Map(), varieties: new Map(), unquantified: 0 }; crops.set(r.crop_slug, c); }
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

  return {
    crops: [...crops.values()].map((c) => ({
      crop_type_slug: c.crop_type_slug,
      crop_name: c.crop_name,
      units: serializeUnits(c.units),
      unquantified: c.unquantified,
      varieties: [...c.varieties.values()].map((v) => ({
        variety_id: v.variety_id, variety_name: v.variety_name, units: serializeUnits(v.units), unquantified: v.unquantified,
      })).sort((a, b) => String(a.variety_name ?? '').localeCompare(String(b.variety_name ?? ''))),
    })).sort((a, b) => a.crop_name.localeCompare(b.crop_name)),
    other: [...other.values()].map((o) => ({
      project_id: o.project_id, project_name: o.project_name, units: serializeUnits(o.units), unquantified: o.unquantified,
    })).sort((a, b) => String(a.project_name ?? '').localeCompare(String(b.project_name ?? ''))),
    weekly: [...weekly.entries()].map(([week_start, count]) => ({ week_start, count })).sort((a, b) => a.week_start.localeCompare(b.week_start)),
    first_pick: [...firstPick.values()].sort((a, b) => a.first_pick_date.localeCompare(b.first_pick_date)),
    crop_list: [...cropList.entries()].map(([crop_type_slug, display_name]) => ({ crop_type_slug, display_name })).sort((a, b) => a.display_name.localeCompare(b.display_name)),
    unquantified_total: unquantifiedTotal,
  };
}
