// lambda/events/clearFields.js — the clear:[] channel for the events PUT.
// BUG-EVENTEDITFIELDS-001. Textual mirror of lambda/plants/validate.js and
// lambda/varieties/validate.js — deliberately a COPY, not an import: each Lambda zips from its own
// directory, so a '../plants/validate.js' import resolves under vitest (which inlines and dedupes)
// and then 502s at module load in the deployed function.
//
// WHY THIS FILE EXISTS AT ALL, given the events PUT does NOT use COALESCE on its existing columns:
// title/notes/private_notes/quantity are bound FULL-REPLACE (`${body.title ?? null}`), documented
// at index.js as "an omitted key means cleared". That grammar is survivable for four fields that
// every caller always sends — EventDetail is the only PUT caller in the whole client. It is NOT
// survivable for the columns this ticket adds:
//
//   * flagged_as_issue is NOT NULL. A stale cached bundle that PUTs without it would write false,
//     and no CHECK would stop it — silently unflagging all 72 flagged rows on prod, one save at a
//     time, with Findings quietly emptying.
//   * the 5 treatment columns are not returned by the GET today (fixed in this same change), so
//     under full-replace a form round-trip would blank all five before anyone could see them.
//
// This is a PWA with a service worker; a stale bundle is the normal case after a deploy, not an
// edge case. So the new columns get preserve-on-absent + an explicit clear channel, and the old
// four keep their existing grammar rather than being migrated in a bug-fix commit.

// The columns a PUT may explicitly set back to NULL via `body.clear`.
export const CLEARABLE_FIELDS = [
  'severity',
  'treatment_product_id', 'treatment_product_text', 'treatment_category',
  'treatment_amount', 'pest_target',
];

// ─── DELIBERATELY EXCLUDED, each for its own reason ──────────────────────────────────────────────
//   project_id        THE INNER-JOIN TRAP. The PUT's ownership SELECT, the PUT's UPDATE and the
//                     DELETE route all `JOIN public.container pp ON pp.id = el.project_id`. An
//                     event with a NULL project_id is unreachable by every one of them — a
//                     permanently un-editable, un-deletable row with no in-app recovery. Zero of
//                     12,580 live events have a NULL project_id, so nothing regresses by refusing
//                     it. project_id may be CHANGED (slice 3), never CLEARED.
//   plant_id          Clearing it is better expressed as re-anchoring to the project; clearing it
//                     while project_id is also absent violates event_log_has_anchor.
//   location_id       Not an arm of event_log_has_anchor (that CHECK admits plant-or-project only;
//                     widening it is V4-EVENTANCHOR-001, still planned and blocked). Companion
//                     field only — it arrives with slice 3, not here.
//   flagged_as_issue  NOT NULL. "Clearing" it means false, which is a plain boolean write, not a
//                     clear. It is resolved in JS and bound directly.
//   event_type,       NOT NULL.
//   event_date,
//   is_public
//   resolved_at,      Owned by the PATCH resolve route, not by this edit form.
//   resolved_by
//   metadata,         No edit surface owns them.
//   quantity_numeric,
//   source
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

// Resolve the flagged/severity pair for a PARTIAL update, then validate it.
//
// The PUT is partial and the POST is not, so the POST's one-liner
// (`const severity = flagged ? body.severity : null`) is not enough here: an edit that touches only
// the notes must preserve both, and an edit that unflags must clear the severity IN THE SAME
// STATEMENT. chk_event_log_severity_requires_flag is VALIDATED, so writing flagged=false beside a
// surviving severity is a hard 23514 — which, inside sql.transaction, aborts the whole transaction
// and lands in the generic catch as an opaque 500. Resolving in JS and validating before the write
// is what keeps that a 400 with a message.
//
// Returns { flagged, severity, error }. `error` is a string when the resolved pair is invalid.
export function resolveFlagPair(body, existing, clear = []) {
  const cleared = clear.includes('severity');
  const flagged = body.flagged_as_issue != null
    ? body.flagged_as_issue === true
    : existing?.flagged_as_issue === true;

  // Un-flagging clears the severity rather than 400-ing: the pair is one concept, and refusing a
  // request that is unambiguous about intent would be user-hostile. The POST takes the same view.
  let severity = null;
  if (flagged) {
    severity = cleared ? null : (body.severity ?? existing?.severity ?? null);
  }

  if (severity != null && ![1, 2, 3].includes(severity)) {
    return { error: 'severity must be 1, 2, or 3' };
  }
  if (flagged && severity == null) {
    // Covers both the plain missing case and the clear-while-still-flagged case. The DB would NOT
    // catch this — CHECK (flagged = true OR severity IS NULL) permits flagged=true with a NULL
    // severity — so a flagged issue would silently lose its urgency. Only this check stops it.
    return { error: 'severity required when flagged_as_issue=true' };
  }
  if (!flagged && body.severity != null) {
    return { error: 'severity requires flagged_as_issue=true' };
  }
  return { flagged, severity };
}
