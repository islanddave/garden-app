// DRG-BACKBONE-001 P0 / G-PARITY — benign-diff allowlist.
//
// §16 OQ1 refinement (boss-technical + regression-impact re-review) sharpened G-PARITY's "byte-equivalent"
// into a CANONICALIZED, TOLERANCE-BOUNDED comparison with an explicit allowlist of benign diffs — so parity
// is *achievable* (the shared-engine cutover can't be stranded in perpetual shadow by incidental
// nondeterminism) WITHOUT letting a real semantic regression slip through.
//
// Each entry matches the dot-joined path of a leaf value in the canonicalized plan. '*' matches exactly one
// path segment; '**' matches zero or more. A diff whose path matches ANY entry is benign: it does NOT block
// parity and does NOT page the shadow-divergence alert. Keep MINIMAL — every entry is a place a regression
// could hide. Semantic fields (counts, task identities, reasons, intervals, callout text, substrate
// messages) are deliberately NOT here: they MUST match.
export const BENIGN_DIFF_ALLOWLIST = [
  // DB-row bookkeeping timestamps — present only when comparing persisted daily_plan ROWS (the future
  // cutover compares stored rows, not just the pure engine object). Wall-clock, never semantic.
  '**.generated_at',
  '**.created_at',
  '**.updated_at',
  '**.computed_at',
  // engine_version is EXPECTED to differ across a refactor (that's the point of stamping it). daily_plan
  // .engine_version (added in 0a) rides here so a version bump alone never blocks the gate.
  '**.engine_version',
];

// Returns true if `path` (e.g. "users.dave.tasks.water_due#w1.rain_note") is benign.
export function isBenignPath(path) {
  return BENIGN_DIFF_ALLOWLIST.some((pat) => matchGlob(pat, path));
}

// Minimal glob over '.'-split segments. '*' = one segment; '**' = zero-or-more. Patterns are static
// constants above (no data-derived regex), so this is injection-free.
export function matchGlob(pattern, path) {
  return walk(pattern.split('.'), 0, path.split('.'), 0);
}

function walk(pp, pi, sp, si) {
  while (pi < pp.length) {
    const tok = pp[pi];
    if (tok === '**') {
      if (pi === pp.length - 1) return true;            // trailing ** matches the rest
      for (let k = si; k <= sp.length; k++) {           // ** consumes 0..n segments, then the rest must match
        if (walk(pp, pi + 1, sp, k)) return true;
      }
      return false;
    }
    if (si >= sp.length) return false;
    if (tok !== '*' && tok !== sp[si]) return false;     // '*' matches any single segment
    pi++; si++;
  }
  return si === sp.length;
}
