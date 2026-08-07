// BUG-COALESCECLEAR-001 — the client half of the clear:[] channel.
//
// The server-side channel is inert without this. A PUT that binds a column as
// `COALESCE(${body.x ?? null}, x)` treats null and absent identically, so a form that sends
// `description: form.description.trim() || null` for an emptied box gets a 200 and no change. Every
// edit form in this app sends exactly that. `clear: ['description']` is the only way to say NULL.
//
// THE SAFETY RULE, and it is the whole reason this is a helper rather than a literal per form:
//
//     a key enters `clear` ONLY when the form actually RENDERS it, AND the saved row held a value,
//     AND the form is now empty.
//
// Never merely because a key is absent from form state. A form that renders six of a table's
// thirty columns must not be able to NULL the other twenty-four — that is the mirror image of the
// bug being fixed, and it is a worse one, because it destroys data instead of silently keeping it.
// Derived from the pattern EventDetail.jsx established for BUG-EVENTEDITFIELDS-001; factored out
// here when projects and locations needed the same rule (2026-08-07).
//
// The `fields` argument IS the render manifest: pass the keys the form has inputs for, and nothing
// else. Driving clear off the same list the form renders from is what keeps the two in step — the
// varieties editor avoids this whole class by driving render/seed/patch off one table.

// True when a form value counts as "the user emptied this box".
// Deliberately narrow: '' and whitespace only. `0` and `false` are VALUES, not emptiness, and a
// `!value` test would wrongly clear a sort_order of 0 or an is_public of false.
export function isBlank(v) {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  return false;
}

/**
 * Build the `clear` array for a PUT body.
 *
 * @param {string[]} fields  keys this form RENDERS an input for. The manifest — not every key of
 *                           the row, and not every key of form state.
 * @param {object}   form    current form state.
 * @param {object}   saved   the row as last loaded from the server.
 * @param {object} [opts]
 * @param {string[]} [opts.allowed]  optional server allowlist. When supplied, a key not on it is
 *                                   dropped rather than sent — the server would 400 the whole
 *                                   request, losing the user's other edits with it.
 * @returns {string[]} keys to clear; empty when there is nothing to clear.
 */
export function buildClearKeys(fields, form, saved, opts = {}) {
  if (!Array.isArray(fields) || !form || !saved) return [];
  const allowed = Array.isArray(opts.allowed) ? new Set(opts.allowed) : null;
  const out = [];
  for (const k of fields) {
    if (allowed && !allowed.has(k)) continue;
    // held a value before AND is empty now. Both halves are required: without the first, a field
    // that was already NULL would be pointlessly re-cleared on every save; without the second, an
    // untouched field would be cleared.
    if (saved[k] != null && isBlank(form[k])) out.push(k);
  }
  return out;
}

/**
 * Spread-ready: `...clearPatch(fields, form, saved)` adds `clear` only when non-empty, so a save
 * with nothing to clear is byte-identical to one from before this channel existed. That
 * byte-identity is what lets this ship without re-testing every existing save path.
 */
export function clearPatch(fields, form, saved, opts = {}) {
  const keys = buildClearKeys(fields, form, saved, opts);
  return keys.length ? { clear: keys } : {};
}

// The server allowlists, mirrored. Kept here so a form can drop an un-clearable key BEFORE the
// request rather than have the server 400 the whole save — a user emptying a box the server refuses
// to clear should still get their other edits saved, and should not see an error naming a column.
//
// These MUST match lambda/<handler>/validate.js. src/__tests__/clearKeys.test.js reads those files
// from disk and asserts equality, so a drift here reds rather than silently sending a key the
// server will reject.
export const SERVER_CLEARABLE = {
  projects: ['description', 'variety', 'start_date', 'target_end_date', 'location_id'],
  locations: ['description'],
};
