// lambda/locations/validate.js — the clear:[] channel for the locations PUT. BUG-COALESCECLEAR-001.
//
// Textual mirror of the sibling validators — deliberately a COPY, not an import: each Lambda zips
// from its own directory, so a '../projects/validate.js' import resolves under vitest (which
// inlines and dedupes) and then 502s at module load in the deployed function.
//
// EXACTLY ONE of this PUT's 5 COALESCE arms is clearable. That is the finding, not a shortfall:
// three arms are NOT NULL and the fourth is a care-engine input. A blanket "every nullable column"
// allowlist would have been a worse bug than the one being fixed.
//
// Triaged against LIVE PROD (information_schema + pg_constraint) over 21 active locations.
// None of the 5 PUT arms is referenced by any CHECK on this table, so nothing here can raise 23514.

export const CLEARABLE_FIELDS = [
  // NULL on 21 of 21 live rows — proven-safe by construction. Sole consumer is an OR'd ILIKE arm
  // in searchLocations.
  'description',
];

// ─── DELIBERATELY EXCLUDED, each for its own reason ──────────────────────────────────────────────
//   name              NOT NULL (hard 23502) — AND itself a care-engine input: the coverage
//                     derivation reads l.name in ('Stable','House'), which is how 26 more live
//                     plantings resolve as covered (Stable 20, House 6). Doubly excluded. Note the
//                     RENAME hazard is NOT closed by this list or by BUG-BLANKNAME-001's '' guard:
//                     renaming Stable to anything else still resolves to a confident, WRONG
//                     `false`. Name-matching is the actual defect; the durable fix is the explicit
//                     editable locations.covered boolean that handler.js already names as V1.1.
//   type_label        THE COVERAGE INPUT. Live: area 9, zone 6, shelf 5, rack 1; 21 of 21 non-NULL,
//                     so NULL has never occurred in prod. Clearing it on Shelf 4 (15 live
//                     plantings) or Shelf 2 (1) reclassifies 16 plantings in a single PUT.
//
//                     STATUS CHANGED, BUT STILL EXCLUDED — and the reason is now different, so do
//                     not re-derive the old one. Before BUG-NOLOCOUTDOOR-001 this was a silent CARE
//                     REGRESSION: NULL type_label collapsed through coalesce(...,false) to OUTDOOR,
//                     so those 16 began taking rain credit under a roof and dropped out of the
//                     frost pass. That collapse is FIXED (dev 3c9d84b) — a NULL type_label now
//                     resolves to UNKNOWN, which fails safe in both directions.
//
//                     What remains is not plant harm, it is ALERT NOISE: unknown means "not
//                     covered" for frost, so clearing type_label opts up to 16 indoor plantings
//                     into every frost alert, with no user-visible signal that it happened. That is
//                     a product decision (Dave's), not a correctness one, and it is cheap to revisit
//                     — so this stays off the list until he says otherwise, rather than shipping a
//                     surprise. Adding it later is a one-line change plus a test.
//   is_active         NOT NULL, DEFAULT true. `false` is a value, not a clear; the existing COALESCE
//                     arm already writes it.
//   sort_order        NOT NULL, DEFAULT 0. Clear-to-ZERO is the correct affordance and already
//                     works — COALESCE(0, sort_order) is 0, not a no-op.
//   featured_photo_id Already CASE-clearable via its own hasFeatured sentinel in index.js. One
//                     column, one clear channel.
//   lat, lng          Not PUT arms at all, and chk_lat_lng_co_null is VALIDATED: they must be
//                     cleared as a PAIR or not at all. A future coordinate edit surface needs a
//                     resolveLatLngPair() in the shape of events' resolveFlagPair(), NOT two
//                     independent entries on this list.
export const CLEARABLE_SET = new Set(CLEARABLE_FIELDS);

export const MAX_CLEAR_KEYS = 64;

// Absent/null/[] is the legacy no-op, so every existing caller is byte-identical. A key that is
// BOTH cleared and given a value is rejected rather than silently resolved.
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
