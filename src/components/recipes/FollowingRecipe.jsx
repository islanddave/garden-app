// src/components/recipes/FollowingRecipe.jsx
// Put-Up release 4 (V4 §2.2 "Following a recipe?" on the Start-a-batch sheet; its "pH" section) — collapsed, it reads
// "Following a recipe? · tested recipes →"; open, it offers the household's recipes (picked → recipe_id), F's
// free-text reference (kitchen_batch.recipe_ref: a card, a book, a link) and the tested-recipe caution in
// full, as reference content with a link-out (FOODSAFETY-RULING-V101 §3: record and prompt, never assess).
// Optional; required at open: 0.
//
// `value` = { recipeId, recipeRef }; `locked` = a recipe the sheet was opened FROM (Make this): shown as
// chosen, and the list is not fetched.
import React, { useEffect, useId, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { TESTED_RECIPE_NOTE, TESTED_RECIPE_LINK, RECIPE_REF_MAX } from '../putup/RecipeRefRow.jsx'
import { FOLLOWING_QUESTION } from './recipes.js'

const link = { display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight, padding: '2px 0', background: 'none',
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

export default function FollowingRecipe({ value, onChange, fetch, disabled = false, locked = null, initiallyOpen = false }) {
  const [open, setOpen] = useState(initiallyOpen || !!locked || !!value?.recipeId || !!value?.recipeRef)
  const [recipes, setRecipes] = useState(null)
  const selectId = `following-recipe-${useId()}`
  const refId = `following-ref-${useId()}`

  useEffect(() => {
    if (!open || locked || recipes != null || !fetch) return undefined
    let alive = true
    Promise.resolve()
      .then(() => fetch('/api/recipes'))
      .then(r => { if (alive) setRecipes(Array.isArray(r?.recipes) ? r.recipes : []) })
      .catch(() => { if (alive) setRecipes([]) })
    return () => { alive = false }
  }, [open, locked, recipes, fetch])

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
          {locked ? (
            <div data-testid="following-recipe-locked" style={{ fontSize: T.type.sm, color: P.dark, marginBottom: 6 }}>
              From the recipe: <strong>{locked.name}</strong>
            </div>
          ) : (
            <div style={{ marginBottom: 6 }}>
              <label htmlFor={selectId} style={{ display: 'block', fontSize: T.type.sm, color: P.mid, marginBottom: 2 }}>One of your recipes</label>
              <select id={selectId} data-testid="following-recipe-select" disabled={disabled || recipes == null} value={value?.recipeId ?? ''}
                onChange={e => onChange?.({ ...value, recipeId: e.target.value || null })} style={box}>
                <option value="">{recipes == null ? 'Loading…' : 'None'}</option>
                {(recipes ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          )}
          <label htmlFor={refId} style={{ display: 'block', fontSize: T.type.sm, color: P.mid, marginBottom: 2 }}>Or where it is from (a card, a book, a link)</label>
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
