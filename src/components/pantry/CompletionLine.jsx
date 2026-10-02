// src/components/pantry/CompletionLine.jsx
// Put-Up R2a (prep) — moved here from PantryView.jsx, unchanged, so a second host (the planting page) can
// draw the same line the Pantry draws. Props: { completion: { route, saved, place, text }, fetch, onDone,
// onChanged, onHowItWasMade?, canHowItWasMade? }.
//
// THE RELOAD HOLD (Put-Up R2a, lane P). The door holds the page's reload while it is dirty and lets go when
// it closes on Save — the same moment this line appears. A deploy that landed during that save was only
// waiting for the last hold to clear, so the page reloaded within a frame and the row was in the list with
// no line and no Undo. The line now holds the reload itself (lib/reloadGate.js, one key per mounted line):
// while it is on screen and not undone. It lets go when it goes (closed, or its host unmounts), when its
// Undo lands (nothing is left to lose), and whenever the page is hidden — a line has no timer, so a phone
// put down with it showing must not park an update for good; back on screen, it holds again. Made HERE,
// not in a host, so every host that draws the line has it.
import React, { useEffect, useId, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { deletePantryItem } from '../../lib/pantryApi.js'
import { setReloadBlocked } from '../../lib/reloadGate.js'
import RefusalLine, { refusalOf } from './RefusalLine.jsx'

// The door's completion, in place on the Pantry (V4 §2.2): what was saved, in the server's words, with
// Undo (a soft delete of what was just made) and — for a put-up — How it was made → when wired.
export default function CompletionLine({ completion, fetch, onDone, onChanged, onHowItWasMade, canHowItWasMade }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [undone, setUndone] = useState(false)
  const gateKey = `pantry-completion:${useId()}`
  useEffect(() => {
    if (undone) return undefined
    // Set from the event itself, not through a render: a hidden page may not paint for a long time.
    const sync = () => setReloadBlocked(gateKey, document.visibilityState !== 'hidden')
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      setReloadBlocked(gateKey, false)
    }
  }, [gateKey, undone])
  const id = completion.saved?.id
  async function undo() {
    if (busy || id == null) return
    setBusy(true); setErr(null)
    try {
      if (completion.route === 'item') await deletePantryItem(fetch, id)
      else await fetch(`/api/preservation/${encodeURIComponent(id)}`, { method: 'DELETE' })
      setUndone(true)
      onChanged?.()
    } catch (e) {
      setErr(refusalOf(e, "Couldn't undo that — try again."))
    } finally { setBusy(false) }
  }
  const asRow = completion.route === 'jar' && completion.saved
    ? { stock_kind: 'put_up', stock_id: completion.saved.id, name: completion.saved.label ?? completion.text, batch_id: completion.saved.batch_id ?? null,
      place: completion.place ?? null }
    : null
  return (
    <div role="status" data-testid="pantry-completion" style={{ marginBottom: T.space.md, padding: '6px 8px 6px 12px',
      background: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: T.radiusButton }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 160, fontSize: T.type.sm, color: undone ? P.mid : P.green }}>
          {undone ? `Undone — ${completion.text}` : completion.text}
        </span>
        {!undone && id != null && (
          <button type="button" onClick={undo} disabled={busy} data-testid="pantry-completion-undo" aria-label="Undo — what you just put up"
            style={{ minHeight: 48, minWidth: 48, background: 'none', border: 'none', color: P.terra, fontWeight: 700,
              fontFamily: 'inherit', fontSize: T.type.sm, textDecoration: 'underline', cursor: 'pointer' }}>Undo</button>
        )}
        {!undone && asRow && typeof onHowItWasMade === 'function' && (typeof canHowItWasMade !== 'function' || canHowItWasMade(asRow)) && (
          <button type="button" onClick={() => onHowItWasMade(asRow)} data-testid="pantry-completion-how"
            style={{ minHeight: 48, background: 'none', border: 'none', color: P.green, fontWeight: 700,
              fontFamily: 'inherit', fontSize: T.type.sm, textDecoration: 'underline', cursor: 'pointer' }}>How it was made →</button>
        )}
        <button type="button" onClick={onDone} data-testid="pantry-completion-close" aria-label="Close — the saved line"
          style={{ minHeight: 48, minWidth: 48, background: 'none', border: 'none', color: P.mid, cursor: 'pointer', fontSize: '1.1rem' }}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <RefusalLine err={err} testId="pantry-completion-error" />
    </div>
  )
}
