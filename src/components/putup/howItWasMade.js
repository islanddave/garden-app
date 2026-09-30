// src/components/putup/howItWasMade.js
// B′ release 3 — "How it was made →" (V4 §2.2), the PURE half. The sheet is HowItWasMadeSheet.jsx.
//
// From a jar row: the Start-a-batch sheet in retrospective posture. Label = the jar's name; start = the
// jar's date; What went in open; "Which jars came from this?" chips of other jars at the same place with
// no batch (this jar preselected); "How many did you make?" (optional; raises the made count, never what
// is left); "Like <batch>, except…". One write: POST /api/kitchen-batches/from-jars.
//
// PURE: no React, no fetch, no clock.

export const FROM_JARS_PATH = '/api/kitchen-batches/from-jars'
export const HOW_IT_WAS_MADE_LABEL = 'How it was made →'

// A jar can say how it was made only when it has no batch yet and did not come straight from one pick
// (chk_preservation_log_one_provenance: a batch OR one harvest, never both).
export const canSayHowItWasMade = (jar) => !!jar && jar.id != null && jar.batch_id == null && jar.harvest_log_id == null
  && jar.deleted_at == null

// The name the sheet opens with: the jar's own name, else what it is.
export function jarName(jar) {
  const label = String(jar?.label ?? '').trim()
  if (label) return label
  const crop = String(jar?.crop_type_slug ?? '').trim()
  return crop ? crop.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : ''
}

// The jar's date as a batch start — the server's mapping, mirrored (batchBuilder.js jarStageDate): a
// floor ('after') or a logged-day ('unknown') is not a start anyone knows, so it is Not sure; a pre-1b
// date is a day unless it was marked approximate.
export function jarStart(jar) {
  const day = jar?.preserved_at ? String(jar.preserved_at).slice(0, 10) : null
  const p = jar?.preserved_at_precision ?? null
  if (!day || p === 'after' || p === 'unknown' || (p == null && jar.preserved_at_approx === true)) {
    return { date: null, precision: 'unknown' }
  }
  return { date: day, precision: p ?? 'day' }
}

// "Which jars came from this?" — the other jars at the same place with no batch, the door's jar first.
export function candidateJars(rows, jar) {
  if (!jar) return []
  const others = (rows ?? []).filter(r => r && r.id !== jar.id && canSayHowItWasMade(r)
    && (r.storage_location_id ?? null) === (jar.storage_location_id ?? null))
  return [jar, ...others]
}

// "How many did you make?" is asked only for one counted jar (a weighed bag has no count to raise).
export const asksMadeCount = (jars) => Array.isArray(jars) && jars.length === 1 && jars[0]?.stock_mode !== 'weighed'

// The "Next time…" lines in a jar's notes — the ones the write copies into the batch (mirrors the server).
export const NEXT_TIME_RE = /\bnext time\b/i
export function nextTimeLines(notes) {
  if (notes == null) return []
  const out = []
  for (const raw of String(notes).split(/\r?\n/)) {
    const line = raw.trim()
    if (line && NEXT_TIME_RE.test(line) && !out.includes(line)) out.push(line)
  }
  return out
}

// SheetStartChips' answer (resolveSheetStart) → the route's `started` shape.
export function startedOf(resolved) {
  if (!resolved?.start) return null
  const { started_at: at, start_precision: precision } = resolved.start
  return precision === 'unknown' ? { date: null, precision } : { date: at, precision }
}

export const FROM_JARS_ERRORS = Object.freeze({
  label: 'Give it a name first.',
  jars: 'Pick at least one jar that came from this.',
  made: 'How many — a whole number, 1 or more.',
})

// { body } or { error, field }. Only what the sheet answered is sent.
export function fromJarsBody({ key, label, started, kind = null, lines = [], jarIds = [], madeCount = '', nextTime = '' } = {}) {
  const name = String(label ?? '').trim()
  if (!name) return { error: FROM_JARS_ERRORS.label, field: 'label' }
  const ids = [...new Set((jarIds ?? []).filter(Boolean))]
  if (!ids.length) return { error: FROM_JARS_ERRORS.jars, field: 'jars' }
  const body = { idempotency_key: key, label: name.slice(0, 120), started: started ?? { date: null, precision: 'unknown' }, jar_ids: ids }
  if (kind) body.kind = kind
  if (lines.length) body.inputs = lines
  const made = String(madeCount ?? '').trim()
  if (made) {
    const n = Number(made)
    if (!Number.isInteger(n) || n < 1) return { error: FROM_JARS_ERRORS.made, field: 'made' }
    if (ids.length === 1) body.made_count = n
  }
  const nt = String(nextTime ?? '').trim()
  if (nt) body.next_time = nt
  return { body }
}

// The refusal a failed write shows, in plain words (the route's own `error` where it has one).
export function fromJarsRefusal(err) {
  const code = err?.body?.code
  if (code === 'jar_has_batch') return 'One of those already has a batch — open it there.'
  if (code === 'only_n_left' || code === 'only_g_left') return err.body.error
  if (err?.status === 0) return "Couldn't save just now — what you entered is still here."
  return err?.body?.error ?? err?.message ?? "Couldn't save — try again."
}
