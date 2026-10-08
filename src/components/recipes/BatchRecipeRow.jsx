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
//
// Put-Up UX pass R1 (D15) — TWO components now, because batch detail puts them in two places:
//   · BatchRecipeRow (default) — the recipe row. With `onOpenRecipe` the name is the way to the recipe:
//     "From <name> →" calls onOpenRecipe(id, { label: batch.label, kind: 'batch', id: batch.id }), so the
//     recipe's Back can name the batch it came from. Without the prop it is the words it always was.
//   · SaveAsRecipe — the Save as recipe door and its one-field form, which batch detail mounts down beside
//     Pause and the ending. BatchRecipeRow still renders it inside itself unless told `saveAsRecipe={false}`,
//     so a host that mounts the row alone gets exactly what it got before.
// "Made it as written" has two doors (the row's quiet link, and a button for the empty What went in block),
// so its write lives in ONE hook, useMadeAsWritten: one key set per recipe, reused on a retry from EITHER
// door — a second key set would add every line twice. A page shows ONE of them (Put-Up R2a, M2): batch
// detail hands the row its hook (`asWritten`) and draws the button, so the hosted row draws no link; a row
// mounted alone has no button below it and keeps the link.
import React, { useEffect, useId, useRef, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import Button from '../forms/Button.jsx'
import { mintKey, sendPrint, noteSent, afterReplay, answerLost, sameFact, answeredNo, updateSent, holdsOwnUpdate } from '../kitchen/idempotencyKey.js'
import { describeRefusal } from '../../lib/putUpErrors.js'
import { asWrittenLines, recipeLineWords, MADE_AS_WRITTEN_CTA, SAVE_AS_RECIPE_CTA } from './recipes.js'

const link = { display: 'inline-flex', alignItems: 'center', minHeight: T.buttonMinHeight, minWidth: 44, padding: '2px 8px 2px 0',
  background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: '0.82rem', fontWeight: 600 }

// "Adds the recipe's 6 lines." — what the one tap writes, said before it is tapped.
export function asWrittenHint(count) {
  return `Adds the recipe's ${count} ${count === 1 ? 'line' : 'lines'}.`
}

// `can` — the batch follows a recipe that has pot lines, and has none of its own yet. `run(door)` writes
// them; `failed` is { text, door } so the door that was tapped is the one that says why.
export function useMadeAsWritten({ batch, inputs = [], onChanged }) {
  const { fetch } = useApiFetch()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(null)
  const keyed = useRef(null)                         // one key set per recipe, reused on a retry
  const recipe = batch?.recipe ?? null
  const potLines = (recipe?.lines ?? []).filter(l => !l.at_the_end)
  const ownPotLines = (Array.isArray(inputs) ? inputs : []).filter(i => !i.put_up_stage_id)
  const can = !!recipe && potLines.length > 0 && ownPotLines.length === 0

  const run = async (door = 'row') => {
    if (busy || !can) return
    if (!keyed.current || keyed.current.recipeId !== recipe.id) keyed.current = { recipeId: recipe.id, lines: asWrittenLines(recipe) }
    setBusy(true); setFailed(null)
    try {
      await fetch(`/api/kitchen-batches/${batch.id}/inputs`, { method: 'POST', body: JSON.stringify({ inputs: keyed.current.lines }) })
      keyed.current = null
      onChanged?.()
    } catch (e) {
      setFailed({ door, text: describeRefusal(e)?.text ?? "Couldn't add the lines — try again (nothing is added twice)." })
    } finally { setBusy(false) }
  }
  return { can, busy, failed, run, count: potLines.length }
}

// The second door: a 48px secondary button for the empty What went in block, with what it will do.
export function MadeAsWrittenButton({ asWritten }) {
  if (!asWritten?.can) return null
  return (
    <div data-testid="what-went-in-as-written" style={{ margin: '6px 0' }}>
      <Button variant="secondary" data-testid="what-went-in-as-written-add" loading={asWritten.busy} loadingLabel="Adding…"
        onClick={() => asWritten.run('block')}>
        {MADE_AS_WRITTEN_CTA}
      </Button>
      <div data-testid="what-went-in-as-written-hint" style={{ marginTop: 4, color: P.light, fontSize: '0.78rem' }}>
        {asWrittenHint(asWritten.count)}
      </div>
      {asWritten.failed?.door === 'block' && (
        <div role="alert" data-alarm-ink-exempt="error" data-testid="what-went-in-as-written-error"
          style={{ color: P.terra, fontSize: T.type.sm }}>{asWritten.failed.text}</div>
      )}
    </div>
  )
}

// Save as recipe, when its create is answered with the recipe an EARLIER Save made, maybe under another name
// (kitchen/idempotencyKey.js). STALE: the recipe is not this sitting's to rename (made a while ago, or changed
// since) — nothing is written, and the key is KEPT: a new one would make a second recipe of the same batch.
// A recipe that already has the name typed is a save, with nothing written. Each refusal is brought into view.
// UNSAVED: the rename was tried and did not go through (`lost`: no answer came back, so it may have).
// Either way the recipe is there, and the sentence gives the name it answered with.
export function saveAsRecipeStaleText(recipe) {
  const name = String(recipe?.name ?? '').trim()
  return `${name ? `Already saved as a recipe: “${name}”` : 'Already saved as a recipe'} — an earlier Save went through. This Save did not rename it: to rename it, open the recipe.`
}
export function saveAsRecipeUnsavedText(recipe, { lost = false } = {}) {
  const name = String(recipe?.name ?? '').trim()
  return `${name ? `Already saved as a recipe: “${name}”` : 'Already saved as a recipe'} — the first Save went through. The new name ${lost ? 'may not have saved' : 'did not save'} — try again.`
}

export function SaveAsRecipe({ batch, onChanged }) {
  const { fetch } = useApiFetch()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [saving, setSaving] = useState(false)       // the Save as recipe field is open
  const [name, setName] = useState('')
  const [saved, setSaved] = useState(null)
  // The Save's key, the batch it is for, what has gone out under it, and the recipe a rename was sent to
  // (kitchen/idempotencyKey.js). It outlives a failure, a Cancel and a changed name, and belongs to ONE
  // batch: another batch is another create.
  const held = useRef(null)
  const errRef = useRef(null)
  const [refusedSeq, setRefusedSeq] = useState(0)
  useEffect(() => {
    if (refusedSeq && typeof errRef.current?.scrollIntoView === 'function') errRef.current.scrollIntoView({ block: 'nearest' })
  }, [refusedSeq])
  const nameId = `save-recipe-name-${useId()}`
  if (!batch) return null

  const saveAsRecipe = async () => {
    if (busy) return
    const n = name.trim()
    if (!n) { setErr('Give the recipe a name.'); return }
    if (held.current?.batchId !== batch.id) held.current = { key: mintKey(), batchId: batch.id, sent: [], patched: null }
    const body = { idempotency_key: held.current.key, name: n.slice(0, 120) }
    const print = sendPrint(body)
    const sent = noteSent(held.current.sent, print)
    held.current.sent = sent
    setBusy(true); setErr(null)
    // The recipe a replay answered with, once it is being renamed.
    let onRow = null
    try {
      let answer = await fetch(`/api/recipes/from-batch/${batch.id}`, { method: 'POST', body: JSON.stringify(body) })
      const todo = afterReplay(answer, sent, print, {
        row: answer?.recipe, updatedHere: holdsOwnUpdate(answer?.recipe, held.current.patched),
        holds: sameFact(answer?.recipe?.name, body.name),
      })
      if (todo === 'stale') {
        setErr(saveAsRecipeStaleText(answer?.recipe))
        setRefusedSeq(s => s + 1)
        onChanged?.()
        return
      }
      if (todo === 'update') {
        // The recipe this sitting's earlier Save made under another name (its answer was lost): this name goes onto it.
        onRow = answer?.recipe ?? null
        if (onRow?.id == null) throw new Error('replayed without a recipe')
        const was = held.current.patched
        const patch = { name: body.name }
        held.current.patched = updateSent(onRow.id, patch)
        try {
          answer = await fetch(`/api/recipes/${onRow.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
        } catch (e) {
          // An ANSWERED 4xx did not land: the rename this row keeps is the one before it.
          if (answeredNo(e)) held.current.patched = was
          throw e
        }
      }
      held.current = null
      setSaving(false)
      setSaved(answer?.recipe?.name ?? n)
      onChanged?.()
    } catch (e) {
      if (onRow?.id != null) { setErr(saveAsRecipeUnsavedText(onRow, { lost: answerLost(e) })); setRefusedSeq(s => s + 1); onChanged?.() }
      else { setErr("Couldn't save it as a recipe — try again."); setRefusedSeq(s => s + 1) }
    } finally { setBusy(false) }
  }

  return (
    <>
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
      {err && <div ref={errRef} role="alert" data-alarm-ink-exempt="error" data-testid="batch-save-as-recipe-error" style={{ color: P.terra, fontSize: T.type.sm }}>{err}</div>}
    </>
  )
}

export default function BatchRecipeRow({ batch, inputs = [], onChanged, onOpenRecipe, saveAsRecipe = true, asWritten: hosted }) {
  const recipe = batch?.recipe ?? null
  const [showLines, setShowLines] = useState(false)
  // The host's hook when it shares one with the What went in block; this row's own when it stands alone.
  const own = useMadeAsWritten({ batch, inputs, onChanged })
  const asWritten = hosted ?? own
  if (!batch) return null
  // Nothing to say: no recipe, and Save as recipe is mounted elsewhere.
  if (!recipe && !saveAsRecipe) return null

  const potLines = (recipe?.lines ?? []).filter(l => !l.at_the_end)
  const endLines = (recipe?.lines ?? []).filter(l => l.at_the_end)
  const opens = !!recipe && typeof onOpenRecipe === 'function'

  return (
    <div data-testid="batch-recipe" style={{ marginTop: T.space.sm }}>
      {recipe && (
        <div data-testid="batch-recipe-from" style={{ fontSize: T.type.sm, color: P.mid }}>
          {opens ? (
            // The whole phrase is the target, so the tap is as wide as the words. One inner span keeps the
            // spaces round the name (a flex container drops them between its own items).
            <button type="button" style={{ ...link, textAlign: 'left', fontWeight: 400 }} data-testid="batch-recipe-open"
              onClick={() => onOpenRecipe(recipe.id, { label: batch.label, kind: 'batch', id: batch.id })}>
              <span>From <strong>{recipe.name}</strong> →</span>
            </button>
          ) : (
            <>From the recipe: <strong style={{ color: P.dark }}>{recipe.name}</strong></>
          )}
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
      {/* The quiet link is this row's door when it stands alone. A HOSTED row sits above the host's own
          "Made it as written" button (the empty What went in block), so the link is not drawn there: one
          door, said once (Put-Up R2a, M2). */}
      {asWritten.can && !hosted && (
        <button type="button" style={link} data-testid="batch-recipe-as-written" disabled={asWritten.busy} onClick={() => asWritten.run('row')}>
          {asWritten.busy ? 'Adding…' : `${MADE_AS_WRITTEN_CTA} →`}
        </button>
      )}
      {asWritten.failed?.door === 'row' && (
        <div role="alert" data-alarm-ink-exempt="error" data-testid="batch-recipe-error" style={{ color: P.terra, fontSize: T.type.sm }}>{asWritten.failed.text}</div>
      )}

      {saveAsRecipe && <SaveAsRecipe batch={batch} onChanged={onChanged} />}
    </div>
  )
}
