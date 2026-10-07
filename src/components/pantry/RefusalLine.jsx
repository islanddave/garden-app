// src/components/pantry/RefusalLine.jsx
// V4 §6.5 "409 handling" for every B′ write: the server's words by `code` (putUpErrors.describeRefusal),
// an uncoded 4xx in the server's own sentence, anything else (offline, a timeout, a 500) in the caller's
// copy — and, for client_stale only, a user-tapped "Refresh now" (useAppUpdate().apply()), never an
// automatic reload. Mounted only while a refusal is on screen, so the update hook costs nothing otherwise.
import React from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { describeRefusal, REFRESH_NOW_LABEL } from '../../lib/putUpErrors.js'
import { useAppUpdate } from '../../hooks/useAppUpdate.js'

// err → { text, refresh }. `fallback` is the caller's own copy.
export function refusalOf(e, fallback) {
  const coded = describeRefusal(e)
  if (coded) return { text: coded.text, refresh: !!coded.refresh }
  const status = e?.status
  const said = typeof e?.body?.error === 'string' ? e.body.error.trim() : ''
  if (said && typeof status === 'number' && status >= 400 && status < 500) return { text: said, refresh: false }
  return { text: fallback, refresh: false }
}

export function refusalText(e, fallback) {
  return refusalOf(e, fallback).text
}

function RefreshNow() {
  const { apply } = useAppUpdate()
  return (
    <button type="button" onClick={() => apply()} data-testid="putup-refresh-now"
      style={{ display: 'inline-flex', alignItems: 'center', minHeight: 48, marginTop: 6, padding: '6px 14px', background: 'none',
        border: `1px solid ${P.greenLight}`, borderRadius: T.radiusButton, color: P.green, fontSize: T.type.sm, fontWeight: 700,
        fontFamily: 'inherit', cursor: 'pointer' }}>
      {REFRESH_NOW_LABEL}
    </button>
  )
}

// `err` is a string or a { text, refresh } from refusalOf. `lineRef` (optional) is the caller's handle on the
// line, for bringing it into view.
export default function RefusalLine({ err, testId, style, lineRef = null }) {
  if (!err) return null
  const r = typeof err === 'string' ? { text: err, refresh: false } : err
  return (
    <div ref={lineRef} style={style}>
      <div role="alert" data-testid={testId} style={{ color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>{r.text}</div>
      {r.refresh && <RefreshNow />}
    </div>
  )
}
