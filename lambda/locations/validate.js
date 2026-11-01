// The clear:[] channel for the locations PUT (BUG-COALESCECLEAR-001).
//
// Textual mirror of the sibling validators, deliberately a COPY, not an import: each Lambda zips from its
// own directory, so a '../projects/validate.js' import resolves under vitest and then 502s at module load
// in the deployed function.
//
// EXACTLY ONE of this PUT's 5 COALESCE arms is clearable: three are NOT NULL and the fourth is a
// care-engine input. A blanket "every nullable column" allowlist would be a worse bug than the one fixed.
// None of the 5 PUT arms is referenced by any CHECK on this table, so nothing here can raise 23514.

export const CLEARABLE_FIELDS = [
  // Sole consumer is an OR'd ILIKE arm in searchLocations; NULL on every live row.
  'description',
];

// DELIBERATELY EXCLUDED, each for its own reason:
//   name              NOT NULL (hard 23502). The coverage derivation no longer reads l.name
//                     (V4-COVEREDNOTMODELLED-001: handler.js reads the editable locations.covered flag),
//                     so the rename hazard is closed and `name` is excluded on the NOT NULL ground alone.
//   type_label        THE COVERAGE INPUT. A NULL type_label resolves to UNKNOWN, which fails safe
//                     (BUG-NOLOCOUTDOOR-001). What remains is ALERT NOISE, not plant harm: unknown means
//                     "not covered" for frost, so clearing it would opt indoor plantings (a whole shelf in
//                     one PUT) into every frost alert with no visible signal. That is Dave's product
//                     decision; adding it later is a one-line change plus a test.
//   is_active         NOT NULL, DEFAULT true. `false` is a value, not a clear.
//   sort_order        NOT NULL, DEFAULT 0. Clear-to-ZERO already works (COALESCE(0, sort_order) is 0).
//   featured_photo_id Already CASE-clearable via its own hasFeatured sentinel in index.js. One column,
//                     one clear channel.
//   lat, lng          Not PUT arms, and chk_lat_lng_co_null is VALIDATED: they must be cleared as a PAIR.
//                     A future coordinate edit needs a resolveLatLngPair() shaped like events'
//                     resolveFlagPair(), NOT two independent entries on this list.
export const CLEARABLE_SET = new Set(CLEARABLE_FIELDS);

export const MAX_CLEAR_KEYS = 64;

// Absent/null/[] is the legacy no-op. A key that is BOTH cleared and given a value is rejected rather than
// silently resolved.
export function validateClear(clear, body = {}) {
  if (clear == null) return null;
  if (!Array.isArray(clear)) return 'clear must be an array of field names';
  if (clear.length > MAX_CLEAR_KEYS) return `clear may name at most ${MAX_CLEAR_KEYS} fields`;
  for (const k of clear) {
    if (typeof k !== 'string' || !CLEARABLE_SET.has(k)) {
      return `clear contains a field that cannot be cleared: ${String(k)}`;
    }
    if (body[k] != null) return `${k} cannot be both cleared and set in the same request`;
  }
  return null;
}
