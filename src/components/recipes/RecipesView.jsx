// src/components/recipes/RecipesView.jsx
// Put-Up release 4 (V4 §2.6) — the Recipes segment of the Put-Up page: the household's recipes grouped by
// what they make (filterable by type), a recipe's detail, the create/edit sheet, and the three doors from a
// recipe into the kitchen — Make this (the Start sheet prefilled), and Made it, ate it all (a make with nothing
// kept, every line as written, recorded as eaten). Plain markup on the existing primitives; no visual design.
//
// ⚠ RECIPE DETAIL IS THE ONLY SURFACE THAT RENDERS THE NOTES (V4 "pH") — his target pH lives there, as he
// wrote it: paired marks show as bold or italic (recipes.js notesSegments, built as elements) and no other
// character moves. Its list of batches made from the recipe shows a date and the ending in words, at equal
// weight, and never a reading (the server does not send one: recipeRoutes.js readRecipe's batch list is an
// explicit column list).
//
// CONTROLLED BY ITS OWN FETCHES (the segment is self-contained): GET /api/recipes and /api/recipes/types on
// mount, GET /api/recipes/:id on open. `onBatchStarted(batch)` is the page's own landing (PutUp.jsx), so a
// batch started here opens exactly as one started from Going now does.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import Button from '../forms/Button.jsx'
import SelectChip from '../forms/SelectChip.jsx'
import StartBatchSheet from '../kitchen/StartBatchSheet.jsx'
import { kindLabel } from '../kitchen/KindChips.jsx'
import { mintKey } from '../kitchen/idempotencyKey.js'
import RecipeSheet from './RecipeSheet.jsx'
import {
  groupByType, keepsWords, vesselWords, bottleWords, recipeLineWords, madeBatchWords, startPrefill, vesselPatch,
  asWrittenLines, notesSegments, NEW_RECIPE_CTA, MAKE_THIS_CTA, I_MADE_THIS_CTA, MADE_CONFIRM_TEXT, MADE_CONFIRM_CTA,
  KEPT_SOME_CTA, NOTHING_KEPT_OUTCOME,
} from './recipes.js'

// The quiet text action, 48 px tall on Put-Up surfaces (UX pass R1).
const link = { display: 'inline-flex', alignItems: 'center', minHeight: T.buttonMinHeight, padding: '2px 8px 2px 0', background: 'none',
  border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: T.type.sm, fontWeight: 600 }
const isHttp = (u) => /^https?:\/\//i.test(String(u ?? ''))

export default function RecipesView({ onBatchStarted, now }) {
  const { fetch } = useApiFetch()
  const [recipes, setRecipes] = useState(null)
  const [types, setTypes] = useState([])
  const [error, setError] = useState(false)
  const [typeFilter, setTypeFilter] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [sheet, setSheet] = useState(null)            // null | { recipe: null | detail }

  const loadList = useCallback(() => {
    fetch('/api/recipes')
      .then(r => { setRecipes(Array.isArray(r?.recipes) ? r.recipes : []); setError(false) })
      .catch(() => setError(true))
  }, [fetch])
  const loadTypes = useCallback(() => {
    fetch('/api/recipes/types').then(r => setTypes(Array.isArray(r?.types) ? r.types : [])).catch(() => {})
  }, [fetch])
  useEffect(() => { loadList(); loadTypes() }, [loadList, loadTypes])

  const shown = useMemo(() => (recipes ?? []).filter(r => !typeFilter || r.recipe_type_id === typeFilter), [recipes, typeFilter])
  const groups = useMemo(() => groupByType(shown), [shown])
  const usedTypes = useMemo(() => {
    const seen = new Map()
    for (const r of recipes ?? []) if (r.recipe_type_id && !seen.has(r.recipe_type_id)) seen.set(r.recipe_type_id, { id: r.recipe_type_id, label: r.type_label, sort: r.type_sort })
    return [...seen.values()].sort((a, b) => (a.sort ?? 1e9) - (b.sort ?? 1e9) || String(a.label).localeCompare(String(b.label)))
  }, [recipes])

  const onTypeCreated = useCallback((t) => setTypes(ts => (ts.some(x => x.id === t.id) ? ts : [...ts, t])), [])

  if (openId) {
    return (
      <>
        <RecipeDetail id={openId} fetch={fetch} now={now} onBack={() => { setOpenId(null); loadList() }}
          onEdit={(detail) => setSheet({ recipe: detail })} onBatchStarted={onBatchStarted}
          onRemoved={() => { setOpenId(null); loadList() }} key={`${openId}:${sheet ? 'e' : 'v'}`} />
        <RecipeSheet open={!!sheet} recipe={sheet?.recipe ?? null} types={types} fetch={fetch} onTypeCreated={onTypeCreated}
          onClose={() => setSheet(null)} onSaved={() => { setSheet(null); loadList() }} />
      </>
    )
  }

  return (
    <div data-testid="recipes-view">
      <button type="button" data-testid="recipes-new" onClick={() => setSheet({ recipe: null })}
        style={{ ...link, marginBottom: T.space.sm }}>+ {NEW_RECIPE_CTA}</button>

      {usedTypes.length > 0 && (
        <div role="group" aria-label="Show recipes that make" data-testid="recipes-type-filter"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: T.space.md }}>
          <SelectChip small touch active={typeFilter == null} onClick={() => setTypeFilter(null)} data-testid="recipes-filter-all">All</SelectChip>
          {usedTypes.map(t => (
            <SelectChip key={t.id} small touch active={typeFilter === t.id} data-testid="recipes-filter-chip"
              onClick={() => setTypeFilter(typeFilter === t.id ? null : t.id)}>{t.label}</SelectChip>
          ))}
        </div>
      )}

      {error && <div role="alert" data-testid="recipes-error" style={{ color: P.terra, fontSize: T.type.sm }}>Couldn’t load the recipes. <button type="button" style={link} onClick={loadList}>Try again</button></div>}
      {!error && recipes == null && <div data-testid="recipes-loading" style={{ color: P.light, fontSize: T.type.sm }}>Loading recipes…</div>}
      {!error && recipes != null && recipes.length === 0 && (
        <div data-testid="recipes-empty" style={{ color: P.light, fontSize: T.type.sm }}>No recipes yet. Add one, or save a batch as a recipe from its page.</div>
      )}

      {groups.map(g => (
        <section key={g.key} data-testid="recipes-group" style={{ marginBottom: T.space.md }}>
          <h3 style={{ margin: '0 0 4px', fontSize: T.type.sm, color: P.mid, fontWeight: 700 }}>{g.label}</h3>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {g.recipes.map(r => (
              <li key={r.id} style={{ borderBottom: `1px solid ${P.cream}` }}>
                <button type="button" data-testid="recipes-row" data-recipe-id={r.id} onClick={() => setOpenId(r.id)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', minHeight: T.buttonMinHeight, padding: '6px 0',
                    background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                  <div style={{ color: P.dark, fontSize: T.type.base, fontWeight: 600 }}>{r.name}</div>
                  <div style={{ color: P.light, fontSize: T.type.xs }}>
                    {[keepsWords(r), r.batch_count ? `made ${r.batch_count} ${r.batch_count === 1 ? 'time' : 'times'}` : null, r.link_url ? 'link' : null].filter(Boolean).join(' · ')}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <RecipeSheet open={!!sheet} recipe={null} types={types} fetch={fetch} onTypeCreated={onTypeCreated}
        onClose={() => setSheet(null)} onSaved={(saved) => { setSheet(null); loadList(); if (saved?.id) setOpenId(saved.id) }} />
    </div>
  )
}

// ── one recipe ───────────────────────────────────────────────────────────────────────────────────
export function RecipeDetail({ id, fetch, now, onBack, onEdit, onBatchStarted, onRemoved }) {
  const [recipe, setRecipe] = useState(null)
  const [error, setError] = useState(false)
  const [starting, setStarting] = useState(false)
  const [madeOpen, setMadeOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const madePlan = useRef(null)                      // one key set per "Made it, ate it all" confirm, reused on retry
  const nowDate = useMemo(() => new Date(now ?? Date.now()), [now])

  const load = useCallback(() => {
    fetch(`/api/recipes/${id}`)
      .then(r => { setRecipe(r?.recipe ?? null); setError(false) })
      .catch(() => setError(true))
  }, [fetch, id])
  useEffect(() => { load() }, [load])

  const iMadeThis = async () => {
    if (busy || !recipe) return
    if (!madePlan.current) {
      madePlan.current = { key: mintKey(), lines: asWrittenLines(recipe, { includeAtTheEnd: true }), batch: null, lined: false, vessel: false }
    }
    const plan = madePlan.current
    setBusy(true); setErr(null)
    try {
      const pre = startPrefill(recipe)
      if (!plan.batch) {
        plan.batch = await fetch('/api/kitchen-batches', { method: 'POST', body: JSON.stringify({
          label: pre.label, ...(pre.kind ? { kind: pre.kind } : {}), recipe_id: recipe.id,
          started_at: new Date(nowDate).toISOString(), start_precision: 'exact', start_anchor_kind: 'memory',
          idempotency_key: plan.key,
        }) })
      }
      const bid = plan.batch.id
      const vp = vesselPatch(recipe)
      if (vp && !plan.vessel) { await fetch(`/api/kitchen-batches/${bid}`, { method: 'PUT', body: JSON.stringify(vp) }); plan.vessel = true }
      if (plan.lines.length && !plan.lined) {
        await fetch(`/api/kitchen-batches/${bid}/inputs`, { method: 'POST', body: JSON.stringify({ inputs: plan.lines }) })
        plan.lined = true
      }
      await fetch(`/api/kitchen-batches/${bid}/close`, { method: 'POST', body: JSON.stringify({ outcome: NOTHING_KEPT_OUTCOME }) })
      madePlan.current = null
      setMadeOpen(false)
      onBatchStarted?.(plan.batch)
    } catch {
      setErr("Couldn't record it — try again (nothing is recorded twice).")
    } finally { setBusy(false) }
  }

  const remove = async () => {
    if (busy) return
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/recipes/${id}`, { method: 'DELETE' })
      onRemoved?.()
    } catch {
      setErr("Couldn't remove it — try again.")
      setBusy(false)
    }
  }

  const back = <button type="button" style={link} data-testid="recipe-back" onClick={onBack}>← Recipes</button>
  if (error) return <div data-testid="recipe-detail">{back}<div role="alert" style={{ color: P.terra, fontSize: T.type.sm }}>Couldn’t open that recipe.</div></div>
  if (!recipe) return <div data-testid="recipe-detail">{back}<div style={{ color: P.light, fontSize: T.type.sm }}>Opening that recipe…</div></div>

  const pot = (recipe.lines ?? []).filter(l => !l.at_the_end)
  const end = (recipe.lines ?? []).filter(l => l.at_the_end)
  const facts = [recipe.type_label, kindLabel(recipe.kind), keepsWords(recipe)].filter(Boolean)
  const containers = [
    vesselWords(recipe) ? ['Made in', vesselWords(recipe)] : null,
    bottleWords(recipe) ? ['Put up in', bottleWords(recipe)] : null,
    recipe.made_text ? ['Makes', recipe.made_text] : null,
  ].filter(Boolean)

  return (
    <div data-testid="recipe-detail" data-recipe-id={recipe.id}>
      {back}
      <h2 data-testid="recipe-detail-name" style={{ margin: '4px 0 2px', fontSize: T.type.lg, color: P.dark }}>{recipe.name}</h2>
      {facts.length > 0 && <div data-testid="recipe-detail-facts" style={{ color: P.mid, fontSize: T.type.sm }}>{facts.join(' · ')}</div>}
      {recipe.link_url && isHttp(recipe.link_url) && (
        <a data-testid="recipe-detail-link" href={recipe.link_url} target="_blank" rel="noopener noreferrer"
          style={{ ...link, textDecoration: 'underline', wordBreak: 'break-all' }}>{recipe.link_url}</a>
      )}

      {/* ONE filled button per state: Make this — until the confirm below is open, when its own is the one. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, margin: `${T.space.sm}px 0` }}>
        <Button variant={madeOpen ? 'secondary' : 'primary'} data-testid="recipe-make-this" onClick={() => setStarting(true)}>{MAKE_THIS_CTA}</Button>
        <Button variant="secondary" data-testid="recipe-i-made-this" aria-expanded={madeOpen}
          onClick={() => { setMadeOpen(o => !o); setErr(null) }}>{I_MADE_THIS_CTA}</Button>
        <button type="button" style={link} data-testid="recipe-edit" onClick={() => onEdit?.(recipe)}>Edit</button>
      </div>

      {madeOpen && (
        <div data-testid="recipe-made-confirm" style={{ padding: '8px 0', borderTop: `1px solid ${P.cream}`, borderBottom: `1px solid ${P.cream}`, marginBottom: T.space.sm }}>
          <p style={{ margin: '0 0 6px', color: P.mid, fontSize: T.type.sm }}>{MADE_CONFIRM_TEXT}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <Button variant="primary" data-testid="recipe-made-confirm-save" loading={busy} loadingLabel="Recording…" onClick={iMadeThis}>{MADE_CONFIRM_CTA}</Button>
            <button type="button" style={link} data-testid="recipe-made-cancel" disabled={busy}
              onClick={() => { setMadeOpen(false); madePlan.current = null }}>Cancel</button>
          </div>
          {/* Kept some of it: that is a batch, so this is Make this (there is no batch yet to put up). */}
          <button type="button" style={link} data-testid="recipe-made-kept-some" disabled={busy}
            onClick={() => { setMadeOpen(false); madePlan.current = null; setErr(null); setStarting(true) }}>{KEPT_SOME_CTA}</button>
        </div>
      )}

      {containers.length > 0 && (
        <dl data-testid="recipe-detail-containers" style={{ margin: `0 0 ${T.space.sm}px`, fontSize: T.type.sm, color: P.mid }}>
          {containers.map(([k, v]) => <div key={k}><dt style={{ display: 'inline', fontWeight: 600 }}>{k}: </dt><dd style={{ display: 'inline', margin: 0 }}>{v}</dd></div>)}
        </dl>
      )}

      {(recipe.lines ?? []).length > 0 && (
        <section data-testid="recipe-detail-lines" style={{ marginBottom: T.space.md }}>
          <h3 style={{ margin: '0 0 4px', fontSize: T.type.sm, color: P.dark }}>What goes in</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {pot.map(l => <li key={l.id} data-testid="recipe-detail-line" style={{ fontSize: T.type.sm, color: P.dark }}>{recipeLineWords(l)}</li>)}
          </ul>
          {end.length > 0 && (
            <>
              <h4 style={{ margin: '6px 0 2px', fontSize: T.type.sm, color: P.mid }}>At the end</h4>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {end.map(l => <li key={l.id} data-testid="recipe-detail-line-end" style={{ fontSize: T.type.sm, color: P.dark }}>{recipeLineWords(l)}</li>)}
              </ul>
            </>
          )}
        </section>
      )}

      {recipe.notes && (
        <section data-testid="recipe-detail-notes-section" style={{ marginBottom: T.space.md }}>
          <h3 style={{ margin: '0 0 4px', fontSize: T.type.sm, color: P.dark }}>Notes</h3>
          {/* His text as he wrote it (V4 §2.6), whitespace kept; a pair of marks shows as bold or italic and
              nothing else moves. Built as ELEMENTS from text runs — never as markup. The only surface that
              renders it. */}
          <div data-testid="recipe-detail-notes" style={{ whiteSpace: 'pre-wrap', fontSize: T.type.sm, color: P.dark, lineHeight: 1.5 }}>
            {notesSegments(recipe.notes).map((s, i) => (
              s.kind === 'bold' ? <strong key={i}>{s.text}</strong>
                : s.kind === 'italic' ? <em key={i}>{s.text}</em>
                  : <React.Fragment key={i}>{s.text}</React.Fragment>
            ))}
          </div>
        </section>
      )}

      <section data-testid="recipe-detail-batches" style={{ marginBottom: T.space.md }}>
        <h3 style={{ margin: '0 0 4px', fontSize: T.type.sm, color: P.dark }}>Made from this</h3>
        {(recipe.batches ?? []).length === 0 ? (
          <div style={{ color: P.light, fontSize: T.type.sm }}>Not made from here yet.</div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {recipe.batches.map(b => {
              const w = madeBatchWords(b, nowDate)
              return (
                <li key={b.id} data-testid="recipe-detail-batch" style={{ fontSize: T.type.sm, color: P.dark, padding: '3px 0' }}>
                  <button type="button" style={{ ...link, fontWeight: 400, color: P.dark }} data-testid="recipe-detail-batch-open"
                    onClick={() => onBatchStarted?.(b)}>
                    {b.label} · {w.when} · {w.ending}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {err && <div role="alert" data-alarm-ink-exempt="error" data-testid="recipe-detail-error" style={{ color: P.terra, fontSize: T.type.sm }}>{err}</div>}

      <div style={{ marginTop: T.space.md }}>
        {!removing ? (
          <button type="button" style={{ ...link, color: P.light, fontWeight: 400 }} data-testid="recipe-remove" onClick={() => setRemoving(true)}>Remove this recipe</button>
        ) : (
          <span data-testid="recipe-remove-confirm">
            <span style={{ color: P.mid, fontSize: T.type.sm }}>Remove it? Batches made from it stay. </span>
            <button type="button" style={link} data-testid="recipe-remove-yes" disabled={busy} onClick={remove}>Remove</button>
            <button type="button" style={{ ...link, color: P.light }} disabled={busy} onClick={() => setRemoving(false)}>Keep it</button>
          </span>
        )}
      </div>

      {starting && (
        <StartBatchSheet open recipe={recipe} onClose={() => setStarting(false)}
          onStarted={(batch) => { setStarting(false); onBatchStarted?.(batch) }} />
      )}
    </div>
  )
}
