// src/components/putup/likeBatch.js
// B′ release 3 — "Like <batch>, except…" (V4 §2.2, Appendix C step 6), the PURE half.
//
// THE MECHANISM (the plainest one consistent with F's line routes): read the chosen past batch through
// the shipped GET /api/kitchen-batches/:id, and copy its What-went-in lines — and its kind — into the new
// draft as ordinary keyed line BODIES. Nothing new on the server: Start a batch posts them to
// POST /:id/inputs (the keyed form) right after the create; How it was made → sends them as its
// `inputs`. Each copied line is then an ordinary line of the new batch, edited or taken out as usual.
//
// What is copied, per line:
//   · a planting (garden) line → the same planting;
//   · a pick line → that planting, without the pick (last season's pick is not this batch's);
//   · a draw from a put-up, or a bought pantry item → a typed line with its name (that jar may be gone or
//     empty; draw again from what is there now);
//   · typed lines, salt and water → as they were, the salt facts included (the aimed % and its base).
// Amounts, forms, brands, notes and listed heat come along. A bottling's own additions (lines with a
// put_up_stage_id) are not What went in and are left behind.
//
// PURE: no React, no fetch, no clock. `mint` is the caller's key minter.

const COPY_KEYS = ['qty', 'qty_unit', 'form', 'brand', 'note', 'source_label', 'shu_rating_low', 'shu_rating_high']
const SALT_KEYS = ['salt_pct', 'salt_base', 'base_g', 'salt_method', 'base_from']

const text = (v) => { const s = String(v ?? '').trim(); return s || null }

export function likeLine(line, mint) {
  if (!line || line.deleted_at != null || line.put_up_stage_id != null) return null
  const label = text(line.label)
  const out = { idempotency_key: mint() }
  if ((line.input_kind === 'garden' || line.input_kind === 'harvest') && line.plant_id) {
    out.input_kind = 'garden'
    out.plant_id = line.plant_id
    if (label) out.label = label
  } else {
    if (!label) return null
    out.input_kind = line.input_kind === 'purchased' ? 'purchased' : 'other'
    out.label = label
    if (line.role === 'salt' || line.role === 'water') out.role = line.role
  }
  if (text(line.crop_type_slug)) out.crop_type_slug = line.crop_type_slug
  for (const k of COPY_KEYS) if (line[k] != null && line[k] !== '') out[k] = line[k]
  if (out.qty != null) out.qty = String(out.qty)
  if (out.role) { delete out.form; delete out.shu_rating_low; delete out.shu_rating_high }
  if (out.role === 'salt') for (const k of SALT_KEYS) if (line[k] != null) out[k] = typeof line[k] === 'number' ? String(line[k]) : line[k]
  // A 1b-era 'peppers' base is not a word the F client writes (06 §3.1): the facts go, the grams stay.
  if (out.salt_base === 'peppers') for (const k of SALT_KEYS) delete out[k]
  if (line.ordinal != null) out.ordinal = Number(line.ordinal)
  return out
}

// The new draft's lines and kind from a past batch's detail (GET /:id).
export function likeDraft(detail, mint) {
  const lines = (detail?.inputs ?? []).map(l => likeLine(l, mint)).filter(Boolean)
  lines.forEach((l, i) => { l.ordinal = i })
  return { kind: detail?.kind ?? null, lines, from: detail ? { id: detail.id, label: detail.label ?? '' } : null }
}

export const likeWords = (from, n) => (from
  ? `Like ${from.label || 'that batch'}, except… · ${n} ${n === 1 ? 'thing' : 'things'} copied in`
  : '')

// Past batches offered, newest first, closed or going — never the batch being made.
export function likeChoices(batches, exceptId = null) {
  return (batches ?? []).filter(b => b && b.id !== exceptId && String(b.label ?? '').trim())
}
