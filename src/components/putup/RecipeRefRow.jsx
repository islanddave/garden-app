// src/components/putup/RecipeRefRow.jsx
// Put-Up release F (06 §1.5; FOODSAFETY-RULING-V101 §3, approved there as record-and-prompt) — "Following
// a recipe?": one quiet row on every batch — a text or URL field (kitchen_batch.recipe_ref, ≤ 500) and,
// beneath it, the tested-recipe caution as REFERENCE CONTENT with a link-out. It is not a recipe
// library (that is release B′) and it makes no claim about the batch: it records what he is following
// and points at the published advice. Optional; required at open: 0 (the census).
import React, { useCallback, useId, useRef, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { describeRefusal } from '../../lib/putUpErrors.js'
import { inputChrome } from '../forms/formStyles.js'

export const RECIPE_QUESTION = 'Following a recipe?'
// V101 §3 quotes NCHFP: "Use only recipes with tested proportions of ingredients." Reference, linked.
export const TESTED_RECIPE_NOTE = 'Published home-preserving advice is to use recipes with tested proportions of ingredients.'
export const TESTED_RECIPE_LINK = 'https://nchfp.uga.edu/'
export const RECIPE_REF_MAX = 500

const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s ?? '').trim())
const link = {
  display: 'inline-flex', alignItems: 'center', minHeight: T.buttonMinHeight, minWidth: 44, background: 'none', border: 'none',
  padding: '2px 8px 2px 0', cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: '0.82rem', fontWeight: 600,
}

export default function RecipeRefRow({ batch, onChanged, disabled = false }) {
  const { fetch } = useApiFetch()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(batch.recipe_ref ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const writingRef = useRef(false)
  const id = `recipe-ref-${useId()}`
  const current = batch.recipe_ref ?? null

  const save = useCallback(async () => {
    if (writingRef.current) return
    const v = text.trim()
    if (v.length > RECIPE_REF_MAX) { setErr(`That is longer than ${RECIPE_REF_MAX} characters — shorten it, or paste the link.`); return }
    writingRef.current = true
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/kitchen-batches/${batch.id}`, { method: 'PUT', body: JSON.stringify({ recipe_ref: v || null }) })
      setOpen(false)
      onChanged?.()
    } catch (e) {
      setErr(describeRefusal(e)?.text ?? 'Couldn’t save that — try again.')
    } finally { writingRef.current = false; setBusy(false) }
  }, [batch.id, fetch, onChanged, text])

  return (
    <div data-testid="recipe-ref" style={{ marginTop: T.space.sm }}>
      {!open && (
        // 12px between the two targets: the second one opens a website in a new tab, and at 48px tall a
        // slip from the first would leave the app. The words are the ruled ones and do not change.
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          {current ? (
            <span data-testid="recipe-ref-current" style={{ color: P.mid, fontSize: '0.82rem' }}>
              Following: {isUrl(current)
                ? <a href={current} target="_blank" rel="noopener noreferrer" style={{ color: P.green }}>{current}</a>
                : current}
            </span>
          ) : null}
          <button type="button" style={link} data-testid="recipe-ref-open" disabled={disabled} onClick={() => { setText(current ?? ''); setOpen(true) }}>
            {current ? 'Change' : RECIPE_QUESTION}
          </button>
          {!current && (
            <a data-testid="recipe-ref-tested-link" href={TESTED_RECIPE_LINK} target="_blank" rel="noopener noreferrer"
              style={{ ...link, textDecoration: 'none', fontWeight: 400, color: P.mid }}>· tested recipes →</a>
          )}
        </div>
      )}
      {open && (
        <div data-testid="recipe-ref-editor">
          <label htmlFor={id} style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: P.mid, marginBottom: 4 }}>
            {RECIPE_QUESTION} <span style={{ fontWeight: 400, color: P.light }}>optional — a name, a book, or a link</span>
          </label>
          <input id={id} data-testid="recipe-ref-input" type="text" value={text} maxLength={RECIPE_REF_MAX} disabled={busy}
            onChange={e => { setText(e.target.value); setErr(null) }} style={{ ...inputChrome(false), scrollMarginBottom: 96 }} />
          <p data-testid="recipe-ref-note" style={{ margin: '6px 0 0', color: P.mid, fontSize: '0.78rem', lineHeight: 1.45 }}>
            {TESTED_RECIPE_NOTE}{' '}
            <a href={TESTED_RECIPE_LINK} target="_blank" rel="noopener noreferrer" style={{ color: P.green }}>
              National Center for Home Food Preservation →
            </a>
          </p>
          <div style={{ display: 'flex', gap: 12 }}>
            <button type="button" style={link} data-testid="recipe-ref-save" disabled={busy} onClick={save}>Save</button>
            <button type="button" style={{ ...link, color: P.light, fontWeight: 400 }} disabled={busy} onClick={() => { setOpen(false); setErr(null) }}>Cancel</button>
          </div>
          {err && <p role="alert" data-alarm-ink-exempt="error" data-testid="recipe-ref-error" style={{ margin: '4px 0 0', color: P.terra, fontSize: T.type.sm }}>{err}</p>}
        </div>
      )}
    </div>
  )
}
