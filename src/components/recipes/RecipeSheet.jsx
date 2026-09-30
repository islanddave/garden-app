// src/components/recipes/RecipeSheet.jsx
// Put-Up release 4 (V4 §2.6) — create or edit a recipe: name · what it makes (type) · link or notes ·
// optional lines (name + amount as written + "at the end") · optional "how long, and where" line — plus the
// process jar and the final container a make can span (Dave 2026-09-30) and the yield as written. Only the
// name is required. <Sheet armsBack>; the draft survives a dismiss (kitchen/sheetDraft.js, sheet 'recipe',
// id 'new' or the recipe's id); the create is keyed (one key per draft, reused on every retry).
//
// ⚠ Notes are his text VERBATIM (including his own target pH): sent exactly as typed, never trimmed inside.
// Plain markup, existing primitives, no visual design (functionality first).
import React, { useEffect, useId, useRef, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { setReloadBlocked } from '../../lib/reloadGate.js'
import Sheet from '../forms/Sheet.jsx'
import Field from '../forms/Field.jsx'
import Input from '../forms/Input.jsx'
import Textarea from '../forms/Textarea.jsx'
import Button from '../forms/Button.jsx'
import SelectChip from '../forms/SelectChip.jsx'
import { readSheetDraft, writeSheetDraft, clearSheetDraft } from '../kitchen/sheetDraft.js'
import { useSheetDraftKey } from '../kitchen/useSheetDraftKey.js'
import { mintKey } from '../kitchen/idempotencyKey.js'
import TypePicker from './TypePicker.jsx'
import {
  emptyDraft, draftFromRecipe, recipeBody, RECIPE_KIND_OPTIONS, STORAGE_KIND_WORDS, KEEPS_UNIT_WORDS,
  RECIPE_STORAGE_KINDS, KITCHEN_UNITS, EMPTY_LINE,
} from './recipes.js'

export const RECIPE_SHEET = 'recipe'
const UNIT_OPTIONS = KITCHEN_UNITS.map(u => ({ value: u, label: u }))

export function isRecipeDraft(d) {
  return !!d && typeof d === 'object' && !Array.isArray(d) && typeof d.name === 'string'
    && typeof d.notes === 'string' && Array.isArray(d.lines) && (d.key === undefined || typeof d.key === 'string')
}

const small = { minHeight: T.tapMinHeight, padding: '4px 8px', background: 'none', border: 'none', color: P.green,
  fontFamily: 'inherit', fontSize: T.type.sm, fontWeight: 600, cursor: 'pointer' }

export default function RecipeSheet({ open, ...rest }) {
  if (!open) return null
  return <RecipeSheetOpen {...rest} />
}

function RecipeSheetOpen({ recipe = null, types = [], fetch, onClose, onSaved, onTypeCreated }) {
  const editing = !!recipe?.id
  const draftKey = useSheetDraftKey(RECIPE_SHEET, editing ? recipe.id : 'new')
  const [initial] = useState(() => readSheetDraft(draftKey, RECIPE_SHEET, isRecipeDraft) ?? (editing ? draftFromRecipe(recipe) : emptyDraft()))
  const [d, setD] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const writingRef = useRef(false)
  const base = useRef(JSON.stringify(editing ? draftFromRecipe(recipe) : emptyDraft()))
  const ids = { name: `recipe-name-${useId()}`, link: `recipe-link-${useId()}`, notes: `recipe-notes-${useId()}` }

  const set = (patch) => { setD(x => ({ ...x, ...patch })); setErr(null) }
  const setLine = (i, patch) => set({ lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch, _keep: undefined } : l)) })
  const dirty = JSON.stringify({ ...d, key: '' }) !== JSON.stringify({ ...JSON.parse(base.current), key: '' })

  useEffect(() => {
    if (!draftKey) return
    if (dirty) writeSheetDraft(draftKey, RECIPE_SHEET, d)
    else clearSheetDraft(draftKey)
  }, [draftKey, dirty, d])
  // The create's key: minted when the sheet is first dirty, kept in the draft, reused on every retry.
  useEffect(() => { if (!editing && dirty && !d.key) setD(x => ({ ...x, key: mintKey() })) }, [editing, dirty, d.key])

  const holdReload = dirty || saving
  const gateKey = `recipe-sheet:${useId()}`
  useEffect(() => {
    setReloadBlocked(gateKey, holdReload)
    return () => setReloadBlocked(gateKey, false)
  }, [gateKey, holdReload])

  const save = async () => {
    if (writingRef.current) return
    const res = recipeBody(d, { mode: editing ? 'edit' : 'create' })
    if (res.error) { setErr(res.error); return }
    writingRef.current = true
    setSaving(true); setErr(null)
    try {
      const answer = editing
        ? await fetch(`/api/recipes/${recipe.id}`, { method: 'PATCH', body: JSON.stringify(res.body) })
        : await fetch('/api/recipes', { method: 'POST', body: JSON.stringify(res.body) })
      clearSheetDraft(draftKey)
      onSaved?.(answer?.recipe ?? null)
    } catch (e) {
      writingRef.current = false
      setSaving(false)
      setErr(e?.body?.error ? `Couldn't save it: ${e.body.error}` : "Couldn't save it — try again. What you typed is still here.")
    }
  }

  return (
    <Sheet open onClose={onClose} title={editing ? 'Edit recipe' : 'New recipe'} size="full" busy={saving} armsBack>
      <div data-testid="recipe-sheet" style={{ padding: '0 18px 12px' }}>
        <Field label="Name" htmlFor={ids.name} required style={{ marginBottom: T.space.md }}>
          <Input id={ids.name} data-testid="recipe-name" value={d.name} maxLength={120} disabled={saving}
            onChange={e => set({ name: e.target.value })} />
        </Field>

        <div style={{ marginBottom: T.space.md }}>
          <div style={{ fontSize: T.type.sm, fontWeight: 600, color: P.dark, marginBottom: 6 }}>What it makes <span style={{ color: P.light, fontWeight: 400 }}>optional</span></div>
          <TypePicker types={types} value={d.typeId} onChange={v => set({ typeId: v })} onCreated={onTypeCreated} fetch={fetch} disabled={saving} />
        </div>

        <div style={{ marginBottom: T.space.md }}>
          <div style={{ fontSize: T.type.sm, fontWeight: 600, color: P.dark, marginBottom: 6 }}>How it is made <span style={{ color: P.light, fontWeight: 400 }}>optional</span></div>
          <div role="group" aria-label="How it is made" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {RECIPE_KIND_OPTIONS.map(k => (
              <SelectChip key={k.value} small active={d.kind === k.value} disabled={saving} data-testid="recipe-kind-chip"
                onClick={() => set({ kind: d.kind === k.value ? null : k.value })}>{k.label}</SelectChip>
            ))}
          </div>
        </div>

        <Field label="Link" htmlFor={ids.link} optional help="A web page with the recipe (http:// or https://)." style={{ marginBottom: T.space.md }}>
          <Input id={ids.link} data-testid="recipe-link" type="url" inputMode="url" value={d.link} disabled={saving}
            onChange={e => set({ link: e.target.value })} />
        </Field>

        <Field label="Notes" htmlFor={ids.notes} optional help="Steps, ratios, what to aim for — kept exactly as you write them." style={{ marginBottom: T.space.md }}>
          <Textarea id={ids.notes} data-testid="recipe-notes" rows={8} value={d.notes} disabled={saving}
            onChange={e => set({ notes: e.target.value })} />
        </Field>

        <fieldset data-testid="recipe-lines" style={{ border: 'none', padding: 0, margin: `0 0 ${T.space.md}px` }}>
          <legend style={{ fontSize: T.type.sm, fontWeight: 600, color: P.dark, marginBottom: 6 }}>What goes in <span style={{ color: P.light, fontWeight: 400 }}>optional</span></legend>
          {d.lines.map((l, i) => (
            <div key={i} data-testid="recipe-line" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid ${P.cream}` }}>
              <input aria-label={`Line ${i + 1}: what`} data-testid="recipe-line-name" placeholder="what (garlic)" value={l.name} disabled={saving}
                onChange={e => setLine(i, { name: e.target.value })} style={cell(10)} />
              <input aria-label={`Line ${i + 1}: amount as written`} data-testid="recipe-line-amount" placeholder="as written (8 g, 2 cloves)" value={l.amount} disabled={saving}
                onChange={e => setLine(i, { amount: e.target.value })} style={cell(12)} />
              <input aria-label={`Line ${i + 1}: number`} data-testid="recipe-line-qty" inputMode="decimal" placeholder="8" value={l.qty} disabled={saving}
                onChange={e => setLine(i, { qty: e.target.value })} style={cell(4)} />
              <select aria-label={`Line ${i + 1}: unit`} data-testid="recipe-line-unit" value={l.unit} disabled={saving}
                onChange={e => setLine(i, { unit: e.target.value })} style={cell(5)}>
                <option value="">unit</option>
                {UNIT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: T.type.sm, color: P.mid, minHeight: T.tapMinHeight }}>
                <input type="checkbox" data-testid="recipe-line-end" checked={l.atTheEnd} disabled={saving}
                  onChange={e => setLine(i, { atTheEnd: e.target.checked })} />
                at the end
              </label>
              <button type="button" style={small} data-testid="recipe-line-remove" disabled={saving}
                onClick={() => set({ lines: d.lines.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          <button type="button" style={small} data-testid="recipe-line-add" disabled={saving}
            onClick={() => set({ lines: [...d.lines, { ...EMPTY_LINE }] })}>+ Add a line</button>
        </fieldset>

        <fieldset data-testid="recipe-keeps" style={{ border: 'none', padding: 0, margin: `0 0 ${T.space.md}px` }}>
          <legend style={{ fontSize: T.type.sm, fontWeight: 600, color: P.dark, marginBottom: 6 }}>How long, and where <span style={{ color: P.light, fontWeight: 400 }}>optional</span></legend>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <input aria-label="How many" data-testid="recipe-keeps-n" inputMode="numeric" placeholder="7" value={d.keepsN} disabled={saving}
              onChange={e => set({ keepsN: e.target.value })} style={cell(4)} />
            <select aria-label="Days, weeks or months" data-testid="recipe-keeps-unit" value={d.keepsUnit} disabled={saving}
              onChange={e => set({ keepsUnit: e.target.value })} style={cell(6)}>
              {Object.entries(KEEPS_UNIT_WORDS).map(([v, w]) => <option key={v} value={v}>{w[1]}</option>)}
            </select>
            <select aria-label="Where" data-testid="recipe-keeps-kind" value={d.keepsKind} disabled={saving}
              onChange={e => set({ keepsKind: e.target.value })} style={cell(8)}>
              <option value="">where</option>
              {RECIPE_STORAGE_KINDS.map(k => <option key={k} value={k}>{STORAGE_KIND_WORDS[k]}</option>)}
            </select>
          </div>
        </fieldset>

        <fieldset data-testid="recipe-vessel" style={{ border: 'none', padding: 0, margin: `0 0 ${T.space.md}px` }}>
          <legend style={{ fontSize: T.type.sm, fontWeight: 600, color: P.dark, marginBottom: 6 }}>Made in <span style={{ color: P.light, fontWeight: 400 }}>optional — the jar or pot it goes in</span></legend>
          <Containers prefix="vessel" d={d} set={set} saving={saving} count />
        </fieldset>

        <fieldset data-testid="recipe-bottle" style={{ border: 'none', padding: 0, margin: `0 0 ${T.space.md}px` }}>
          <legend style={{ fontSize: T.type.sm, fontWeight: 600, color: P.dark, marginBottom: 6 }}>Put up in <span style={{ color: P.light, fontWeight: 400 }}>optional — the bottles or jars it ends in</span></legend>
          <Containers prefix="bottle" d={d} set={set} saving={saving} />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: T.type.sm, color: P.mid, minHeight: T.tapMinHeight }}>
            <input type="checkbox" data-testid="recipe-bottle-cooked" checked={d.bottleCooked} disabled={saving}
              onChange={e => set({ bottleCooked: e.target.checked })} />
            Cooked after blending
          </label>
          <div style={{ marginTop: 6 }}>
            <input aria-label="What it makes, as written" data-testid="recipe-made-text" placeholder="makes (as written) — e.g. 228 g, one bottle" value={d.madeText}
              disabled={saving} maxLength={500} onChange={e => set({ madeText: e.target.value })} style={cell(20)} />
          </div>
        </fieldset>

        {err && <div role="alert" data-alarm-ink-exempt="error" data-testid="recipe-sheet-error" style={{ color: P.terra, fontSize: T.type.sm, fontWeight: 600, marginBottom: 8 }}>{err}</div>}
      </div>
      <div data-testid="recipe-sheet-footer" style={{ position: 'sticky', bottom: 0, background: P.white, padding: `${T.space.sm}px 18px`, borderTop: `1px solid ${P.border}` }}>
        <Button data-testid="recipe-save" variant="primary" loading={saving} loadingLabel="Saving…" onClick={save} style={{ width: '100%' }}>
          {editing ? 'Save changes' : 'Save recipe'}
        </Button>
      </div>
    </Sheet>
  )
}

function cell(em) {
  return { minHeight: T.tapMinHeight, width: `${em}em`, maxWidth: '100%', padding: '6px 8px', border: `1px solid ${P.border}`,
    borderRadius: T.radiusButton, fontFamily: 'inherit', fontSize: T.type.sm, background: P.white }
}

function Containers({ prefix, d, set, saving, count = false }) {
  const f = (k) => `${prefix}${k}`
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
      <input aria-label={`${prefix === 'vessel' ? 'Jar' : 'Bottle'} name`} data-testid={`recipe-${prefix}-label`}
        placeholder={prefix === 'vessel' ? 'quart jar' : '5 oz woozy'} value={d[f('Label')]} disabled={saving} maxLength={120}
        onChange={e => set({ [f('Label')]: e.target.value })} style={cell(10)} />
      <input aria-label={`${prefix === 'vessel' ? 'Jar' : 'Bottle'} size`} data-testid={`recipe-${prefix}-size`} inputMode="decimal"
        placeholder="size" value={d[f('Size')]} disabled={saving} onChange={e => set({ [f('Size')]: e.target.value })} style={cell(4)} />
      <select aria-label={`${prefix === 'vessel' ? 'Jar' : 'Bottle'} size unit`} data-testid={`recipe-${prefix}-unit`} value={d[f('Unit')]} disabled={saving}
        onChange={e => set({ [f('Unit')]: e.target.value })} style={cell(5)}>
        <option value="">unit</option>
        {UNIT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {count && (
        <input aria-label="How many jars" data-testid="recipe-vessel-count" inputMode="numeric" placeholder="how many" value={d.vesselCount}
          disabled={saving} onChange={e => set({ vesselCount: e.target.value })} style={cell(5)} />
      )}
    </div>
  )
}
