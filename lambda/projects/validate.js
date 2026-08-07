// lambda/projects/validate.js — the clear:[] channel for the projects PUT. BUG-COALESCECLEAR-001.
//
// Textual mirror of lambda/plants/validate.js, lambda/varieties/validate.js and
// lambda/events/clearFields.js — deliberately a COPY, not an import: each Lambda zips from its own
// directory, so a '../plants/validate.js' import resolves under vitest (which inlines and dedupes)
// and then 502s at module load in the deployed function.
//
// THE CLASS: `COALESCE(${body.x ?? null}, x)` makes a column WRITE-ONCE-SETTABLE. `null` and
// `absent` are the same token on the wire, so once the column holds a value no request body returns
// it to NULL. The projects PUT carries 8 such arms. This names the 5 that may be cleared.
//
// Triaged against LIVE PROD schema (information_schema + pg_constraint) and the care engine, not
// against migration files. Live counts below were measured 2026-08-07 over 74 projects.

export const CLEARABLE_FIELDS = [
  // free text; the only consumer is searchProjects' LEFT(COALESCE(description,''),160) snippet and
  // an OR'd ILIKE arm, both NULL-safe. 5 of 74 populated.
  'description',
  // display + search only. NOT the care engine's variety — that is pv.name from plant_varieties
  // (daily-plan/handler.js), a different column on a different table. 3 of 74 populated.
  'variety',
  // 25 of 74 are ALREADY NULL, so NULL is a proven-live state. No filter, ordering or date math
  // reads it; both render sites are null-guarded.
  'start_date',
  // ZERO of 74 have ever held a value, yet the PUT can set it — a live one-way door. Written by
  // ProjectNew, read back by every GET, branched on by nothing in lambda/ or src/.
  'target_end_date',
  // THE ONE THAT CHANGED VERDICT. Excluded on first triage because the daily-plan query joins
  //   left join locations l on l.id = coalesce(p.location_id, pj.location_id)
  // and the OLD coverage derivation was coalesce(<predicate>, false) — so clearing a project's
  // location made `l` NULL for any planting without its own, collapsing it to covered=false =
  // OUTDOOR: rain credit on an indoor plant, and dropped from the frost pass. That is
  // BUG-NOLOCOUTDOOR-001, and it is FIXED (same session, dev 3c9d84b): coverage is now a
  // three-state and an absent location resolves to UNKNOWN, which fails safe in BOTH directions
  // (never rain-credited, still frost-alerted). The blocking reason is gone, so the column is
  // clearable. Sequencing was the whole point — this entry would have been a live care regression
  // had it landed first. 67 of 74 populated, ON DELETE SET NULL, no CHECK.
  'location_id',
];

// ─── DELIBERATELY EXCLUDED, each for its own reason ──────────────────────────────────────────────
//   name              NOT NULL on plant_projects (written through the container view as
//                     display_name). A hard 23502, and the identity every project card, picker and
//                     the unauthenticated /garden/:slug share route renders. Blanking it is refused
//                     separately by BUG-BLANKNAME-001's guard in index.js — that guard is about ''
//                     and this list is about NULL; both doors need closing.
//   status            NOT NULL, DEFAULT 'planning', and plant_projects_status_check is VALIDATED.
//                     It also carries the plants Tier-2 audit hole verbatim: index.js computes
//                     `_newStatus = body.status != null ? body.status : _oldStatus`, so a CLEAR
//                     would read as no-change and silently skip the in-txn status_change audit
//                     event and the entity_memory touch. Same call as plants' `status` exclusion.
//   is_public         NOT NULL boolean. "Clearing" it means false — a plain boolean write, already
//                     served by the existing COALESCE arm. Not a clear.
//   kind,             Already CASE-clearable via their own hasOwnProperty sentinels in index.js.
//   featured_photo_id Adding them here would give one column two clear channels with two
//   parent_project_id validators. Do not fold them in.
//   assignee_user_id
//   created_by        Guarded by the ownership-transfer trigger, which raises on ANY
//                     IS DISTINCT FROM change including value->NULL. Must never be listed.
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
