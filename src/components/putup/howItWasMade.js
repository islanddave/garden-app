// src/components/putup/howItWasMade.js
// B′ release 3 — "How it was made →" (V4 §2.2), the PURE half. The sheet is HowItWasMadeSheet.jsx.
//
// From a jar row: the Start-a-batch sheet in retrospective posture. Label = the jar's name; start = the
// jar's date; What went in open; "Which jars came from this?" chips of other jars at the same place with
// no batch (this jar preselected); "How many did you make?" (optional; raises the made count, never what
// is left); "Like <batch>, except…". One write: POST /api/kitchen-batches/from-jars.
//
// PURE: no React, no fetch, no clock.
import { shortDay } from './jarWords.js'

export const FROM_JARS_PATH = '/api/kitchen-batches/from-jars'
export const HOW_IT_WAS_MADE_LABEL = 'How it was made →'

// A jar can say how it was made only when it has no batch yet and did not come straight from one pick
// (chk_preservation_log_one_provenance: a batch OR one harvest, never both).
export const canSayHowItWasMade = (jar) => !!jar && jar.id != null && jar.batch_id == null && jar.harvest_log_id == null
  && jar.deleted_at == null

// The Pantry list's row (GET /api/pantry, the pinned cross-lane Row) → the jar shape this sheet reads. A
// shipped jar record passes through unchanged. Only a put-up can say how it was made; a bought item cannot.
export function jarOf(row) {
  if (!row) return null
  if (row.stock_kind == null) return row
  if (row.stock_kind !== 'put_up') return null
  return {
    id: row.stock_id, label: row.name ?? null, batch_id: row.batch_id ?? null, harvest_log_id: null,
    storage_location_id: row.place?.id ?? null, stock_mode: row.stock_mode === 'weighed' ? 'weighed' : 'counted',
    crop_type_slug: row.crop_type_slug ?? null,
  }
}

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

// One stored line as it is read. The row sheet writes a jar's note as "Next time (2026-09-02): <text>";
// on a page that is "Next time: <text> · Sep 2" — with ", 2025" after the day only when it is not this
// year (jarWords.shortDay, the day a lid is labelled with). The day is built from its three parts:
// `new Date('2026-09-02')` is UTC and lands on the 1st west of Greenwich. Any other string — no date,
// another shape, a day the calendar does not have — comes back exactly as it was given. `now` is the
// caller's clock when it holds one (a Date).
const DATED_NEXT_TIME_RE = /^Next time \((\d{4})-(\d{2})-(\d{2})\):\s+(\S.*)$/
export function nextTimeWords(line, now = new Date()) {
  const m = typeof line === 'string' ? DATED_NEXT_TIME_RE.exec(line) : null
  if (!m) return line
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  const day = new Date(y, mo - 1, d)
  if (day.getFullYear() !== y || day.getMonth() !== mo - 1 || day.getDate() !== d) return line
  return `Next time: ${m[4]} · ${shortDay(day, now)}`
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
