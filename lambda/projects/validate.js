// The clear:[] channel for the projects PUT (BUG-COALESCECLEAR-001).
//
// Textual mirror of lambda/plants/validate.js, lambda/varieties/validate.js and lambda/events/clearFields.js,
// deliberately a COPY, not an import: each Lambda zips from its own directory, so a '../plants/validate.js'
// import resolves under vitest and then 502s at module load in the deployed function.
//
// THE CLASS: `COALESCE(${body.x ?? null}, x)` makes a column WRITE-ONCE-SETTABLE. `null` and `absent` are
// the same token on the wire, so once the column holds a value no request body returns it to NULL. The
// projects PUT carries 8 such arms; this names the 5 that may be cleared. Triaged against the LIVE PROD
// schema (information_schema + pg_constraint) and the care engine, not migration files.

export const CLEARABLE_FIELDS = [
  // Free text; the only consumers are searchProjects' snippet and an OR'd ILIKE arm, both NULL-safe.
  'description',
  // Display + search only. NOT the care engine's variety (that is pv.name from plant_varieties).
  'variety',
  // Already NULL on many live rows, so NULL is a proven-live state. No filter, ordering or date math reads it.
  'start_date',
  // No row has ever held a value, yet the PUT can set it: a live one-way door. Branched on by nothing in lambda/ or src/.
  'target_end_date',
  // Clearing a project's location makes the daily-plan `left join locations l on l.id =
  // coalesce(p.location_id, pj.location_id)` NULL for any planting without its own location. That was
  // BUG-NOLOCOUTDOOR-001 (collapse to OUTDOOR); coverage is now three-state and an absent location resolves
  // to UNKNOWN, which fails safe in BOTH directions (never rain-credited, still frost-alerted), so the
  // column is clearable. Sequencing mattered: this entry would have been a care regression had it landed
  // first. ON DELETE SET NULL, no CHECK.
  'location_id',
];

// DELIBERATELY EXCLUDED, each for its own reason:
//   name              NOT NULL on plant_projects (written through the container view as display_name):
//                     a hard 23502. Blanking is refused separately by BUG-BLANKNAME-001's guard in
//                     index.js; that guard is about '' and this list is about NULL.
//   status            NOT NULL, DEFAULT 'planning', plant_projects_status_check is VALIDATED. index.js
//                     computes `_newStatus = body.status != null ? body.status : _oldStatus`, so a CLEAR
//                     would read as no-change and silently skip the in-txn status_change audit event and
//                     the entity_memory touch. Same call as plants' `status` exclusion.
//   is_public         NOT NULL boolean. "Clearing" means false, a plain write the COALESCE arm already serves.
//   kind,             Already CASE-clearable via their own hasOwnProperty sentinels in index.js. Listing
//   featured_photo_id them here would give one column two clear channels with two validators.
//   parent_project_id
//   assignee_user_id
//   created_by        Guarded by the ownership-transfer trigger, which raises on ANY IS DISTINCT FROM
//                     change including value->NULL. Must never be listed.
export const CLEARABLE_SET = new Set(CLEARABLE_FIELDS);

export const MAX_CLEAR_KEYS = 64;

// Absent/null/[] is the legacy no-op. A key that is BOTH cleared and given a value is rejected rather than silently resolved.
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
