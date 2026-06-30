// DRG-BACKBONE-001 P0 / G-PARITY — canonicalizer.
//
// Normalizes a daily-plan object (or a persisted daily_plan row's items payload) into a stable shape so the
// comparator measures SEMANTIC difference, not incidental nondeterminism. Three normalizations, matching the
// §16 OQ1 refinement (row order / timestamp rounding / float-aggregation precision):
//
//   1. ROW ORDER — every task array (water_due, no_history, fertilize, pest, cold, dormant, rain_skipped) is
//      sorted by a stable key (its `id`, falling back to a JSON hash) so the engine's presentation ordering
//      (e.g. water_due sorted by overdue-desc) can change in a refactor without tripping parity. Object keys
//      are emitted in sorted order by canonicalJSON for byte-stable goldens.
//   2. TIMESTAMP ROUNDING — any ISO-8601 timestamp leaf is truncated to the configured granularity (default
//      day). The pure engine emits only the date string today, but persisted ROWS carry created_at/updated_at
//      wall-clocks; truncation keeps those from oscillating. (Most are also allowlisted; truncation is the
//      second line of defense.)
//   3. FLOAT PRECISION — every finite number is rounded to FLOAT_DP decimals, killing float-aggregation drift
//      (e.g. 0.1+0.2 fan-out) that would otherwise read as a diff.
//
// Pure + idempotent: canonicalize(canonicalize(x)) deep-equals canonicalize(x).
export const FLOAT_DP = 6;
export const TS_GRANULARITY = 'day';   // 'day' | 'minute' | 'second'

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

export function canonicalize(value, { floatDp = FLOAT_DP, tsGranularity = TS_GRANULARITY } = {}) {
  return norm(value, { floatDp, tsGranularity });
}

function norm(v, opts) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'number') return Number.isFinite(v) ? round(v, opts.floatDp) : String(v); // NaN/Inf -> stable token
  if (typeof v === 'string') return ISO_RE.test(v) ? truncTs(v, opts.tsGranularity) : v;
  if (Array.isArray(v)) {
    const items = v.map((e) => norm(e, opts));
    return sortByKey(items);
  }
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k], opts);  // sorted keys -> byte-stable
    return out;
  }
  return v;
}

function round(n, dp) {
  const f = 10 ** dp;
  // +0 normalizes -0 to 0 so goldens never carry a signed zero.
  return Math.round(n * f) / f + 0;
}

function truncTs(s, gran) {
  if (gran === 'day') return s.slice(0, 10);
  if (gran === 'minute') return s.slice(0, 16);
  if (gran === 'second') return s.slice(0, 19);
  return s;
}

// Stable array order. Prefer an `id` field (task rows all carry one); otherwise sort by the canonical JSON of
// the element so order is deterministic for keyless arrays too. Sort is by string key; ties keep input order
// (stable since we map first).
function sortByKey(items) {
  const keyed = items.map((e, i) => ({ e, i, k: rowKey(e) }));
  keyed.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i));
  return keyed.map((x) => x.e);
}

function rowKey(e) {
  if (e && typeof e === 'object' && !Array.isArray(e) && e.id != null) return 'id:' + String(e.id);
  return 'j:' + canonicalJSON(e);
}

// Deterministic JSON with sorted keys — used for goldens on disk and for keyless-array ordering.
export function canonicalJSON(value, opts) {
  return JSON.stringify(canonicalize(value, opts));
}
