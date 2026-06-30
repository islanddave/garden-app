// DRG-BACKBONE-001 P0 / G-PARITY — tolerance-bounded comparator.
//
// Deep-compares two ALREADY-CANONICALIZED plans and returns a structured diff. Numeric leaves compare within
// an absolute tolerance (default 0 — canonicalize already rounds to FLOAT_DP, so exact by default; a caller
// can widen for noisier persisted-row comparisons). Diffs whose path is on the benign allowlist are recorded
// separately and do NOT count toward `blocking`.
//
// Path syntax: object keys join with '.'; array elements are addressed by their canonical row key as
// `field#<id>` (or `field#j:<hash>` for keyless rows) so a diff path is stable and human-readable
// ("users.dave.tasks.water_due#w1.interval") regardless of array position.
import { isBenignPath } from './allowlist.mjs';
import { canonicalize } from './canonicalize.mjs';

export function compare(golden, candidate, { tolerance = 0, allowlist = isBenignPath, canon = true } = {}) {
  const a = canon ? canonicalize(golden) : golden;
  const b = canon ? canonicalize(candidate) : candidate;
  const diffs = [];
  diff(a, b, '', diffs, tolerance);
  const benign = diffs.filter((d) => allowlist(d.path));
  const blocking = diffs.filter((d) => !allowlist(d.path));
  return { equal: blocking.length === 0, blocking, benign, all: diffs };
}

function diff(a, b, path, out, tol) {
  if (a === b) return;
  const ta = kindOf(a), tb = kindOf(b);
  if (ta !== tb) { out.push({ path: path || '$', type: 'type', golden: a, candidate: b }); return; }
  if (ta === 'number') {
    if (Math.abs(a - b) > tol) out.push({ path, type: 'value', golden: a, candidate: b });
    return;
  }
  if (ta === 'array') {
    const ma = indexByKey(a), mb = indexByKey(b);
    const keys = new Set([...ma.keys(), ...mb.keys()]);
    for (const k of [...keys].sort()) {
      const p = `${path}#${k}`;
      if (!ma.has(k)) { out.push({ path: p, type: 'added', golden: undefined, candidate: mb.get(k) }); continue; }
      if (!mb.has(k)) { out.push({ path: p, type: 'removed', golden: ma.get(k), candidate: undefined }); continue; }
      diff(ma.get(k), mb.get(k), p, out, tol);
    }
    return;
  }
  if (ta === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in a)) { out.push({ path: p, type: 'added', golden: undefined, candidate: b[k] }); continue; }
      if (!(k in b)) { out.push({ path: p, type: 'removed', golden: a[k], candidate: undefined }); continue; }
      diff(a[k], b[k], p, out, tol);
    }
    return;
  }
  // string / boolean / null
  if (a !== b) out.push({ path, type: 'value', golden: a, candidate: b });
}

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// Address array rows by id (or canonical-json hash) — same key scheme the canonicalizer sorts by, so a row
// that moved position but didn't change reports NO diff.
function indexByKey(arr) {
  const m = new Map();
  arr.forEach((e, i) => {
    let k = e && typeof e === 'object' && !Array.isArray(e) && e.id != null ? String(e.id) : `j:${JSON.stringify(e)}`;
    if (m.has(k)) k = `${k}~${i}`;   // disambiguate genuine duplicate keys
    m.set(k, e);
  });
  return m;
}

// One-line-per-diff human report for the shadow-divergence alert / CI failure message.
export function formatDiffs(diffs) {
  if (!diffs.length) return '(no diffs)';
  return diffs.map((d) => `  ${d.type.toUpperCase()} ${d.path}: ${trunc(d.golden)} -> ${trunc(d.candidate)}`).join('\n');
}
function trunc(v) {
  const s = v === undefined ? '∅' : JSON.stringify(v);
  return s && s.length > 80 ? s.slice(0, 77) + '...' : s;
}
