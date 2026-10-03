// src/components/recipes/RecipeSheet.jsx
// Put-Up release 4 (V4 §2.6) — create or edit a recipe: name · what it makes (type) · link or notes ·
// optional lines (name + amount as written + "at the end") · optional "how long, and where" line — plus the
// process jar and the final container a make can span (Dave 2026-09-30) and the yield as written. Only the
// name is required. <Sheet armsBack>; the draft survives a dismiss (kitchen/sheetDraft.js, sheet 'recipe',
// id 'new' or the recipe's id); the create is keyed (one key per draft, reused on every retry).
//
// ⚠ Notes are his text VERBATIM (including his own target pH): sent exactly as typed, never trimmed inside,
// and shown here exactly as stored — the bold and italic of recipe detail are that surface's alone.
// Plain markup, existing primitives, no visual design (functionality first).
//
// Put-Up UX pass R1 — the sheet reads top to bottom, and both pickers say what they are for:
//   Name → What it makes (it groups the list) → Notes → Link → What goes in → How long, and where →
//   How it's made (the kind of batch Make this starts), directly above Made in → Put up in.
// A line is its name and the amount as he would write it; the exact number and unit sit behind
// "▸ exact amount", which opens by itself when the amount starts with a digit and is always open on a
// line that holds a number (recipes.js exactAmountOpens). "How long, and where" is a number, three unit
// chips and place chips built from the Lambda's six kinds — the stored one always among them
// (recipes.js keepsKindChips). Every chip is 48 px tall; there is no native checkbox.
// THE DRAFT'S SHAPE IS UNCHANGED: nothing that only opens or closes a part of the sheet is stored, so a
// draft written before this pass restores as it was written.
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
import { useFieldsClearOfFooter } from '../kitchen/sheetScroll.js'
import { mintKey } from '../kitchen/idempotencyKey.js'
import TypePicker from './TypePicker.jsx'
import {
  emptyDraft, draftFromRecipe, recipeBody, exactAmountOpens, keepsKindChips, RECIPE_KIND_OPTIONS, STORAGE_KIND_WORDS,
  KEEPS_UNIT_WORDS, KITCHEN_UNITS, EMPTY_LINE, TYPE_LABEL, TYPE_HELP, KIND_LABEL, KIND_HELP, LINE_NAME_LABEL,
  LINE_AMOUNT_LABEL, AT_THE_END_LABEL, EXACT_AMOUNT_CTA, KEEPS_LABEL, KEEPS_HELP, KEEPS_N_LABEL, MORE_PLACES_CTA, COOKED_LABEL,
} from './recipes.js'

export const RECIPE_SHEET = 'recipe'
const UNIT_OPTIONS = KITCHEN_UNITS.map(u => ({ value: u, label: u }))

export function isRecipeDraft(d) {
  return !!d && typeof d === 'object' && !Array.isArray(d) && typeof d.name === 'string'
    && typeof d.notes === 'string' && Array.isArray(d.lines) && (d.key === undefined || typeof d.key === 'string')
}

// The quiet text action, 48 px tall on Put-Up surfaces (UX pass R1).
const small = { minHeight: T.buttonMinHeight, padding: '4px 8px', background: 'none', border: 'none', color: P.green,
  fontFamily: 'inherit', fontSize: T.type.sm, fontWeight: 600, cursor: 'pointer' }
const heading = { fontSize: T.type.sm, fontWeight: 600, color: P.dark }
const optional = { color: P.light, fontWeight: 400 }
const helper = { fontSize: T.type.xs, color: P.light, margin: '2px 0 6px' }
const chipRow = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }

export default function RecipeSheet({ open, ...rest }) {
  if (!open) return null
  return <RecipeSheetOpen {...rest} />
}

// `usedTypeIds` (optional): the types this household's recipes already use — they lead the type chips.
function RecipeSheetOpen({ recipe = null, types = [], usedTypeIds = [], fetch, onClose, onSaved, onTypeCreated }) {
  const editing = !!recipe?.id
  const draftKey = useSheetDraftKey(RECIPE_SHEET, editing ? recipe.id : 'new')
  const [initial] = useState(() => readSheetDraft(draftKey, RECIPE_SHEET, isRecipeDraft) ?? (editing ? draftFromRecipe(recipe) : emptyDraft()))
  const [d, setD] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  // What is open on the sheet is the sheet's own, never the draft's: a line's exact amount once asked for
  // (one flag per line, kept in step with the lines), and the other place kinds.
  const [exactAsked, setExactAsked] = useState([])
  const [placesOpen, setPlacesOpen] = useState(false)
  const [unitPicked, setUnitPicked] = useState(false)
  const writingRef = useRef(false)
  const base = useRef(JSON.stringify(editing ? draftFromRecipe(recipe) : emptyDraft()))
  const linesRef = useRef(null)
  const placesRef = useRef(null)
  const focusNext = useRef(null)                       // { qty: line index } | { place: true } — after a part opens
  // The pinned Save covers the bottom of the sheet: a field that takes the cursor under it is scrolled clear,
  // and again when the keyboard resizes the viewport (kitchen/sheetScroll.js, as Put it up uses it).
  const footerRef = useRef(null)
  const keepClear = useFieldsClearOfFooter(footerRef)
  const ids = { name: `recipe-name-${useId()}`, link: `recipe-link-${useId()}`, notes: `recipe-notes-${useId()}`, keepsN: `recipe-keeps-n-${useId()}` }

  const set = (patch) => { setD(x => ({ ...x, ...patch })); setErr(null) }
  // A line edit keeps the line's stored copy (`_keep`): recipes.js lineBody decides from it whether the facts
  // this sheet does not edit (form, brand, role, note, heat, salt) still belong to the line — they do unless
  // its name, number or unit changed. Clearing it here dropped them on any edit, "at the end" included.
  const setLine = (i, patch) => set({ lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) })
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

  // A control that opens a part of the sheet leaves the screen when tapped; focus goes to what it opened.
  useEffect(() => {
    const next = focusNext.current
    if (!next) return
    focusNext.current = null
    if (next.qty != null) linesRef.current?.querySelectorAll('[data-testid="recipe-line"]')[next.qty]?.querySelector('[data-testid="recipe-line-qty"]')?.focus()
    else placesRef.current?.querySelector('[data-revealed="first"]')?.focus()
  })

  const askExact = (i) => {
    focusNext.current = { qty: i }
    setExactAsked(a => Array.from({ length: Math.max(a.length, i + 1) }, (_, j) => j === i || a[j] === true))
  }
  const removeLine = (i) => {
    setExactAsked(a => a.filter((_, j) => j !== i))
    set({ lines: d.lines.filter((_, j) => j !== i) })
  }
  const places = keepsKindChips({ value: d.keepsKind, stored: editing ? (recipe.keeps_storage_kind ?? '') : '', moreOpen: placesOpen })
  const firstRevealed = keepsKindChips({ value: d.keepsKind, stored: editing ? (recipe.keeps_storage_kind ?? '') : '' }).more[0]
  // The draft always holds a unit (days, until another is picked). On a line with nothing in it a lit unit
  // would read as an answer nobody gave, so the unit shows as chosen once the line has a number or a place,
  // or once a unit was tapped. What is stored and sent is the draft's, unchanged either way.
  const unitShown = unitPicked || String(d.keepsN ?? '').trim() !== '' || String(d.keepsKind ?? '') !== '' || d.keepsUnit !== emptyDraft().keepsUnit

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
      <div data-testid="recipe-sheet" onFocus={keepClear} style={{ padding: '0 18px 12px' }}>
        <Field label="Name" htmlFor={ids.name} required style={{ marginBottom: T.space.md }}>
          <Input id={ids.name} data-testid="recipe-name" value={d.name} maxLength={120} disabled={saving}
            onChange={e => set({ name: e.target.value })} />
        </Field>

        <div data-testid="recipe-type" style={{ marginBottom: T.space.md }}>
          <div style={heading}>{TYPE_LABEL} <span style={optional}>optional</span></div>
          <div data-testid="recipe-type-help" style={helper}>{TYPE_HELP}</div>
          <TypePicker types={types} usedIds={usedTypeIds} value={d.typeId} onChange={v => set({ typeId: v })} onCreated={onTypeCreated} fetch={fetch} disabled={saving} />
        </div>

        <Field label="Notes" htmlFor={ids.notes} optional help="Steps, ratios, what to aim for — kept exactly as you write them." style={{ marginBottom: T.space.md }}>
          <Textarea id={ids.notes} data-testid="recipe-notes" rows={8} value={d.notes} disabled={saving}
            onChange={e => set({ notes: e.target.value })} />
        </Field>

        <Field label="Link" htmlFor={ids.link} optional help="A web page with the recipe (http:// or https://)." style={{ marginBottom: T.space.md }}>
          <Input id={ids.link} data-testid="recipe-link" type="url" inputMode="url" value={d.link} disabled={saving}
            onChange={e => set({ link: e.target.value })} />
        </Field>

        <fieldset ref={linesRef} data-testid="recipe-lines" style={{ border: 'none', padding: 0, margin: `0 0 ${T.space.md}px` }}>
          <legend style={{ ...heading, marginBottom: 6 }}>What goes in <span style={optional}>optional</span></legend>
          {d.lines.map((l, i) => {
            const exact = exactAsked[i] === true || exactAmountOpens(l)
            return (
              <div key={i} data-testid="recipe-line" style={{ marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid ${P.cream}` }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <input aria-label={`Line ${i + 1}: name`} data-testid="recipe-line-name" placeholder={LINE_NAME_LABEL} value={l.name} disabled={saving}
                    onChange={e => setLine(i, { name: e.target.value })} style={{ ...cell(9), flex: '1 1 9em' }} />
                  <input aria-label={`Line ${i + 1}: amount as you'd write it`} data-testid="recipe-line-amount" placeholder={LINE_AMOUNT_LABEL} value={l.amount} disabled={saving}
                    onChange={e => setLine(i, { amount: e.target.value })} style={{ ...cell(13), flex: '1 1 13em' }} />
                </div>
                <div style={{ ...chipRow, marginTop: 8 }}>
                  <SelectChip small touch active={l.atTheEnd === true} disabled={saving} data-testid="recipe-line-end" aria-label={`Line ${i + 1}: ${AT_THE_END_LABEL}`}
                    onClick={() => setLine(i, { atTheEnd: !l.atTheEnd })}>{AT_THE_END_LABEL}</SelectChip>
                  {exact ? (
                    <>
                      <input aria-label={`Line ${i + 1}: number`} data-testid="recipe-line-qty" inputMode="decimal" placeholder="number" value={l.qty} disabled={saving}
                        onChange={e => setLine(i, { qty: e.target.value })} style={cell(5)} />
                      <select aria-label={`Line ${i + 1}: unit`} data-testid="recipe-line-unit" value={l.unit} disabled={saving}
                        onChange={e => setLine(i, { unit: e.target.value })} style={cell(5)}>
                        <option value="">unit</option>
                        {UNIT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </>
                  ) : (
                    <button type="button" style={small} data-testid="recipe-line-exact" aria-expanded="false" disabled={saving}
                      onClick={() => askExact(i)}>{EXACT_AMOUNT_CTA}</button>
                  )}
                  <button type="button" style={{ ...small, marginLeft: 'auto' }} data-testid="recipe-line-remove" disabled={saving}
                    onClick={() => removeLine(i)}>Remove</button>
                </div>
              </div>
            )
          })}
          <button type="button" style={small} data-testid="recipe-line-add" disabled={saving}
            onClick={() => set({ lines: [...d.lines, { ...EMPTY_LINE }] })}>+ Add a line</button>
        </fieldset>

        <fieldset data-testid="recipe-keeps" style={{ border: 'none', padding: 0, margin: `0 0 ${T.space.md}px` }}>
          <legend style={{ ...heading, marginBottom: 6 }}>{KEEPS_LABEL} <span style={optional}>optional — {KEEPS_HELP}</span></legend>
          <div style={{ ...chipRow, marginBottom: 8 }}>
            <label htmlFor={ids.keepsN} style={{ fontSize: T.type.sm, color: P.mid }}>{KEEPS_N_LABEL}</label>
            <input id={ids.keepsN} data-testid="recipe-keeps-n" inputMode="numeric" value={d.keepsN} disabled={saving}
              onChange={e => set({ keepsN: e.target.value })} style={cell(4)} />
            <div role="radiogroup" aria-label="Days, weeks or months" data-testid="recipe-keeps-unit" style={chipRow}>
              {Object.entries(KEEPS_UNIT_WORDS).map(([v, w]) => (
                <SelectChip key={v} small touch active={unitShown && d.keepsUnit === v} disabled={saving} role="radio" aria-checked={unitShown && d.keepsUnit === v}
                  aria-pressed={undefined} data-testid={`recipe-keeps-unit-${v}`} onClick={() => { setUnitPicked(true); set({ keepsUnit: v }) }}>{w[1]}</SelectChip>
              ))}
            </div>
          </div>
          <div ref={placesRef} role="group" aria-label="Where" data-testid="recipe-keeps-kind" style={chipRow}>
            {places.chips.map(k => (
              <SelectChip key={k} small touch active={d.keepsKind === k} disabled={saving} data-testid={`recipe-keeps-kind-${k}`}
                data-revealed={placesOpen && k === firstRevealed ? 'first' : undefined}
                onClick={() => set({ keepsKind: d.keepsKind === k ? '' : k })}>{STORAGE_KIND_WORDS[k]}</SelectChip>
            ))}
            {places.more.length > 0 && (
              <button type="button" style={small} data-testid="recipe-keeps-kind-more" aria-expanded="false" disabled={saving}
                onClick={() => { focusNext.current = { place: true }; setPlacesOpen(true) }}>{MORE_PLACES_CTA}</button>
            )}
          </div>
        </fieldset>

        <div data-testid="recipe-kind" style={{ marginBottom: T.space.md }}>
          <div style={heading}>{KIND_LABEL} <span style={optional}>optional</span></div>
          <div data-testid="recipe-kind-help" style={helper}>{KIND_HELP}</div>
          <div role="group" aria-label={KIND_LABEL} style={chipRow}>
            {RECIPE_KIND_OPTIONS.map(k => (
              <SelectChip key={k.value} small touch active={d.kind === k.value} disabled={saving} data-testid="recipe-kind-chip"
                onClick={() => set({ kind: d.kind === k.value ? null : k.value })}>{k.label}</SelectChip>
            ))}
          </div>
        </div>

        <fieldset data-testid="recipe-vessel" style={{ border: 'none', padding: 0, margin: `0 0 ${T.space.md}px` }}>
          <legend style={{ ...heading, marginBottom: 6 }}>Made in <span style={optional}>optional — the jar or pot it goes in</span></legend>
          <Containers prefix="vessel" d={d} set={set} saving={saving} count />
        </fieldset>

        <fieldset data-testid="recipe-bottle" style={{ border: 'none', padding: 0, margin: `0 0 ${T.space.md}px` }}>
          <legend style={{ ...heading, marginBottom: 6 }}>Put up in <span style={optional}>optional — the bottles or jars it ends in</span></legend>
          <Containers prefix="bottle" d={d} set={set} saving={saving} />
          <SelectChip small touch active={d.bottleCooked === true} disabled={saving} data-testid="recipe-bottle-cooked"
            onClick={() => set({ bottleCooked: !d.bottleCooked })}>{COOKED_LABEL}</SelectChip>
          <div style={{ marginTop: 6 }}>
            <input aria-label="What it makes, as written" data-testid="recipe-made-text" placeholder="makes (as written) — e.g. 228 g, one bottle" value={d.madeText}
              disabled={saving} maxLength={500} onChange={e => set({ madeText: e.target.value })} style={cell(20)} />
          </div>
        </fieldset>

        {err && <div role="alert" data-alarm-ink-exempt="error" data-testid="recipe-sheet-error" style={{ color: P.terra, fontSize: T.type.sm, fontWeight: 600, marginBottom: 8 }}>{err}</div>}
      </div>
      <div ref={footerRef} data-testid="recipe-sheet-footer" style={{ position: 'sticky', bottom: 0, background: P.white, padding: `${T.space.sm}px 18px`, borderTop: `1px solid ${P.border}` }}>
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
          disabled={saving} onChange={e => set({ vesselCount: e.target.value })} style={cell(7)} />
      )}
    </div>
  )
}
