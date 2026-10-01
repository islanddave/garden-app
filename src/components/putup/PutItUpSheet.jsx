// src/components/putup/PutItUpSheet.jsx
// Put-Up release 1b (V4 §2.4 "Put it up", §6.3–§6.7) — the missing link between a batch and its jars.
// One sheet, one atomic keyed write, repeatable ("More to put up later") or final ("Put it up and
// finish", the default and the primary).
//
// WHAT IT ASKS (the Jen rule, V4 §6.3 — required at open: 2, what it is now and row 1's place):
//   · When — Today · Yesterday · Earlier… · Not sure. Today is chosen at open on every batch (Put-Up UX
//     pass R1, D12) and any other answer is one tap. The resolved date is shown in words before Save.
//   · What it is now — one method tap from the kind's chips (Appendix B) + More….
//   · Rows — "2 × 8 oz woozy · Fridge": count (48 px − / +), container, place. Row 1's place is the
//     other required answer; rows 2..N copy container and place from the row above, shown in words.
//     Behind one disclosure per row: name, added at the end, Raw · In oil, texture, pH, discard by.
//   · Once per sitting, behind More: added at the end to every jar, "Made ___ g in all", Next time….
// Every row's discard-by is previewed (role=status) grouped by date and words, from the same engine
// module the server uses (putItUp.js previewDiscard).
//
// THE WRITE: POST /api/kitchen-batches/:id/put-up with putItUp.js putUpBody. The idempotency key is
// minted the first time the sheet is dirty, kept in the draft, and reused on every retry and reload
// (V4 §5.2, §6.5) — a retried Save after a dropped answer is a replay, never a second sitting.
//
// <Sheet armsBack>, size full, busy while writing; the draft (kitchen/sheetDraft.js, sheet 'putup',
// keyed per person per batch) survives Back; confirmOnDirty off; the reload gate is held while dirty or
// writing. Completion is shown IN PLACE by the host (onDone hands it the stub words), never a toast.
//
// ⚠ Record, never assess: pH is taken as typed through the shared PhReadingField and nothing reads it
// back into a decision; no readiness, no countdown, no verdict beside a date.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { setReloadBlocked } from '../../lib/reloadGate.js'
import { describeRefusal } from '../../lib/putUpErrors.js'
import Sheet from '../forms/Sheet.jsx'
import Button from '../forms/Button.jsx'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome, optionalMarkChrome, requiredMarkChrome, inputChrome, textareaChrome } from '../forms/formStyles.js'
import PhReadingField from './PhReadingField.jsx'
import { readSheetDraft, writeSheetDraft, clearSheetDraft } from '../kitchen/sheetDraft.js'
// Put-Up release 4: a batch made from a recipe puts up into the recipe's final container by default, and its
// discard-by preview takes the recipe rung (typed > recipe on its storage kind > the engine).
import { recipeFirstRow, recipePreview } from '../recipes/recipes.js'
import { useSheetDraftKey } from '../kitchen/useSheetDraftKey.js'
import { useFieldsClearOfFooter, scrollClearOfFooter } from '../kitchen/sheetScroll.js'
import { mintKey } from '../kitchen/idempotencyKey.js'
import LineAdder, { addFirstWords } from './LineAdder.jsx'
import { lineWords } from './lines.js'
import {
  PUT_IT_UP_TITLE, FINISH_CTA, LATER_CTA, PUT_IT_UP_SHEET, WHEN_CHIPS, estimateChips, preselectWhen,
  resolveWhen, METHOD_LABELS, ALL_PUT_UP_METHODS, methodChipsForKind, RAW_METHODS, TEXTURE_METHODS,
  PH_METHODS, TEXTURE_CHIPS, RAW_LABEL, RAW_HINT, IN_OIL_LABEL, DISCARD_LABELS, containerChoices, placeChips, newRow,
  rowSummary, rowCount, previewDiscard, groupPreviews, putUpBody, completionStub, effectiveRows, drawnJarIds,
} from './putItUp.js'

const FOOTER_PX = 132
const NEW_PLACE_KINDS = [
  { kind: 'fridge', label: 'Fridge' }, { kind: 'deep_freezer', label: 'Freezer' },
  { kind: 'pantry', label: 'Pantry shelf' }, { kind: 'cold_storage', label: 'Cellar' },
  { kind: 'other', label: 'Counter or other' },
]

export { mintKey }

const EMPTY_SITTING = { lines: [], madeG: '', mashG: '', nextTime: '' }

function isPlace(p) {
  return p === null || (!!p && typeof p === 'object' && typeof p.label === 'string' && typeof p.key === 'string')
}
// A line in a draft: a release-F line body (it carries its own key), or the 1b typed shape.
function isLine(l) {
  return !!l && typeof l === 'object'
    && ((typeof l.input_kind === 'string' && typeof l.idempotency_key === 'string') || (typeof l.label === 'string' && typeof l.key === 'string'))
}
function isRow(r) {
  return !!r && typeof r === 'object' && typeof r.count === 'string' && typeof r.name === 'string'
    && typeof r.ph === 'string' && isPlace(r.place) && Array.isArray(r.lines) && r.lines.every(isLine)
    && typeof r.inherit === 'boolean'
    && (r.cooked === undefined || typeof r.cooked === 'boolean') && (r.heat === undefined || typeof r.heat === 'string')
    && (r.container === null || (!!r.container && typeof r.container.label === 'string'))
    && !!r.discard && ['auto', 'date', 'none'].includes(r.discard.mode)
}
// The draft's shape, checked on read: a record that fails any arm is dropped, never half-restored.
export function isPutItUpDraft(d) {
  return !!d && typeof d === 'object' && !Array.isArray(d)
    && typeof d.key === 'string' && (d.chip === null || WHEN_CHIPS.some(c => c.id === d.chip))
    && (d.estimate === null || typeof d.estimate === 'string') && typeof d.pickedDate === 'string'
    && (d.method === null || typeof d.method === 'string')
    && Array.isArray(d.rows) && d.rows.length > 0 && d.rows.every(isRow)
    && !!d.sitting && Array.isArray(d.sitting.lines) && d.sitting.lines.every(isLine) && typeof d.sitting.madeG === 'string'
    && (d.sitting.mashG === undefined || typeof d.sitting.mashG === 'string')
    && typeof d.sitting.nextTime === 'string'
}

// The sheet's quiet actions are 48 px tall (Put-Up UX pass R1, F16): height only.
const quietLink = {
  display: 'inline-flex', alignItems: 'center', minHeight: T.buttonMinHeight, background: 'none', border: 'none',
  padding: '2px 8px 2px 0', cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: T.type.sm, fontWeight: 600,
}

// A REQUIRED single-select (V4 §6.4): role=radiogroup + aria-required, role=radio / aria-checked chips.
function RadioChips({ label, required, options, value, onChange, disabled, idPrefix, name }) {
  return (
    <div style={{ marginBottom: T.space.md }}>
      <span style={labelChrome} aria-hidden="true">
        {label}{required ? <span style={requiredMarkChrome}>*</span> : null}
      </span>
      <div role="radiogroup" aria-label={name ?? label} aria-required={required ? true : undefined}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {options.map(o => (
          <SelectChip key={o.value} touch active={value === o.value} disabled={disabled}
            role="radio" aria-checked={value === o.value} aria-pressed={undefined}
            data-testid={`${idPrefix}-${o.value}`} onClick={() => onChange(o.value)}>
            {o.label}
          </SelectChip>
        ))}
      </div>
    </div>
  )
}

// An OPTIONAL set (role=group + aria-pressed); a second tap un-chooses.
function ToggleChips({ label, options, value, onChange, disabled, idPrefix, hint }) {
  return (
    <div style={{ marginBottom: T.space.sm }}>
      <span style={labelChrome} aria-hidden="true">{label}<span style={optionalMarkChrome}>optional</span></span>
      <div role="group" aria-label={label} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {options.map(o => (
          <SelectChip key={o.value} touch active={value === o.value} disabled={disabled}
            data-testid={`${idPrefix}-${o.value}`} onClick={() => onChange(value === o.value ? null : o.value)}>
            {o.label}
          </SelectChip>
        ))}
      </div>
      {hint && <div style={{ marginTop: 4, color: P.light, fontSize: '0.74rem' }}>{hint}</div>}
    </div>
  )
}

// Lines added at the end (to one row's jars, or to every jar of the sitting) — release F: through the
// same line search as What went in (06 §3.6, HS-I3: a pick, a planting, a draw such as "8 g from the
// frozen reaper bag", or typed), taking form (fresh or cooked, per Dave), brand, note and listed heat.
// Each is a whole keyed line body; the sheet sends them with the sitting in its one write.
//
// `guard` (Put-Up UX pass R1, D2 — the unadded-line guard): { pending, stop, onPending, footerRef }. A name
// typed into the adder and not added is not a line, and neither commit would send it. The adder reports
// that name (`onPending`); a commit that stopped for it bumps `stop`, which puts the cursor back in the
// adder's name field under one line saying why.
function AddedLines({ lines, onChange, disabled, idPrefix, label, batchLines, excludeJarIds, guard }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef(null)
  const stopLineRef = useRef(null)
  const { pending = null, stop = 0, onPending, footerRef } = guard ?? {}
  // The stop, made visible. It runs once the line above the adder is on the page: the cursor goes to the
  // adder's name field (the first input here), the line is brought into view when the field landed at the
  // very top, and the field is kept clear of the pinned footer when it landed at the bottom.
  useEffect(() => {
    if (!stop) return
    const name = boxRef.current?.querySelector('input')
    if (!name) return
    name.focus()
    stopLineRef.current?.scrollIntoView?.({ block: 'nearest' })
    scrollClearOfFooter(name, footerRef?.current)
  }, [stop, footerRef])
  return (
    <div ref={boxRef} data-testid={`${idPrefix}-lines`} style={{ marginBottom: T.space.sm }}>
      <span style={labelChrome} aria-hidden="true">{label}<span style={optionalMarkChrome}>optional</span></span>
      {lines.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '0 0 6px', padding: 0 }}>
          {lines.map((l, i) => (
            <li key={`${l.idempotency_key ?? l.key ?? i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, color: P.dark, fontSize: T.type.sm }}>
              <span style={{ flex: 1 }} data-testid={`${idPrefix}-line`}>{lineWords(l.input_kind ? l : { label: l.label, qty: l.qty || null, qty_unit: l.qty ? l.unit : null })}</span>
              <button type="button" disabled={disabled} aria-label={`Take out ${l.label ?? 'that'}`}
                onClick={() => onChange(lines.filter((_, j) => j !== i))}
                style={{ minWidth: 48, minHeight: 48, background: 'none', border: 'none', color: P.light, cursor: 'pointer', fontFamily: 'inherit' }}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <>
          {/* Said directly above the field the cursor was just put in: under the adder it would be off
              screen with the keyboard up, and the sheet's own error line is a screen below. */}
          {stop > 0 && pending && (
            <div ref={stopLineRef} role="alert" data-testid={`${idPrefix}-add-first`}
              style={{ margin: '0 0 6px', color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>
              {addFirstWords(pending)}
            </div>
          )}
          <LineAdder lines={batchLines} idPrefix={`${idPrefix}-add`} disabled={disabled} forms={['fresh', 'cooked']}
            label="What was added?" addLabel="Add it" pinnable={false} excludeJarIds={excludeJarIds} pantryHits={false}
            onPendingChange={onPending}
            onAdd={async (body) => { onChange([...lines, body]); setOpen(false); return true }} />
        </>
      ) : (
        <button type="button" disabled={disabled} data-testid={`${idPrefix}-open`} onClick={() => setOpen(true)}
          style={{ ...quietLink, minHeight: 48 }}>+ Add something</button>
      )}
    </div>
  )
}

function PlacePicker({ chips, value, onChange, disabled, idPrefix, required, rowName }) {
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState(null)
  const options = [...chips]
  if (value && !options.some(c => c.key === value.key)) options.push(value)
  return (
    <div>
      <RadioChips label="Where is it going?" name={`Where is ${rowName} going?`} required={required}
        options={options.map(c => ({ value: c.key, label: c.label }))} value={value?.key ?? null}
        onChange={k => onChange(options.find(c => c.key === k) ?? null)} disabled={disabled} idPrefix={idPrefix} />
      {!adding ? (
        <button type="button" style={{ ...quietLink, marginTop: -8 }} disabled={disabled}
          data-testid={`${idPrefix}-new`} onClick={() => setAdding(true)}>＋ Somewhere else</button>
      ) : (
        <div data-testid={`${idPrefix}-new-editor`} style={{ marginBottom: T.space.sm }}>
          <input type="text" aria-label="Name of the place" value={label} maxLength={60} disabled={disabled}
            data-testid={`${idPrefix}-new-label`} placeholder="e.g. Garage fridge" onChange={e => setLabel(e.target.value)}
            style={{ ...inputChrome(false), marginBottom: 8, scrollMarginBottom: FOOTER_PX }} />
          <div role="radiogroup" aria-label="What kind of place?" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {NEW_PLACE_KINDS.map(k => (
              <SelectChip key={k.kind} touch active={kind === k.kind} disabled={disabled} role="radio"
                aria-checked={kind === k.kind} aria-pressed={undefined} data-testid={`${idPrefix}-new-kind-${k.kind}`}
                onClick={() => setKind(k.kind)}>{k.label}</SelectChip>
            ))}
          </div>
          <button type="button" disabled={disabled || !label.trim() || !kind} data-testid={`${idPrefix}-new-use`}
            onClick={() => {
              const l = label.trim()
              onChange({ key: `new:${kind}:${l.toLowerCase()}`, id: null, label: l, kind })
              setAdding(false); setLabel(''); setKind(null)
            }} style={quietLink}>Use this place</button>
          <button type="button" disabled={disabled} onClick={() => setAdding(false)}
            style={{ ...quietLink, color: P.light, fontWeight: 400 }}>Cancel</button>
        </div>
      )}
    </div>
  )
}

// `row` is the row as stored (it may inherit); `shown` is the same row with the inherited container
// and place resolved, which is what every word on screen describes.
function RowEditorBlock({ row, shown, index, rows, method, batch, places, containers, open, onToggle, onChange, onRemove, onKeepDrying, disabled, previews, batchLines, excludeJarIds, guard }) {
  const n = index + 1
  const name = row.name.trim() || batch.label
  const rowName = `row ${n}`
  const count = rowCount(row)
  const sameAsAbove = index > 0 && row.inherit
  const set = (patch) => onChange({ ...row, ...patch })
  const summary = rowSummary(shown)
  return (
    <fieldset role="group" aria-label={`Row ${n} — ${summary || name}`} data-testid={`putup-row-${index}`}
      style={{ border: `1px solid ${P.border}`, borderRadius: T.radiusBadge, padding: '10px 12px', margin: `0 0 ${T.space.sm}px` }}>
      {open && (
        // The sticky row header: which row is being edited, one line.
        <div data-testid={`putup-row-${index}-header`} style={{ position: 'sticky', top: 0, zIndex: 1, background: P.white,
          padding: '4px 0', color: P.mid, fontSize: '0.78rem', fontWeight: 700 }}>
          Row {n}: {name}
        </div>
      )}
      <div data-testid={`putup-row-${index}-summary`} style={{ color: P.dark, fontSize: T.type.sm, fontWeight: 600, marginBottom: 6 }}>
        {summary || `Row ${n}`}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: T.space.sm }}>
        <button type="button" aria-label={`One fewer — ${name}`} aria-disabled={count <= 1 ? true : undefined}
          data-testid={`putup-row-${index}-minus`} disabled={disabled}
          onClick={() => { if (count > 1) set({ count: String(count - 1) }) }}
          style={{ width: 48, height: 48, border: `1px solid ${P.border}`, borderRadius: T.radiusButton, background: P.white,
            color: count <= 1 ? P.light : P.dark, fontSize: '1.2rem', cursor: count <= 1 ? 'default' : 'pointer', fontFamily: 'inherit' }}>−</button>
        <input type="text" inputMode="numeric" aria-label={`How many — ${name}`} data-testid={`putup-row-${index}-count`}
          value={row.count} disabled={disabled} onChange={e => set({ count: e.target.value.replace(/[^0-9]/g, '') })}
          style={{ ...inputChrome(false), width: 64, minHeight: 44, textAlign: 'center', scrollMarginBottom: FOOTER_PX }} />
        <button type="button" aria-label={`One more — ${name}`} data-testid={`putup-row-${index}-plus`} disabled={disabled}
          onClick={() => set({ count: String(count + 1) })}
          style={{ width: 48, height: 48, border: `1px solid ${P.border}`, borderRadius: T.radiusButton, background: P.white,
            color: P.dark, fontSize: '1.2rem', cursor: 'pointer', fontFamily: 'inherit' }}>+</button>
      </div>

      {sameAsAbove ? (
        <div style={{ marginBottom: T.space.sm, color: P.mid, fontSize: '0.82rem' }}>
          <span data-testid={`putup-row-${index}-same`}>
            {[shown.container?.label, shown.place?.label].filter(Boolean).join(' · ') || 'Same'} — same as the row above
          </span>
          <button type="button" style={{ ...quietLink, marginLeft: 6 }} disabled={disabled}
            data-testid={`putup-row-${index}-change`}
            onClick={() => set({ inherit: false, container: shown.container, place: shown.place })}>Change</button>
        </div>
      ) : (
        <>
          <ToggleChips label="Size of each container" options={containers.map(c => ({ value: c.label, label: c.label }))}
            value={row.container?.label ?? null} disabled={disabled} idPrefix={`putup-row-${index}-container`}
            onChange={v => set({ container: v ? containers.find(c => c.label === v) ?? null : null })} />
          <PlacePicker chips={places} value={row.place} disabled={disabled} idPrefix={`putup-row-${index}-place`}
            required={index === 0} rowName={rowName} onChange={p => set({ place: p })} />
        </>
      )}

      <button type="button" aria-expanded={open} data-testid={`putup-row-${index}-more`} disabled={disabled}
        onClick={onToggle} style={quietLink}>
        {open ? '− Less about this row' : '+ Name, added at the end, Raw/In oil, pH…'}
      </button>
      {open && (
        <div data-testid={`putup-row-${index}-details`} style={{ marginTop: 6 }}>
          <label htmlFor={`putup-row-${index}-name`} style={labelChrome}>Name<span style={optionalMarkChrome}>optional</span></label>
          <input id={`putup-row-${index}-name`} type="text" data-testid={`putup-row-${index}-name`} value={row.name}
            placeholder={batch.label} maxLength={120} disabled={disabled} onChange={e => set({ name: e.target.value })}
            style={{ ...inputChrome(false), marginBottom: T.space.sm, scrollMarginBottom: FOOTER_PX }} />
          <AddedLines label="Added at the end" lines={row.lines} disabled={disabled} idPrefix={`putup-row-${index}-added`}
            batchLines={batchLines} excludeJarIds={excludeJarIds} guard={guard} onChange={lines => set({ lines })} />
          {/* Release F (06 §3.6): cooked after blending is a RECORD — no date reads it. */}
          <div role="group" aria-label="Cooked after blending" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: T.space.sm }}>
            <SelectChip touch active={row.cooked === true} disabled={disabled} data-testid={`putup-row-${index}-cooked`}
              onClick={() => set({ cooked: row.cooked !== true })}>Cooked after blending</SelectChip>
          </div>
          <div role="group" aria-label="Raw or in oil" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: T.space.sm }}>
            {RAW_METHODS.has(method) && (
              <SelectChip touch active={row.isRaw} disabled={disabled} data-testid={`putup-row-${index}-raw`}
                title={RAW_HINT} onClick={() => set({ isRaw: !row.isRaw })}>{RAW_LABEL}</SelectChip>
            )}
            <SelectChip touch active={row.inOil} disabled={disabled} data-testid={`putup-row-${index}-inoil`}
              onClick={() => set({ inOil: !row.inOil })}>{IN_OIL_LABEL}</SelectChip>
          </div>
          {RAW_METHODS.has(method) && (
            <div style={{ marginTop: -4, marginBottom: T.space.sm, color: P.light, fontSize: '0.74rem' }}>Raw: {RAW_HINT.toLowerCase()}.</div>
          )}
          {TEXTURE_METHODS.has(method) && (
            <ToggleChips label="How dry?" options={TEXTURE_CHIPS} value={row.texture} disabled={disabled}
              idPrefix={`putup-row-${index}-texture`} onChange={v => set({ texture: v })} />
          )}
          {/* V4 engine rule e: "Still soft" on a Dry batch also offers to stop here — the sheet closes, nothing
              is put up, and the draft keeps everything for when it is dry. */}
          {TEXTURE_METHODS.has(method) && row.texture === 'still_soft' && batch.kind === 'dehydrate' && (
            <button type="button" data-testid={`putup-row-${index}-keep-drying`} disabled={disabled} onClick={onKeepDrying}
              style={{ ...quietLink, marginBottom: T.space.sm }}>Not yet — keep drying</button>
          )}
          {PH_METHODS.has(method) && (
            <div style={{ marginBottom: T.space.sm }}>
              <PhReadingField value={row.ph} onChange={v => set({ ph: v })} disabled={disabled}
                idPrefix={`putup-row-${index}-ph`} inputStyle={{ scrollMarginBottom: FOOTER_PX }} />
            </div>
          )}
          <div style={{ marginBottom: T.space.sm }}>
            <label htmlFor={`putup-row-${index}-heat`} style={labelChrome}>Heat, if you know it (SHU)<span style={optionalMarkChrome}>optional</span></label>
            <input id={`putup-row-${index}-heat`} type="text" data-testid={`putup-row-${index}-heat`} value={row.heat ?? ''} placeholder="e.g. 1700–5300"
              disabled={disabled} onChange={e => set({ heat: e.target.value })}
              style={{ ...inputChrome(false), width: 180, scrollMarginBottom: FOOTER_PX }} />
            <div style={{ marginTop: 4, color: P.light, fontSize: '0.74rem' }}>Or work it out from the put-up once it is saved.</div>
          </div>
          {/* The chips' words are the one set every surface that asks this uses (putItUp DISCARD_LABELS). */}
          <ToggleChips label="Discard by" disabled={disabled} idPrefix={`putup-row-${index}-discard`}
            options={[{ value: 'date', label: DISCARD_LABELS.date }, { value: 'none', label: DISCARD_LABELS.none }]}
            value={row.discard.mode === 'auto' ? null : row.discard.mode}
            onChange={v => set({ discard: { mode: v ?? 'auto', date: v === 'date' ? row.discard.date : '' } })} />
          {row.discard.mode === 'date' && (
            // `-discard-day`, not `-discard-date`: that id is already the "From the label" chip's (ToggleChips
            // `${idPrefix}-${value}`), and two nodes on one testid made the date field unaddressable.
            <input type="date" aria-label={`Discard by — ${name}`} data-testid={`putup-row-${index}-discard-day`}
              value={row.discard.date} disabled={disabled} onChange={e => set({ discard: { mode: 'date', date: e.target.value } })}
              style={{ ...inputChrome(false), maxWidth: 220, marginBottom: T.space.sm, scrollMarginBottom: FOOTER_PX }} />
          )}
          {previews?.[index] && (
            <div data-testid={`putup-row-${index}-preview`} style={{ color: P.mid, fontSize: '0.78rem', marginBottom: 6 }}>
              {previews[index].words}
            </div>
          )}
          {rows.length > 1 && (
            <button type="button" aria-label={`Remove row ${n} — ${name}`} data-testid={`putup-row-${index}-remove`}
              disabled={disabled} onClick={onRemove}
              style={{ minWidth: 48, minHeight: 48, background: 'none', border: 'none', color: P.terra, cursor: 'pointer',
                fontFamily: 'inherit', fontSize: T.type.sm, padding: '0 4px' }}>Remove this row</button>
          )}
        </div>
      )}
    </fieldset>
  )
}

// `lines` (release F): the batch's live lines, for the additions' unit preselect. Optional — the card's
// door has no lines in hand and the additions then preselect g.
export default function PutItUpSheet({ open, batch, lines = [], onClose, onDone, onChanged, now }) {
  if (!open || !batch) return null
  // Keyed on the batch so switching from one crock straight to another never carries a row across.
  return <PutItUpOpen key={batch.id} batch={batch} lines={lines} onClose={onClose} onDone={onDone} onChanged={onChanged} now={now} />
}

function PutItUpOpen({ batch, lines: batchLines, onClose, onDone, onChanged, now }) {
  const { fetch } = useApiFetch()
  const nowDate = useMemo(() => new Date(now ?? Date.now()), [now])
  const draftKey = useSheetDraftKey(PUT_IT_UP_SHEET, batch.id)
  const preChip = preselectWhen(batch, nowDate)
  const [initial] = useState(() => readSheetDraft(draftKey, PUT_IT_UP_SHEET, isPutItUpDraft) ?? {
    key: '', chip: preChip, estimate: null, pickedDate: '', method: null, rows: [recipeFirstRow(batch.recipe)], sitting: EMPTY_SITTING,
  })
  const [key, setKey] = useState(initial.key)
  // A draft stored before When started on Today can hold `chip: null` (nothing chosen yet). It restores to
  // Today like any other open — never to a When nobody asked for and Save then refuses.
  const [chip, setChip] = useState(initial.chip ?? preChip)
  const [estimate, setEstimate] = useState(initial.estimate)
  const [pickedDate, setPickedDate] = useState(initial.pickedDate)
  const [method, setMethod] = useState(initial.method)
  const [rows, setRows] = useState(initial.rows)
  const [sitting, setSitting] = useState(initial.sitting)
  const [openRow, setOpenRow] = useState(null)
  const [moreMethods, setMoreMethods] = useState(false)
  const [sittingOpen, setSittingOpen] = useState(initial.sitting.lines.length > 0 || !!initial.sitting.madeG || !!initial.sitting.nextTime)
  const [places, setPlaces] = useState(null)
  const [pastContainers, setPastContainers] = useState([])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  // contract-F §2: a new sitting on a finished batch is refused with the server's words and a door
  // (`reopen: true`), never a bare 409. The door reopens through the shipped route; the draft and its
  // key are untouched, so the next Save is the same sitting.
  const [reopenDoor, setReopenDoor] = useState(false)
  // The unadded-line guard (D2). `pendings`: the name each embedded adder holds and has not added, by adder
  // (`putup-row-N-added`, `putup-sitting-added`). `stop`: the adder a commit last stopped for, and how many
  // times (a count, so a second tap puts the cursor back there again).
  const [pendings, setPendings] = useState({})
  const [stop, setStop] = useState(null)
  const writingRef = useRef(false)
  const footerRef = useRef(null)
  const keepClear = useFieldsClearOfFooter(footerRef)
  const nextTimeId = `putup-nexttime-${useId()}`
  const madeId = `putup-made-${useId()}`

  useEffect(() => {
    let alive = true
    Promise.resolve()
      .then(() => fetch('/api/storage-locations'))
      .then(r => { if (alive) setPlaces(Array.isArray(r) ? r : []) })
      .catch(() => { if (alive) setPlaces([]) })
    return () => { alive = false }
  }, [fetch])

  // The household's own past container labels, from the jars this batch already made. The list read
  // is not repeated for this: it is optional vocabulary, and the presets cover the first sitting.
  useEffect(() => {
    const labels = (batch.outputs ?? []).map(o => o?.container_label).filter(Boolean)
    if (labels.length) setPastContainers(labels)
  }, [batch.outputs])

  const chips = useMemo(() => placeChips(places ?? []), [places])
  const containers = useMemo(() => containerChoices(pastContainers), [pastContainers])

  const dirty = chip !== preChip || estimate != null || pickedDate !== '' || method != null
    || rows.length > 1 || JSON.stringify(rows[0]) !== JSON.stringify(recipeFirstRow(batch.recipe))
    || sitting.lines.length > 0 || sitting.madeG !== '' || (sitting.mashG ?? '') !== '' || sitting.nextTime !== ''

  // The key is minted when the sheet first becomes dirty and never changes afterwards (V4 §6.5).
  useEffect(() => { if (dirty && !key) setKey(mintKey()) }, [dirty, key])

  useEffect(() => {
    if (!draftKey) return
    if (dirty) writeSheetDraft(draftKey, PUT_IT_UP_SHEET, { key, chip, estimate, pickedDate, method, rows, sitting })
    else clearSheetDraft(draftKey)
  }, [draftKey, dirty, key, chip, estimate, pickedDate, method, rows, sitting])

  const holdReload = dirty || saving
  const gateKey = `putup-sheet:${useId()}`
  useEffect(() => {
    setReloadBlocked(gateKey, holdReload)
    return () => setReloadBlocked(gateKey, false)
  }, [gateKey, holdReload])

  const whenRes = chip ? resolveWhen({ chip, estimate, pickedDate, batch, now: nowDate }) : null
  // The preview counts from the day the server will store (Not sure's anchor), never from the wire value.
  const when = whenRes?.anchor ?? whenRes?.when ?? null
  const shownRows = effectiveRows(rows)
  const previews = shownRows.map(r => (method ? recipePreview({ row: r, when, recipe: batch.recipe, now: nowDate }) : null)
    ?? previewDiscard({ row: r, method, when, now: nowDate }))
  const previewGroups = groupPreviews(previews)
  const { chips: methodChips, more: hasMore } = methodChipsForKind(batch.kind)
  const shownMethods = moreMethods ? ALL_PUT_UP_METHODS : methodChips
  const methodOptions = [...shownMethods, ...(method && !shownMethods.includes(method) ? [method] : [])]
    .map(m => ({ value: m, label: METHOD_LABELS[m] ?? m }))

  const updateRow = (i, next) => setRows(rs => rs.map((r, j) => (j === i ? next : r)))

  // An adder reports null when its name is cleared, when its Add landed, and when it goes away (Put it
  // up's adder unmounts after each Add, and with its row's disclosure): the stop it caused ends with it.
  const reportPending = useCallback((id, text) => {
    setPendings(p => {
      if ((p[id] ?? null) === (text ?? null)) return p
      const next = { ...p }
      if (text) next[id] = text; else delete next[id]
      return next
    })
    if (!text) setStop(s => (s?.id === id ? null : s))
  }, [])
  const adderGuard = (id) => ({
    pending: pendings[id] ?? null, stop: stop?.id === id ? stop.n : 0, onPending: (text) => reportPending(id, text), footerRef,
  })
  // The first adder, top to bottom, still holding a name: the rows in order, then the sitting's.
  const heldAdder = [...rows.map((_, i) => `putup-row-${i}-added`), 'putup-sitting-added'].find(id => pendings[id]) ?? null

  const save = useCallback(async (finish) => {
    if (writingRef.current) return
    // A name still sitting in an adder is not a line yet, and this body would leave it out. Both commits
    // stop before anything is sent; the adder takes the cursor back, under the line that says why.
    if (heldAdder) { setStop(s => ({ id: heldAdder, n: (s?.n ?? 0) + 1 })); setErr(null); return }
    const w = chip ? resolveWhen({ chip, estimate, pickedDate, batch, now: nowDate }) : null
    if (!w || w.error) { setErr(w?.error ?? 'When was it put up? Pick one — or Not sure.'); return }
    const useKey = key || mintKey()
    if (!key) setKey(useKey)
    const res = putUpBody({ key: useKey, when: w.when, method, rows, sittingLines: sitting.lines, madeG: sitting.madeG, mashG: sitting.mashG ?? '',
      nextTime: sitting.nextTime, finish, batch })
    if (res.error) {
      setErr(res.error)
      if (res.row != null) setOpenRow(res.field === 'discard' ? res.row : openRow)
      return
    }
    writingRef.current = true
    setSaving(true); setErr(null)
    try {
      const answer = await fetch(`/api/kitchen-batches/${batch.id}/put-up`, { method: 'POST', body: JSON.stringify(res.body) })
      clearSheetDraft(draftKey)
      const jars = Array.isArray(answer?.jars) ? answer.jars : (Array.isArray(answer?.outputs) ? answer.outputs : [])
      const stub = completionStub({ batch, rows, jars, now: nowDate })
      writingRef.current = false
      setSaving(false)
      onClose?.()
      onDone?.({ finish, stub, answer, batchId: batch.id })
    } catch (e) {
      writingRef.current = false
      setSaving(false)
      const body = e?.body && typeof e.body === 'object' ? e.body : null
      if (body?.code === 'batch_closed' && body.reopen) {
        setReopenDoor(true)
        setErr(typeof body.error === 'string' && body.error.trim() ? body.error.trim() : 'This batch is finished. Reopen it to bottle more →')
        return
      }
      const r = describeRefusal(e)
      setErr(r ? r.text : "Couldn't put it up — try again. Everything you entered is still here.")
    }
  }, [batch, chip, draftKey, estimate, fetch, heldAdder, key, method, nowDate, onClose, onDone, openRow, pickedDate, rows, sitting])

  const estimates = estimateChips(nowDate)

  const reopen = useCallback(async () => {
    if (writingRef.current) return
    writingRef.current = true
    setSaving(true)
    try {
      await fetch(`/api/kitchen-batches/${batch.id}/reopen`, { method: 'POST', body: '{}' })
      setReopenDoor(false); setErr(null)
      onChanged?.()
    } catch {
      setErr("Couldn't reopen it — try again.")
    } finally {
      writingRef.current = false
      setSaving(false)
    }
  }, [batch.id, fetch, onChanged])

  return (
    <Sheet open onClose={onClose} title={PUT_IT_UP_TITLE} size="full" busy={saving} armsBack>
      {/* overflowAnchor none, here and on the footer: opening a row's "+ Name, added at the end…" jumped
          the sheet ~676px at 426×492 (the ferment walks) — Chrome's scroll anchoring compensating for the
          panel it had just opened, which put the row's first fields above the top edge and the pH field
          under the row's sticky header. Nothing on this sheet loads in above the reader, so anchoring
          has nothing to keep still here. */}
      <div data-testid="putup-sheet" data-batch-id={batch.id} onFocus={keepClear}
        style={{ padding: '0 18px', scrollPaddingTop: 32, scrollPaddingBottom: FOOTER_PX, overflowAnchor: 'none' }}>
        <p data-testid="putup-batch" style={{ margin: '0 0 10px', color: P.mid, fontSize: '0.86rem', fontWeight: 600 }}>{batch.label}</p>

        {/* The required mark follows the LIVE chip, not what the open preselected. */}
        <RadioChips label="When?" name="When was it put up?" required={!chip}
          options={WHEN_CHIPS.map(c => ({ value: c.id, label: c.label }))} value={chip} disabled={saving}
          idPrefix="putup-when" onChange={v => { setChip(v); if (v !== 'earlier') { setEstimate(null); setPickedDate('') } setErr(null) }} />
        {chip === 'earlier' && (
          <div style={{ marginTop: -8, marginBottom: T.space.md }}>
            <div role="radiogroup" aria-label="Roughly when?" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {estimates.map(c => (
                <SelectChip key={c.id} touch active={estimate === c.id} disabled={saving} role="radio"
                  aria-checked={estimate === c.id} aria-pressed={undefined} data-testid={`putup-when-${c.id}`}
                  onClick={() => { setEstimate(c.id); if (c.id !== 'pickdate') setPickedDate(''); setErr(null) }}>{c.label}</SelectChip>
              ))}
            </div>
            {estimate === 'pickdate' && (
              <input type="date" aria-label="The date it was put up" data-testid="putup-when-date" value={pickedDate}
                disabled={saving} onChange={e => { setPickedDate(e.target.value); setErr(null) }}
                style={{ ...inputChrome(false), maxWidth: 220, marginTop: 8, scrollMarginBottom: FOOTER_PX }} />
            )}
          </div>
        )}
        {whenRes?.words && !whenRes.error && (
          <div role="status" data-testid="putup-when-words" style={{ marginTop: -8, marginBottom: T.space.md, color: P.mid, fontSize: '0.78rem' }}>
            Put up {whenRes.words}
          </div>
        )}

        <RadioChips label="What is it now?" required options={methodOptions} value={method} disabled={saving}
          idPrefix="putup-method" onChange={v => { setMethod(v); setErr(null) }} />
        {hasMore && !moreMethods && (
          <button type="button" style={{ ...quietLink, marginTop: -8, marginBottom: 8 }} disabled={saving}
            data-testid="putup-method-more" onClick={() => setMoreMethods(true)}>More…</button>
        )}

        {rows.map((r, i) => (
          <RowEditorBlock key={i} row={r} shown={shownRows[i]} index={i} rows={rows} method={method} batch={batch} places={chips}
            containers={containers} open={openRow === i} disabled={saving} previews={previews}
            batchLines={batchLines} excludeJarIds={drawnJarIds(rows, sitting.lines)} guard={adderGuard(`putup-row-${i}-added`)}
            onToggle={() => setOpenRow(o => (o === i ? null : i))}
            onChange={next => { updateRow(i, next); setErr(null) }}
            onRemove={() => { setRows(rs => rs.filter((_, j) => j !== i)); setOpenRow(null) }}
            onKeepDrying={onClose} />
        ))}
        <button type="button" style={quietLink} disabled={saving} data-testid="putup-row-add"
          onClick={() => { setRows(rs => [...rs, newRow(rs[rs.length - 1])]); setOpenRow(null) }}>
          + Another row
        </button>

        <div style={{ margin: `${T.space.sm}px 0` }}>
          <button type="button" aria-expanded={sittingOpen} data-testid="putup-sitting-more" disabled={saving}
            onClick={() => setSittingOpen(o => !o)} style={quietLink}>
            {sittingOpen ? '− Less' : '+ More: added to every jar, how much in all, next time…'}
          </button>
          {sittingOpen && (
            <div data-testid="putup-sitting" style={{ marginTop: 6 }}>
              <AddedLines label="Added at the end to every jar" lines={sitting.lines} disabled={saving} idPrefix="putup-sitting-added"
                batchLines={batchLines} excludeJarIds={drawnJarIds(rows, sitting.lines)} guard={adderGuard('putup-sitting-added')}
                onChange={lines => setSitting(s => ({ ...s, lines }))} />
              {/* "Mash in ___ g" beside "Made ___ g in all" (Ferment; 06 §4 item 7). */}
              <div style={{ display: 'flex', gap: T.space.md, flexWrap: 'wrap' }}>
                <div>
                  <label htmlFor={madeId} style={labelChrome}>Made ___ g in all<span style={optionalMarkChrome}>optional</span></label>
                  <input id={madeId} type="text" inputMode="decimal" data-testid="putup-made" value={sitting.madeG} disabled={saving}
                    onChange={e => setSitting(s => ({ ...s, madeG: e.target.value }))}
                    style={{ ...inputChrome(false), width: 120, marginBottom: T.space.sm, scrollMarginBottom: FOOTER_PX }} />
                </div>
                {batch.kind === 'ferment' && (
                  <div>
                    <label htmlFor={`${madeId}-mash`} style={labelChrome}>Mash in ___ g<span style={optionalMarkChrome}>optional</span></label>
                    <input id={`${madeId}-mash`} type="text" inputMode="decimal" data-testid="putup-mash" value={sitting.mashG ?? ''} disabled={saving}
                      onChange={e => setSitting(s => ({ ...s, mashG: e.target.value }))}
                      style={{ ...inputChrome(false), width: 120, marginBottom: T.space.sm, scrollMarginBottom: FOOTER_PX }} />
                  </div>
                )}
              </div>
              <label htmlFor={nextTimeId} style={labelChrome}>Next time…<span style={optionalMarkChrome}>optional</span></label>
              <textarea id={nextTimeId} rows={2} data-testid="putup-nexttime" value={sitting.nextTime} disabled={saving}
                onChange={e => setSitting(s => ({ ...s, nextTime: e.target.value }))}
                style={{ ...textareaChrome(false), minHeight: 56, scrollMarginBottom: FOOTER_PX }} />
            </div>
          )}
        </div>

        {previewGroups.length > 0 && (
          <div role="status" data-testid="putup-preview" style={{ marginBottom: T.space.sm, color: P.mid, fontSize: '0.78rem' }}>
            {previewGroups.map(g => (
              <div key={g.words} data-testid="putup-preview-line">
                {rows.length > 1 ? `Row${g.rows.length > 1 ? 's' : ''} ${g.rows.join(', ')}: ` : ''}{g.words}
              </div>
            ))}
          </div>
        )}

        {err && (
          <div role="alert" data-testid="putup-error" style={{ marginBottom: T.space.sm, color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>{err}</div>
        )}
        {reopenDoor && (
          <button type="button" data-testid="putup-reopen" disabled={saving} onClick={reopen} style={{ ...quietLink, marginBottom: T.space.sm }}>
            Reopen it
          </button>
        )}
      </div>

      {/* Pinned, ONE row (Put-Up UX pass R1, D12): the filled primary, then the quieter "More to put up
          later" beside it, 12 px apart; it wraps underneath only when the two do not fit. Both are commits
          (the second saves the rows and leaves the batch going), so both stay in the pinned footer — side
          by side, never at equal weight (V4 §6.6). */}
      <div ref={footerRef} data-testid="putup-footer" style={{ position: 'sticky', bottom: 0, background: P.white,
        padding: `${T.space.sm}px 18px`, borderTop: `1px solid ${P.border}`, overflowAnchor: 'none',
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <Button data-testid="putup-finish" variant="primary" loading={saving} loadingLabel="Putting it up…"
          onClick={() => save(true)} style={{ flex: '1 1 auto' }}>
          {FINISH_CTA}
        </Button>
        <button type="button" data-testid="putup-later" disabled={saving} onClick={() => save(false)}
          style={{ ...quietLink, flex: '0 0 auto', justifyContent: 'center', minHeight: T.buttonMinHeight, padding: '2px 4px', fontWeight: 400 }}>
          {LATER_CTA}
        </button>
      </div>
    </Sheet>
  )
}
