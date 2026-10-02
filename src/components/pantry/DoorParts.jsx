// src/components/pantry/DoorParts.jsx
// Put-Up B′ release 2 — the chip rows Put something up and Walk a place share (V4 §6.4, Appendix B):
// the place chips, the method row (required: role=radiogroup + aria-required, role=radio chips) and the
// discard-by choice. Plain SelectChip touch chips (48 px, 8 px gaps); no new visual design.
// Put-Up UX pass R1: the methods' disclosure reads "Other ways…", a method chosen under other chips
// stays as one chip, and the discard choice takes its words from putItUp.DISCARD_LABELS.
// Put-Up R2a: the three things a method can put directly under its row — Raw · In oil (RawInOilChips, ONE
// part for both doors), How dry? (HowDry) and the canning reference line (CanningLine).
import React, { useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome, requiredMarkChrome, inputChrome } from '../forms/formStyles.js'
import { DISCARD_LABELS, RAW_METHODS, RAW_LABEL, RAW_HINT, IN_OIL_LABEL, TEXTURE_CHIPS } from '../putup/putItUp.js'
import { NEW_PLACE_KINDS } from '../putup/placeKinds.js'
import { AS_IS, methodLabel, OTHER_WAYS_LABEL, CANNING_LINE, HOW_DRY_LABEL, RAW_OR_IN_OIL_LABEL } from './putSomethingUp.js'

const row = { display: 'flex', flexWrap: 'wrap', gap: 8 }

// Appendix B's "＋ Somewhere else" (a name + a kind), and Cellar among its kinds. The new place is a chip
// with no id; the write that uses it finds or creates it (pantryApi.ensurePlaceId, or the route's own
// find-or-create for a jar move).
export { NEW_PLACE_KINDS } from '../putup/placeKinds.js'
const quietLink = {
  minHeight: T.buttonMinHeight, background: 'none', border: 'none', padding: '0 4px', color: P.green, fontWeight: 600,
  fontFamily: 'inherit', fontSize: T.type.sm, textDecoration: 'underline', cursor: 'pointer',
}

// Required single-select of a place chip ({key, id?, label, kind}).
// `groupRef` receives the radiogroup, so a host can move focus to its first chip (focusFirstRadio).
export function PlaceChipRow({
  chips, value, onChange, idPrefix, label = 'Where does it live?', required = true, disabled = false, invalid = false, groupRef = null,
}) {
  const [adding, setAdding] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newKind, setNewKind] = useState(null)
  const options = [...(chips ?? [])]
  if (value && !options.some(c => c.key === value.key)) options.push(value)
  return (
    <div>
      <span style={labelChrome} aria-hidden="true">{label}{required && <span style={requiredMarkChrome}>*</span>}</span>
      <div role="radiogroup" aria-label={label} aria-required={required ? 'true' : undefined} aria-invalid={invalid || undefined}
        data-testid={`${idPrefix}-places`} ref={groupRef} style={row}>
        {options.map(c => (
          <SelectChip key={c.key} touch active={value?.key === c.key} disabled={disabled} role="radio"
            aria-checked={value?.key === c.key} aria-pressed={undefined} data-testid={`${idPrefix}-place-${c.key}`}
            onClick={() => onChange(c)}>{c.label}</SelectChip>
        ))}
      </div>
      {!adding ? (
        <button type="button" style={quietLink} disabled={disabled} data-testid={`${idPrefix}-place-new`}
          onClick={() => setAdding(true)}>＋ Somewhere else</button>
      ) : (
        <div data-testid={`${idPrefix}-place-new-editor`} style={{ marginTop: 8 }}>
          <input type="text" aria-label="Name of the place" value={newLabel} maxLength={60} disabled={disabled}
            data-testid={`${idPrefix}-place-new-label`} placeholder="e.g. Garage fridge" onChange={e => setNewLabel(e.target.value)}
            style={{ ...inputChrome(false), marginBottom: 8, minHeight: T.buttonMinHeight }} />
          <div role="radiogroup" aria-label="What kind of place?" style={row}>
            {NEW_PLACE_KINDS.map(k => (
              <SelectChip key={k.kind} touch active={newKind === k.kind} disabled={disabled} role="radio"
                aria-checked={newKind === k.kind} aria-pressed={undefined} data-testid={`${idPrefix}-place-new-kind-${k.kind}`}
                onClick={() => setNewKind(k.kind)}>{k.label}</SelectChip>
            ))}
          </div>
          <button type="button" disabled={disabled || !newLabel.trim() || !newKind} data-testid={`${idPrefix}-place-new-use`}
            style={quietLink} onClick={() => {
              const l = newLabel.trim()
              onChange({ key: `new:${newKind}:${l.toLowerCase()}`, id: null, label: l, kind: newKind })
              setAdding(false); setNewLabel(''); setNewKind(null)
            }}>Use this place</button>
          <button type="button" disabled={disabled} onClick={() => setAdding(false)}
            style={{ ...quietLink, color: P.light, fontWeight: 400 }}>Cancel</button>
        </div>
      )}
    </div>
  )
}

// The method row: ≤ 4 seeded chips + the as-is chip (or Fresh, as picked) + Other ways…; nothing
// preselected. Other ways… reveals every other method inside the same radiogroup. A method chosen
// before the chips changed under it (a place picked afterwards, whose four do not include it) stays on
// the row as ONE more chip — the row does not grow to every method because of it. `groupRef` receives
// the radiogroup so a Save with no method can move focus to its first chip (V4 §2.2; focusFirstRadio).
export function MethodRow({ choices, value, onChange, what, idPrefix, disabled = false, invalid = false, groupRef = null, label = 'How was it put up?' }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const chosenElsewhere = value && value !== AS_IS && !choices.chips.includes(value) ? [value] : []
  const all = [...choices.chips, ...(moreOpen ? choices.more : chosenElsewhere)]
  const chip = (m) => (
    <SelectChip key={m} touch active={value === m} disabled={disabled} role="radio" aria-checked={value === m}
      aria-pressed={undefined} data-testid={`${idPrefix}-method-${m}`}
      onClick={() => onChange(m)}>{methodLabel(m, what)}</SelectChip>
  )
  return (
    <div>
      <span style={labelChrome} aria-hidden="true">{label}<span style={requiredMarkChrome}>*</span></span>
      <div role="radiogroup" aria-label={label} aria-required="true" aria-invalid={invalid || undefined}
        data-testid={`${idPrefix}-methods`} ref={groupRef} style={row}>
        {all.map(chip)}
        {choices.asIs && (
          <SelectChip touch active={value === AS_IS} disabled={disabled} role="radio" aria-checked={value === AS_IS}
            aria-pressed={undefined} data-testid={`${idPrefix}-method-as_is`}
            onClick={() => onChange(AS_IS)}>{choices.asIs}</SelectChip>
        )}
      </div>
      {!moreOpen && choices.more.length > 0 && (
        <button type="button" data-testid={`${idPrefix}-method-more`} disabled={disabled} onClick={() => setMoreOpen(true)}
          style={quietLink}>
          {OTHER_WAYS_LABEL}
        </button>
      )}
    </div>
  )
}

export function focusFirstRadio(groupRef) {
  const el = groupRef?.current?.querySelector?.('[role="radio"]')
  if (el && typeof el.focus === 'function') el.focus()
}

// Discard by: worked out (the engine) · a date from the label · no date (V4 §3.1) — in the ONE set of
// words every surface that asks it uses (putItUp.DISCARD_LABELS): a put-up "Work it out · From the label ·
// No date"; a bought item "From the label · No date" (a discard date only if typed, §2.5 — `itemMode`
// leaves Work it out off, and its `auto` chip is the one that means no date, so it is pressed for either
// of the two modes that store none).
export function DiscardChoice({ value, onChange, idPrefix, itemMode = false, disabled = false }) {
  const opts = itemMode
    ? [{ id: 'date', label: DISCARD_LABELS.date }, { id: 'auto', label: DISCARD_LABELS.none }]
    : [{ id: 'auto', label: DISCARD_LABELS.auto }, { id: 'date', label: DISCARD_LABELS.date }, { id: 'none', label: DISCARD_LABELS.none }]
  const chosen = (id) => (itemMode && id === 'auto' ? value.mode !== 'date' : value.mode === id)
  return (
    <div>
      <span style={labelChrome} aria-hidden="true">Discard by</span>
      <div role="radiogroup" aria-label="Discard by" style={row}>
        {opts.map(o => (
          <SelectChip key={o.id} touch active={chosen(o.id)} disabled={disabled} role="radio" aria-checked={chosen(o.id)}
            aria-pressed={undefined} data-testid={`${idPrefix}-discard-${o.id}`}
            onClick={() => onChange({ ...value, mode: o.id })}>{o.label}</SelectChip>
        ))}
      </div>
      {value.mode === 'date' && (
        <input type="date" aria-label="Discard date from the label" data-testid={`${idPrefix}-discard-date`} value={value.date}
          disabled={disabled} onChange={e => onChange({ ...value, date: e.target.value })}
          style={{ ...inputChrome(false), maxWidth: 220, marginTop: 8, minHeight: T.buttonMinHeight }} />
      )}
    </div>
  )
}

// Raw · In oil — a put-up's two facts the date engine reads (a bought item's date is only ever typed, so a
// host draws neither for As is). ONE part for both doors: `show` is 'both' (the Walk), 'raw' (the door,
// directly under its method row) or 'oil' (the door, beside When and Discard by). Raw is drawn only on a
// method that allows it (putItUp.RAW_METHODS); a chip that is not shown is never sent (jarBody's rule).
// `hint`: the line that says what Raw means here, as Put it up prints it — the word alone misleads a hot-sauce
// maker both ways (a fermented, uncooked sauce is not Raw in this sense).
export function RawInOilChips({ method, isRaw, inOil, onRaw, onOil, idPrefix, disabled = false, show = 'both', hint = false }) {
  const raw = show !== 'oil' && RAW_METHODS.has(method)
  const oil = show !== 'raw'
  if (!raw && !oil) return null
  const name = show === 'raw' ? RAW_LABEL : show === 'oil' ? IN_OIL_LABEL : RAW_OR_IN_OIL_LABEL
  const chips = (
    <div role="group" aria-label={name} style={row}>
      {raw && (
        <SelectChip touch active={isRaw} disabled={disabled} data-testid={`${idPrefix}-raw`} onClick={onRaw}>{RAW_LABEL}</SelectChip>
      )}
      {oil && (
        <SelectChip touch active={inOil} disabled={disabled} data-testid={`${idPrefix}-inoil`} onClick={onOil}>{IN_OIL_LABEL}</SelectChip>
      )}
    </div>
  )
  if (!hint || !raw) return chips
  return (
    <div>
      {chips}
      <div data-testid={`${idPrefix}-raw-hint`} style={{ marginTop: 4, color: P.mid, fontSize: T.type.sm }}>{RAW_LABEL}: {RAW_HINT.toLowerCase()}.</div>
    </div>
  )
}

// How dry? — only on a dried method (the host decides; the server refuses a texture on any other). Nothing
// preselected, and a second tap un-chooses: an answer that bends or is still soft removes the worked-out date.
export function HowDry({ value, onChange, idPrefix, disabled = false }) {
  return (
    <div>
      <span style={labelChrome} aria-hidden="true">{HOW_DRY_LABEL}</span>
      <div role="group" aria-label={HOW_DRY_LABEL} data-testid={`${idPrefix}-texture`} style={row}>
        {TEXTURE_CHIPS.map(o => (
          <SelectChip key={o.value} touch active={value === o.value} disabled={disabled} data-testid={`${idPrefix}-texture-${o.value}`}
            onClick={() => onChange(value === o.value ? null : o.value)}>{o.label}</SelectChip>
        ))}
      </div>
    </div>
  )
}

// The canning reference line (putSomethingUp.CANNING_LINE): a quoted reference with a link-out, in the
// preview line's ink and size — no box, no icon, no tint, so it never reads as a verdict on this jar. Each
// sentence is its own line; the link is its own 48 px row and opens a new tab. Nothing here takes focus by
// itself and nothing here stops a save.
// The link's name is its words plus where it goes ("— opens in a new tab"), carried as text a screen reader
// reads and the eye does not see: an anchor is named from its content, and the arrow is not a word.
const readOnly = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap', border: 0,
}
export function CanningLine({ idPrefix }) {
  return (
    <div role="note" data-testid={`${idPrefix}-canning-line`} style={{ color: P.mid, fontSize: T.type.sm, lineHeight: 1.45 }}>
      {CANNING_LINE.lines.map(l => <div key={l}>{l}</div>)}
      <a href={CANNING_LINE.href} target="_blank" rel="noopener noreferrer" data-testid={`${idPrefix}-canning-link`}
        style={{ display: 'flex', alignItems: 'center', minHeight: T.buttonMinHeight, color: P.green, fontWeight: 600 }}>
        <span aria-hidden="true">{CANNING_LINE.linkText}</span>
        <span style={readOnly}>{CANNING_LINE.linkName}</span>
      </a>
    </div>
  )
}
