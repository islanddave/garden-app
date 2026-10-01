// src/components/recipes/FollowingRecipe.jsx
// Put-Up release 4 (V4 §2.2 "Following a recipe?" on the Start-a-batch sheet; its "pH" section) — collapsed, it reads
// "Following a recipe? · tested recipes →"; open, it offers F's free-text reference (kitchen_batch.recipe_ref:
// a card, a book, a link) and the tested-recipe caution in full, as reference content with a link-out
// (FOODSAFETY-RULING-V101 §3: record and prompt, never assess). Optional; required at open: 0.
//
// Put-Up UX pass R1 (PLAN-V3 D10). The household's OWN recipes are no longer picked here: the native select
// that listed them left this row for the Start sheet's "Start from · a recipe" (RecipePick, below), where a
// pick can fill the batch's name. The ruled row itself is unchanged — its question, its collapsed
// "· tested recipes →", its free-text reference and its caution behind the toggle, and the rule for when it
// opens by itself (a recipe already chosen, or a reference already typed).
//
// `value` = { recipeId, recipeRef, recipe } — `recipe` is `{ id, name, kind }` of the recipe that was
// picked, or null: the name is what "From the recipe: …" says, and the Start sheet fills an empty name and
// the kind from it. `recipe` is OPTIONAL on a value read from storage: a draft a release-4 client stored
// carries `recipeId` alone, and RecipePick names it from the list.
// `locked` = a recipe the sheet was opened FROM (Make this): shown as chosen, and the list is not fetched.
import React, { useEffect, useId, useMemo, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { TESTED_RECIPE_NOTE, TESTED_RECIPE_LINK, RECIPE_REF_MAX } from '../putup/RecipeRefRow.jsx'
import { FOLLOWING_QUESTION, groupByType } from './recipes.js'

// 48px tall (Put-Up UX pass R1, F16: height only — the size and weight are as they were).
const link = { display: 'inline-flex', alignItems: 'center', minHeight: T.buttonMinHeight, padding: '2px 0', background: 'none',
  border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: T.type.sm, fontWeight: 600, color: P.green }
const box = { minHeight: T.tapMinHeight, width: '100%', padding: '6px 8px', border: `1px solid ${P.border}`, borderRadius: T.radiusButton,
  fontFamily: 'inherit', fontSize: T.type.sm, background: P.white, boxSizing: 'border-box' }

// The create body's part: recipe_id when one is picked, recipe_ref when something is typed.
export function followingBody(v) {
  const out = {}
  if (v?.recipeId) out.recipe_id = v.recipeId
  const ref = String(v?.recipeRef ?? '').trim()
  if (ref) out.recipe_ref = ref.slice(0, RECIPE_REF_MAX)
  return out
}

// ── the pick ─────────────────────────────────────────────────────────────────────────────────────
export const START_FROM_RECIPE_PICKED = 'From the recipe:'
export const START_FROM_RECIPE_CLEAR = 'Not this recipe'
// What a tap on a recipe makes of the value, and what undoing it does. The free-text reference is its own
// answer and rides through both untouched.
export function pickRecipe(value, r) {
  return { ...value, recipeId: r.id, recipe: { id: r.id, name: String(r.name ?? ''), kind: r.kind ?? null } }
}
export function clearRecipe(value) {
  return { ...value, recipeId: null, recipe: null }
}

// "Start from · a recipe" (PLAN-V3 D10): what was picked, with its undo, and — while `open` — the
// household's recipes as ROWS grouped by what they make, the way the Recipes segment lists them
// (recipes.js groupByType). Twenty-odd recipes as chips would be eight wrapped rows of them.
//
// The list is read when it is first opened and not before (a plain start reads no recipes) — or to NAME a
// recipe the value already holds by id alone: a recipe that is no longer in the list is un-picked, never
// sent on. `onPick(recipe)` / `onClear()` are told AFTER `onChange`, so the host can fill and un-fill
// what it made of the pick.
export function RecipePick({
  value, onChange, fetch, open = false, onPick, onClear, locked = null, disabled = false, idPrefix = 'start-from-recipe',
}) {
  const [recipes, setRecipes] = useState(null)
  const [failed, setFailed] = useState(false)
  const unnamed = !locked && !!value?.recipeId && !value?.recipe
  const wanted = !locked && (open || unnamed)

  useEffect(() => {
    if (!wanted || recipes != null || !fetch) return undefined
    let alive = true
    setFailed(false)
    Promise.resolve()
      .then(() => fetch('/api/recipes'))
      .then(r => { if (alive) setRecipes(Array.isArray(r?.recipes) ? r.recipes : []) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [wanted, recipes, fetch])

  // A release-4 draft's pick, named once the list is in hand.
  useEffect(() => {
    if (!unnamed || recipes == null) return
    const hit = recipes.find(r => r.id === value.recipeId)
    onChange?.(hit ? pickRecipe(value, hit) : clearRecipe(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unnamed, recipes])

  const groups = useMemo(() => groupByType(recipes ?? []), [recipes])
  const pick = (r) => { onChange?.(pickRecipe(value, r)); onPick?.(r) }
  const clear = () => { onChange?.(clearRecipe(value)); onClear?.() }

  return (
    <>
      {locked && (
        <div data-testid="following-recipe-locked" style={{ fontSize: T.type.sm, color: P.dark, marginTop: 6 }}>
          {START_FROM_RECIPE_PICKED} <strong>{locked.name}</strong>
        </div>
      )}
      {!locked && value?.recipeId && (
        <div data-testid={`${idPrefix}-picked`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', color: P.mid, fontSize: T.type.sm }}>
          <span>{value.recipe ? <>{START_FROM_RECIPE_PICKED} <strong style={{ color: P.dark }}>{value.recipe.name}</strong></> : 'From one of your recipes'}</span>
          <button type="button" style={{ ...link, fontWeight: 400 }} disabled={disabled}
            data-testid={`${idPrefix}-clear`} onClick={clear}>{START_FROM_RECIPE_CLEAR}</button>
        </div>
      )}
      {open && !locked && (
        <div data-testid={`${idPrefix}-list`} style={{ marginTop: 6 }}>
          {recipes == null && !failed && <div style={{ color: P.light, fontSize: T.type.sm }}>Loading…</div>}
          {failed && <div role="alert" data-testid={`${idPrefix}-error`} style={{ color: P.terra, fontSize: T.type.sm }}>Couldn’t load your recipes just now.</div>}
          {recipes != null && recipes.length === 0 && (
            <div data-testid={`${idPrefix}-none`} style={{ color: P.light, fontSize: T.type.sm }}>No recipes yet.</div>
          )}
          {groups.map(g => (
            <div key={g.key} role="group" aria-label={g.label} data-testid={`${idPrefix}-group`}>
              <div aria-hidden="true" style={{ margin: '6px 0 0', fontSize: T.type.xs, fontWeight: 700, color: P.mid }}>{g.label}</div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {g.recipes.map(r => (
                  <li key={r.id} style={{ borderBottom: `1px solid ${P.cream}` }}>
                    <button type="button" data-testid={`${idPrefix}-row`} data-recipe-id={r.id} disabled={disabled} onClick={() => pick(r)}
                      style={{ display: 'block', width: '100%', textAlign: 'left', minHeight: T.buttonMinHeight, padding: '6px 0',
                        background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: P.dark,
                        fontSize: T.type.base, fontWeight: 600 }}>
                      {r.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ── the ruled row ────────────────────────────────────────────────────────────────────────────────
export default function FollowingRecipe({ value, onChange, disabled = false, locked = null, initiallyOpen = false }) {
  const [open, setOpen] = useState(initiallyOpen || !!locked || !!value?.recipeId || !!value?.recipeRef)
  const refId = `following-ref-${useId()}`

  return (
    <div data-testid="following-recipe" style={{ marginBottom: T.space.sm }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" data-testid="following-recipe-toggle" aria-expanded={open} disabled={disabled}
          onClick={() => setOpen(o => !o)} style={link}>
          {FOLLOWING_QUESTION}
          <span style={{ color: P.light, fontWeight: 400, fontSize: '0.78rem', marginLeft: 6 }}>optional</span>
        </button>
        {!open && (
          <a data-testid="following-recipe-tested-link" href={TESTED_RECIPE_LINK} target="_blank" rel="noopener noreferrer"
            style={{ ...link, fontWeight: 400, color: P.mid, textDecoration: 'none' }}>· tested recipes →</a>
        )}
      </div>
      {open && (
        <div data-testid="following-recipe-body" style={{ marginTop: 6 }}>
          <label htmlFor={refId} style={{ display: 'block', fontSize: T.type.sm, color: P.mid, marginBottom: 2 }}>Where it is from (a card, a book, a link)</label>
          <input id={refId} data-testid="following-recipe-ref" type="text" value={value?.recipeRef ?? ''} maxLength={RECIPE_REF_MAX}
            disabled={disabled} onChange={e => onChange?.({ ...value, recipeRef: e.target.value })} style={box} />
          <p data-testid="following-recipe-note" style={{ margin: '6px 0 0', color: P.mid, fontSize: '0.78rem', lineHeight: 1.45 }}>
            {TESTED_RECIPE_NOTE}{' '}
            <a href={TESTED_RECIPE_LINK} target="_blank" rel="noopener noreferrer" style={{ color: P.green }}>Tested recipes →</a>
          </p>
        </div>
      )}
    </div>
  )
}
