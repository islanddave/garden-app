import React, { useState, useEffect, useId } from 'react'
import { P } from '../lib/constants.js'
import { readDraft, writeDraft, clearDraft } from '../lib/draftStash.js'
import { useReportOverlayDirty } from '../context/OverlayContext.jsx'
import { setReloadBlocked } from '../lib/reloadGate.js'

// V4-DIRTYGUARDSWEEP-001 — draft-stash route key (siblings: 'logone', 'logmany').
const DRAFT_KEY = 'fieldnote'

/**
 * src/components/TapCaptureFallback.jsx
 *
 * Bite 3 of Post-V2 UX overhaul Increment 2: Field capture surface MVP.
 *
 * Tap-to-type fallback for the Field capture surface. Used when the user
 * either cannot use the mic (no permission, no mic, silent failure) OR
 * prefers to type. Bite 6 (Rung-1 handoff) will route the typed content
 * through the same Garden Helper prompt assembly as the transcribed
 * captures, so this fallback IS the Rung-1 happy path for non-mic users.
 *
 * Surface only — no DB writes, no Lambda. Submitting calls `onSubmit(text)`
 * and clears the textarea. The parent (FieldCapture) decides what to do
 * with the text (Bite 3: push onto an in-memory stub queue; Bite 6: pipe
 * to helperPrompt.js).
 *
 * Props:
 *   - onSubmit: (text: string) => void
 *
 * Operational surface — not a reward. No celebration on submit, no streak,
 * no badge. The "Saved to queue" inline confirmation is functional ACK
 * (per CLAUDE.md Reward UX §interrupt-exception: functional confirmation
 * after a user-initiated action, not a celebration).
 */
export default function TapCaptureFallback({ onSubmit }) {
  const [text, setText] = useState('')
  const [justSubmitted, setJustSubmitted] = useState(false)

  // V4-DIRTYGUARDSWEEP-001 — the dirty-guard contract lives HERE rather than on FieldCapture, which
  // holds no user-authored state of its own: its queue is already durable in IndexedDB and the rest
  // (depth, expandedId, tileSend) is view state. This textarea is the one place on that surface
  // where typed content exists with no other home until Save to queue. Wiring the page instead would
  // have meant inventing an onDirty prop and mirroring this string into a second copy upstream.
  useEffect(() => {
    const draft = readDraft(DRAFT_KEY)
    if (typeof draft?.text === 'string') setText(draft.text)
  }, [])

  // STASH predicate — BROAD: any non-empty value, whitespace included. Over-capturing costs nothing,
  // and a leading space is still a keystroke the user made.
  useEffect(() => {
    if (text !== '') writeDraft(DRAFT_KEY, { text })
  }, [text])

  // GUARD predicate — SEPARATE and narrower by exactly one step: trimmed. A stray space must not
  // hold a service-worker update or deaden a sheet backdrop; the stash above is already keeping it.
  const hasUnsavedInput = text.trim() !== ''

  useReportOverlayDirty(hasUnsavedInput)

  // /field-capture is not an overlayable route today, so the hook above is a strict no-op and the
  // reload gate below is what actually protects this textarea. Per-instance key + BOOLEAN dep for
  // the reasons EventNew.jsx:933-941 records.
  const reloadGateKey = `field-note:${useId()}`
  useEffect(() => {
    setReloadBlocked(reloadGateKey, hasUnsavedInput)
    return () => setReloadBlocked(reloadGateKey, false)
  }, [reloadGateKey, hasUnsavedInput])

  function handleSubmit(e) {
    if (e && e.preventDefault) e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed) return
    onSubmit && onSubmit(trimmed)
    setText('')
    clearDraft(DRAFT_KEY)   // the note is on the queue — the working draft is spent
    setJustSubmitted(true)
    // Inline ACK auto-clears after a short window. Not a celebration —
    // a functional confirmation that the queue accepted the entry.
    setTimeout(() => setJustSubmitted(false), 1500)
  }

  return (
    <form
      data-testid="tap-capture-fallback"
      onSubmit={handleSubmit}
      style={{
        width: '100%',
        maxWidth: 480,
        margin: '0 auto',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      <label
        htmlFor="tap-capture-textarea"
        style={{
          fontSize: '0.92rem', fontWeight: 600, color: P.dark,
        }}
      >
        Or type a note
      </label>
      <textarea
        id="tap-capture-textarea"
        data-testid="tap-capture-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What did you see, do, or wonder about?"
        rows={3}
        style={{
          width: '100%', boxSizing: 'border-box',
          padding: 12, fontSize: '1rem',
          border: `1px solid ${P.border}`, borderRadius: 8,
          fontFamily: 'inherit', resize: 'vertical',
          minHeight: 80,
        }}
      />
      <button
        type="submit"
        data-testid="tap-capture-submit"
        disabled={!text.trim()}
        style={{
          alignSelf: 'flex-end',
          minHeight: 44, minWidth: 120,
          padding: '10px 20px',
          borderRadius: 8, border: 'none',
          background: text.trim() ? P.green : P.light,
          color: P.white, fontWeight: 700, fontSize: '0.95rem',
          cursor: text.trim() ? 'pointer' : 'not-allowed',
          fontFamily: 'inherit',
        }}
      >
        Save to queue
      </button>
      {justSubmitted && (
        <div
          data-testid="tap-capture-ack"
          role="status"
          style={{
            fontSize: '0.85rem', color: P.green, fontWeight: 600,
          }}
        >
          Saved to queue.
        </div>
      )}
    </form>
  )
}
