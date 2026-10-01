// src/components/recipes/BatchRecipeRow.jsx
// Put-Up release 4 (V4 §2.6) — the recipe's place on batch detail:
//   · "From the recipe: <name>" when the batch follows one, with the recipe's lines as REFERENCE TEXT (Make
//     this copies them as reference, never as lines) and **Made it as written** — one tap that writes every
//     pot line with its amount (keyed lines through F's line POST), offered while the batch has none of its
//     own yet. "at the end" lines stay reference: they go in at the bottling.
//   · **Save as recipe** — the name prefilled with the batch label; one keyed POST to
//     /api/recipes/from-batch/:batchId, which carries every line, amount, form, brand, heat, note, the salt
//     facts, the jar, Made and mash in, and the first bottling's container (F §1.5).
// ⚠ Never the recipe's notes here (his target pH lives in them and renders only on recipe detail, V4 "pH"):
// the batch read does not carry them.
import React, { useId, useRef, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { mintKey } from '../kitchen/idempotencyKey.js'
import { describeRefusal } from '../../lib/putUpErrors.js'
import { asWrittenLines, recipeLineWords, MADE_AS_WRITTEN_CTA, SAVE_AS_RECIPE_CTA } from './recipes.js'

const link = { display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight, minWidth: 44, padding: '2px 8px 2px 0',
  background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: '0.82rem', fontWeight: 600 }

export default function BatchRecipeRow({ batch, inputs = [], onChanged }) {
  const { fetch } = useApiFetch()
  const recipe = batch?.recipe ?? null
  const [showLines, setShowLines] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [saving, setSaving] = useState(false)       // the Save as recipe field is open
  const [name, setName] = useState('')
  const [saved, setSaved] = useState(null)
  const asWritten = useRef(null)                     // one key set per recipe, reused on a retry
  const saveKey = useRef(null)
  const nameId = `save-recipe-name-${useId()}`
  if (!batch) return null

  const potLines = (recipe?.lines ?? []).filter(l => !l.at_the_end)
  const endLines = (recipe?.lines ?? []).filter(l => l.at_the_end)
  const ownPotLines = (inputs ?? []).filter(i => !i.put_up_stage_id)
  const canAsWritten = !!recipe && potLines.length > 0 && ownPotLines.length === 0

  const madeAsWritten = async () => {
    if (busy) return
    if (!asWritten.current || asWritten.current.recipeId !== recipe.id) asWritten.current = { recipeId: recipe.id, lines: asWrittenLines(recipe) }
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/kitchen-batches/${batch.id}/inputs`, { method: 'POST', body: JSON.stringify({ inputs: asWritten.current.lines }) })
      asWritten.current = null
      onChanged?.()
    } catch (e) {
      setErr(describeRefusal(e)?.text ?? "Couldn't add the lines — try again (nothing is added twice).")
    } finally { setBusy(false) }
  }

  const saveAsRecipe = async () => {
    if (busy) return
    const n = name.trim()
    if (!n) { setErr('Give the recipe a name.'); return }
    if (!saveKey.current) saveKey.current = mintKey()
    setBusy(true); setErr(null)
    try {
      const answer = await fetch(`/api/recipes/from-batch/${batch.id}`, { method: 'POST', body: JSON.stringify({ idempotency_key: saveKey.current, name: n.slice(0, 120) }) })
      saveKey.current = null
      setSaving(false)
      setSaved(answer?.recipe?.name ?? n)
      onChanged?.()
    } catch {
      setErr("Couldn't save it as a recipe — try again.")
    } finally { setBusy(false) }
  }

  return (
    <div data-testid="batch-recipe" style={{ marginTop: T.space.sm }}>
      {recipe && (
        <div data-testid="batch-recipe-from" style={{ fontSize: T.type.sm, color: P.mid }}>
          From the recipe: <strong style={{ color: P.dark }}>{recipe.name}</strong>
          {(recipe.lines ?? []).length > 0 && (
            <button type="button" style={{ ...link, marginLeft: 6 }} data-testid="batch-recipe-lines-toggle" aria-expanded={showLines}
              onClick={() => setShowLines(o => !o)}>{showLines ? 'Hide its lines' : 'Its lines'}</button>
          )}
        </div>
      )}
      {recipe && showLines && (
        <div data-testid="batch-recipe-lines" style={{ fontSize: T.type.sm, color: P.dark, margin: '2px 0 4px' }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {potLines.map(l => <li key={l.id} data-testid="batch-recipe-line">{recipeLineWords(l)}</li>)}
          </ul>
          {endLines.length > 0 && (
            <div style={{ color: P.mid, marginTop: 2 }}>At the end: {endLines.map(recipeLineWords).join(', ')}</div>
          )}
        </div>
      )}
      {canAsWritten && (
        <button type="button" style={link} data-testid="batch-recipe-as-written" disabled={busy} onClick={madeAsWritten}>
          {busy ? 'Adding…' : `${MADE_AS_WRITTEN_CTA} →`}
        </button>
      )}

      {!saving ? (
        <button type="button" style={{ ...link, display: 'flex' }} data-testid="batch-save-as-recipe"
          onClick={() => { setSaving(true); setName(batch.label ?? ''); setErr(null); setSaved(null) }}>
          {SAVE_AS_RECIPE_CTA}
        </button>
      ) : (
        <div data-testid="batch-save-as-recipe-form" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 4 }}>
          <label htmlFor={nameId} style={{ fontSize: T.type.sm, color: P.mid }}>Recipe name</label>
          <input id={nameId} data-testid="batch-save-as-recipe-name" value={name} maxLength={120} disabled={busy}
            onChange={e => { setName(e.target.value); setErr(null) }}
            style={{ minHeight: T.tapMinHeight, padding: '6px 8px', border: `1px solid ${P.border}`, borderRadius: T.radiusButton, fontFamily: 'inherit', fontSize: T.type.sm }} />
          <button type="button" style={link} data-testid="batch-save-as-recipe-save" disabled={busy} onClick={saveAsRecipe}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" style={{ ...link, color: P.light, fontWeight: 400 }} disabled={busy} onClick={() => setSaving(false)}>Cancel</button>
        </div>
      )}
      {saved && <div role="status" data-testid="batch-save-as-recipe-saved" style={{ fontSize: T.type.sm, color: P.mid }}>Saved as a recipe: {saved}</div>}
      {err && <div role="alert" data-alarm-ink-exempt="error" data-testid="batch-recipe-error" style={{ color: P.terra, fontSize: T.type.sm }}>{err}</div>}
    </div>
  )
}
