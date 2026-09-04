// src/components/putup/JarPicker.jsx
// V5-KBCLOSE-001 — picking which jars came out of a batch.
//
// ⚠ use_by_status AND use_by_target ARE SUPPRESSED ON THIS SURFACE, DELIBERATELY.
// The shipped put-up row renders a warn-coloured "Use soon" / "Past use-by" chip plus "· use by
// {date}", computed server-side from a per-method constant. Each half was individually adjudicated
// as acceptable where it ships. Composed HERE — beside an outcome choice, on one 390px surface — the
// pair becomes a shelf-stability endorsement, which is a claim the app does not make. The projection
// below is IDENTITY ONLY, and a test asserts none of "Use soon" / "Past use-by" / "use by" reaches
// this DOM. If you add a field here, check it against FOODSAFETY-RULING-V101 first.
//
// INELIGIBLE JARS ARE DISABLED WITH THE REASON INLINE, NEVER OMITTED. Absence is unattributable: a
// cook who logged jars through a harvest-prefill door would simply not see them, and NO shipped
// surface can relink a harvest-linked jar (batch_id is deliberately absent from
// PRESERVATION_EDITABLE_COLUMNS). A disabled row with a stated reason is diagnosable; a shorter list
// is not.
//
// SELECTION IS A `Set` OWNED BY THE CALLER, and every affordance below is derived from the RESOLVED
// rows rather than from the Set's `.size` — BUG-PHOTOSELSTALE-001, where a bar read `selected.size`
// while the button posted the resolved array and the two disagreed.
import React, { useCallback, useEffect, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { jarIsLinkable, jarBlockReason } from './batchClose.js'
import { useApiFetch } from '../../lib/api.js'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "Aug 12" from a DATE column, parsed as TEXT and never through `new Date(ymd)` — that parses as UTC
// midnight and renders the previous day everywhere west of Greenwich, which is both CI lanes' worst
// case and a shipped bug elsewhere in this app.
export function preservedOn(v) {
  if (!v) return null
  const s = typeof v === 'string' ? v : (v instanceof Date ? v.toISOString() : String(v))
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  const month = MONTHS[Number(m[2]) - 1]
  return month ? `${month} ${Number(m[3])}` : null
}

// Identity, in the order a cook reads a shelf: what it is, how much, when it was put up. No method
// label: the vocabulary is hand-maintained in four places already and putUpMethodParity.test.js
// enumerates those four by path, so a fifth copy here would drift unguarded.
export function jarIdentity(row) {
  const parts = []
  if (row.crop_label) parts.push(row.crop_label)
  if (row.quantity_value != null && row.quantity_unit) parts.push(`${row.quantity_value} ${row.quantity_unit}`)
  const on = preservedOn(row.preserved_at)
  if (on) parts.push(on)
  return parts.join(' · ')
}

// whats-put-up answers `{ group_by, groups: [{ label, records: [...] }] }`. The group label is the
// only place the crop's display name appears — projectRow does not carry it — so it is stamped onto
// each row here rather than fetched a second time. Same defensive coercion the page's own loaders
// use: a shape this client does not recognise is an empty list, never a crash.
export function flattenJars(payload) {
  const groups = Array.isArray(payload?.groups) ? payload.groups : []
  const out = []
  for (const g of groups) {
    const records = Array.isArray(g?.records) ? g.records : []
    for (const r of records) {
      if (!r?.id) continue
      out.push({ ...r, crop_label: g.label ?? null })
    }
  }
  return out
}

export default function JarPicker({ batchId, selected, onToggle, disabledReasonFor }) {
  const { fetch } = useApiFetch()
  const [rows, setRows] = useState(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setFailed(false)
    fetch('/api/preservation/whats-put-up?group=crop')
      .then(payload => { setRows(flattenJars(payload)); setFailed(false) })
      .catch(() => { setFailed(true) })
      .finally(() => { setLoading(false) })
  }, [fetch])

  useEffect(() => { load() }, [load])

  const reasonFor = disabledReasonFor ?? (row => jarBlockReason(row, batchId))
  const list = rows ?? []
  // RESOLVED rows, not the id Set. The count line and the id list the caller posts must be the same
  // derivation or they disagree exactly when it matters.
  const chosen = list.filter(r => selected?.has(r.id))

  if (loading) {
    return (
      <div data-testid="jar-picker" style={{ marginTop: T.space.sm }}>
        <div data-testid="jar-picker-loading" style={{ color: P.light, fontSize: T.type.sm }}>Looking up your put-ups…</div>
      </div>
    )
  }

  if (failed) {
    return (
      <div data-testid="jar-picker" style={{ marginTop: T.space.sm }}>
        <div role="alert" data-testid="jar-picker-error" style={{ color: P.terra, fontSize: T.type.sm }}>
          Couldn’t load your put-ups.{' '}
          <button type="button" onClick={load} data-testid="jar-picker-retry"
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
              fontSize: T.type.sm, color: P.green, textDecoration: 'underline' }}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div data-testid="jar-picker" style={{ marginTop: T.space.sm }}>
      <div data-testid="jar-picker-count" style={{ color: P.mid, fontSize: T.type.sm, fontWeight: 600 }}>
        {chosen.length === 1 ? '1 put-up chosen' : `${chosen.length} put-ups chosen`}
      </div>
      {list.length === 0 ? (
        <div data-testid="jar-picker-empty" style={{ marginTop: 6, color: P.light, fontSize: T.type.sm }}>
          Nothing logged in your put-ups yet — you can link jars to this batch later.
        </div>
      ) : (
        <ul data-testid="jar-picker-list" style={{ listStyle: 'none', margin: '6px 0 0', padding: 0 }}>
          {list.map(row => {
            const linkable = jarIsLinkable(row)
            const reason = linkable ? null : reasonFor(row)
            const on = selected?.has(row.id) === true
            return (
              <li key={row.id} data-testid="jar-picker-row" data-jar-id={row.id}
                style={{ borderTop: `1px solid ${P.border}` }}>
                <button
                  type="button"
                  disabled={!linkable}
                  aria-pressed={linkable ? on : undefined}
                  onClick={() => onToggle?.(row.id, row)}
                  data-testid={`jar-picker-toggle-${row.id}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: T.space.sm, width: '100%',
                    minHeight: T.tapMinHeight, padding: '8px 2px', textAlign: 'left',
                    background: 'none', border: 'none', fontFamily: 'inherit', fontSize: T.type.sm,
                    color: linkable ? P.dark : P.light, opacity: linkable ? 1 : 0.6,
                    cursor: linkable ? 'pointer' : 'default',
                  }}>
                  <span aria-hidden="true" style={{ color: linkable && on ? P.green : P.border, fontWeight: 700 }}>
                    {linkable && on ? '☑' : '☐'}
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column' }}>
                    <span data-testid="jar-picker-identity">{jarIdentity(row)}</span>
                    {reason && (
                      <span data-testid="jar-picker-reason" style={{ color: P.light, fontSize: T.type.xs }}>{reason}</span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
