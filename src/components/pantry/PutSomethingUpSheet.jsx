// src/components/pantry/PutSomethingUpSheet.jsx
// Put-Up B′ release 2 (V4 §2.2 "Put something up", §3.1, §6.3–§6.6) — the one page-level door that adds
// ONE thing to the Pantry per save.
//
// Required at open: 3 — What is it? (the shipped name search) · Where does it live? (place chips) ·
// How was it put up? (method chips + the as-is chip + Other ways…; nothing preselected). Before a place
// is picked the row offers the general four; a place puts its own four there, and a method already
// chosen stays as one more chip. Save is NEVER disabled: tapped with no method it moves focus to the
// method row with one line (V4 §2.2).
//
// Put-Up R2a — THE FIRST SCREEN, in order: What · Where · How · ONE slot under the method row, by method
// (the canning line; Raw with its line; How dry?) · How many? and "＋ Size of each container" (As is:
// "＋ How much" alone) · "▸ Date, discard by[, in oil]" (what changes the date line) · "▸ Where from, notes"
// (record only) · the preview with Change · the pinned Save. Everything past the three questions is
// optional; a half-filled size or amount, and Other with no name, are refused in place.
//
// Put-Up UX pass R1: the preview line carries "Change", its own target, which opens the first disclosure on
// the When chips (the door's date was only reachable by knowing it was under a control called More).
// `onStartBatchInstead(name)` — the page's, optional: a line under the name hands the typed name to the
// Start sheet for a thing that is still going. The door clears its OWN draft first (the name has left
// it), then calls it and closes. Absent, there is no such line.
//
// THE WRITE, by the method chip (V4 §2.1's one table rule): a method → POST /api/preservation (the 1b
// create; a template place is made first); As is / Fresh, as picked → POST /api/pantry/items (a planting
// hit keeps plant_id and crop). One key per draft, minted when the sheet first becomes dirty, kept in the
// draft and reused on every retry (V4 §5.2, §6.5) — and minted AGAIN only after an answered 4xx, which is
// the one failure that proves nothing was written (after no answer, or a 5xx, the first row may exist, and
// the same key is what makes the retry find it). Before Save, one role=status line previews the date it
// uses and the discard-by with its basis (the shared engine, putItUp.previewDiscard).
//
// A REPLAYED ITEM (BUG-PUTUPREPLAYDROPSEDIT-001; kitchen/idempotencyKey.js). The key does not change with what
// is typed, so after a lost answer and a change the item route answers `replayed: true` with the item the
// FIRST Save made. When that item is THIS sitting's (sent from the door that is open now, made minutes ago,
// untouched since) the door PATCHes what it holds onto it and completes from the PATCH's answer. When it is
// not — a draft restored with `sent` already in it, an older item, one edited since — NOTHING is written: the
// door says it was saved earlier and this Save changed nothing (replayStaleText) and KEEPS the key, so Save
// again is refused again and can never add a second item. A What that is now another planting (or none) cannot
// ride a PATCH: nothing is written and the door says so (replayFixedText); put back, the next Save goes through.
// A failure of the PATCH never mints a new key, whatever its status — the item exists — and is said as that
// (replayUnsavedText). Each of the three tells the page (`onExists`) so the list behind shows the item, and
// is brought into view above the pinned Save (it is the last thing in the scroller). Before any of them the
// door reads the item itself: one that already holds what is on screen is a save, with nothing written
// (putSomethingUp.js itemHolds). An answered 4xx mints a new key only while nothing else has gone out under
// this one: the route validates before it looks the key up, so a refusal of a changed body says nothing
// about an earlier one.
// What has gone out under the key rides in the draft as `sent`, from the first item Save on; its prints are
// of what was chosen, not of the date or the searched crop (putSomethingUp.js itemPrint). The put-up route is
// as it was: a replayed put-up completes from the server's row (plan R2 V2 "Retry key").
//
// A SEEDED DOOR (opened with a What: a search's "Put something up: <text> →", a planting's door) is not
// dirty until something changes: no key, no draft written, no reload held, and a draft already stored is
// left alone until the first real change replaces it. A stored draft for the SAME seed is restored whole.
//
// <Sheet armsBack>; `busy` while writing; the draft (kitchen/sheetDraft.js, sheet 'putsomethingup') keeps
// what was typed across Android Back and a deploy reload; the reload gate is held while dirty or saving.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { setReloadBlocked } from '../../lib/reloadGate.js'
import RefusalLine, { refusalOf } from './RefusalLine.jsx'
import { createPantryItem, patchPantryItem, ensurePlaceId } from '../../lib/pantryApi.js'
import Sheet from '../forms/Sheet.jsx'
import Button from '../forms/Button.jsx'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome } from '../forms/formStyles.js'
import { readSheetDraft, writeSheetDraft, clearSheetDraft } from '../kitchen/sheetDraft.js'
import { useSheetDraftKey } from '../kitchen/useSheetDraftKey.js'
import { mintKey, noteSent, afterReplay, whenChoice, answerLost } from '../kitchen/idempotencyKey.js'
import { useFieldsClearOfFooter, scrollClearOfFooter, FOOTER_GAP_PX } from '../kitchen/sheetScroll.js'
import { placeChips, estimateChips, TEXTURE_CHIPS } from '../putup/putItUp.js'
import NameSearchField from './NameSearchField.jsx'
import Stepper, { stepperCount } from './Stepper.jsx'
import AmountField, {
  amountError, SIZE_WORDS, AMOUNT_WORDS, SIZE_UNITS, MORE_SIZE_UNITS, ITEM_AMOUNT_UNITS, MORE_ITEM_AMOUNT_UNITS,
} from './AmountField.jsx'
import WhereFromField, { whereFromError, FIRST_SOURCE_KINDS, MORE_SOURCE_KINDS } from './WhereFromField.jsx'
import {
  PlaceChipRow, MethodRow, DiscardChoice, focusFirstRadio, RawInOilChips, HowDry, CanningLine,
} from './DoorParts.jsx'
import {
  AS_IS, DOOR_TITLE, DOOR_SHEET, METHOD_REQUIRED_TEXT, methodChoices, routeFor, saveLabel, doorWhen,
  previewLine, doorError, jarBody, itemBody, START_BATCH_INSTEAD_TEXT, isPlantingHit, methodSlot,
  doorOptionsLabel, doorFromLabel, doorNotesPlaceholder, whereFromHeading, sizeEcho, sizeTotalError,
  SIZE_LINK_LABEL, AMOUNT_LINK_LABEL, itemPatchOf, itemPrint, itemHolds, plantingDiffers, replayFixedText, replayStaleText,
  replayUnsavedText,
} from './putSomethingUp.js'

const WHEN_CHIPS = [{ id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: 'earlier', label: 'Earlier…' }]
// The door's quiet text actions (the two disclosures, the size and amount links, the preview's Change, the
// way out to a batch).
const quietAction = {
  minHeight: T.buttonMinHeight, background: 'none', border: 'none', padding: 0, color: P.green,
  fontWeight: 600, fontFamily: 'inherit', fontSize: T.type.sm, cursor: 'pointer',
}
// The sheet's scroller, found by its role — unquoted, as sheetScroll.js spells it and for its reason.
const PANEL = '[role=dialog]'

// ── The draft ────────────────────────────────────────────────────────────────────────────────────
// Its shape, checked on read (sheetDraft.js: a record that fails is dropped, never half-restored). The first
// five clauses are v4.168's; R2a's nine keys are each OPTIONAL and typed, so a record stored by yesterday's
// client still restores, and a record written today still passes yesterday's check (a forward undo restores
// the subset it knows). SHEET_DRAFT_VERSION is not bumped: a bump would drop every stored draft.
const optional = (v, type) => v == null || typeof v === type
export function isDoorDraft(d) {
  return !!d && typeof d === 'object'
    && (d.key == null || typeof d.key === 'string')
    && (d.what == null || (typeof d.what === 'object' && typeof d.what.name === 'string'))
    && (d.method == null || typeof d.method === 'string')
    && typeof d.count === 'string'
    && (d.place == null || (typeof d.place === 'object' && typeof d.place.key === 'string'))
    && optional(d.sizeValue, 'string') && optional(d.sizeUnit, 'string')
    && optional(d.amountValue, 'string') && optional(d.amountUnit, 'string')
    && optional(d.sourceKind, 'string') && optional(d.sourceLabel, 'string')
    && optional(d.isRaw, 'boolean') && optional(d.inOil, 'boolean') && optional(d.texture, 'string')
    && (d.sent == null || Array.isArray(d.sent))
}

// A stored value outside today's list is read as "none chosen", never shown as a chip nobody can see.
const valuesOf = (...lists) => new Set(lists.flat().map(o => o.value))
const SIZE_UNIT_VALUES = valuesOf(SIZE_UNITS, MORE_SIZE_UNITS)
const AMOUNT_UNIT_VALUES = valuesOf(ITEM_AMOUNT_UNITS, MORE_ITEM_AMOUNT_UNITS)
const SOURCE_KIND_VALUES = new Set([...FIRST_SOURCE_KINDS, ...MORE_SOURCE_KINDS])
const TEXTURE_VALUES = valuesOf(TEXTURE_CHIPS)
const oneOf = (set, v) => (set.has(v) ? v : null)

const EMPTY = Object.freeze({
  key: null, what: null, place: null, method: null, count: '1', whenChip: 'today', estimate: null, pickedDate: '',
  discard: { mode: 'auto', date: '' }, notes: '',
  // The put-up size and the as-is amount are SEPARATE cells: a method switch never turns one into the other
  // (1 qt × 3 must not become "How much: 1 qt"), and each is there again when its route is chosen again.
  sizeValue: '', sizeUnit: null, amountValue: '', amountUnit: null,
  sourceKind: null, sourceLabel: '', isRaw: false, inOil: false, texture: null,
})

// A stored draft is for the SAME seed when both carry a planting and it is the same one, or neither carries
// one and the names are the same once trimmed and case-folded. A typed name and a planting that share words
// are different things (one sends plant_id), and two plantings can share a name.
export function sameSeed(seed, what) {
  if (!seed || !what) return false
  const a = seed.plant_id ?? null
  const b = what.plant_id ?? null
  if (a != null || b != null) return a != null && b != null && String(a) === String(b)
  const fold = (w) => String(w.name ?? '').trim().toLowerCase()
  return fold(seed) !== '' && fold(seed) === fold(what)
}
// Whether a What still IS the seed the door opened with: the same planting (or none on either side) under the
// same name, trimmed and case-folded. NOT every onChange is a touch — the name search also reports what a
// SEARCH ANSWER resolved (a typed name gains or loses its crop_type_slug with no tap and no keystroke), and a
// seeded door that has only been told its crop must still mint no key, write no draft and hold no reload.
function seedUntouched(seed, what) {
  const id = (w) => (w?.plant_id == null ? null : String(w.plant_id))
  const fold = (w) => String(w?.name ?? '').trim().toLowerCase()
  return id(seed) === id(what) && fold(seed) === fold(what)
}

// What the door opens on: { initial, seed }. `seed` is the What a FRESH seeded open started from (the thing
// `dirty` is measured against); it is null for a plain open and for a seeded open that restored its own draft.
function opening({ draftKey, initialWhat, initialName }) {
  const given = initialWhat ?? (String(initialName ?? '').trim() ? { source: 'typed', name: String(initialName) } : null)
  const stored = readSheetDraft(draftKey, DOOR_SHEET, isDoorDraft)
  if (given && !(stored && sameSeed(given, stored.what))) return { initial: { ...EMPTY, what: given }, seed: given }
  if (!stored) return { initial: EMPTY, seed: null }
  return {
    seed: null,
    initial: {
      ...EMPTY, ...stored,
      whenChip: stored.whenChip ?? 'today', estimate: stored.estimate ?? null, pickedDate: stored.pickedDate ?? '',
      discard: stored.discard ?? EMPTY.discard, notes: stored.notes ?? '',
      sizeValue: stored.sizeValue ?? '', sizeUnit: oneOf(SIZE_UNIT_VALUES, stored.sizeUnit),
      amountValue: stored.amountValue ?? '', amountUnit: oneOf(AMOUNT_UNIT_VALUES, stored.amountUnit),
      sourceKind: oneOf(SOURCE_KIND_VALUES, stored.sourceKind), sourceLabel: stored.sourceLabel ?? '',
      isRaw: stored.isRaw === true, inOil: stored.inOil === true, texture: oneOf(TEXTURE_VALUES, stored.texture),
    },
  }
}

// A restored place, against the list read at open (the chips: the household's places, then a template for a
// kind with none). A place with an id that is gone → no place chosen (a deleted place selected again would
// fail every Save); one whose kind changed → the live chip, so the method chips and the preview date are
// worked out for the kind the server will store. A chip with no id that is on the list stays. The retired
// template (the bare "Freezer" chip) maps to the current chip of the same kind, so it cannot come back as an
// option and name a new place "Freezer". Any other chip with no id is a place typed under "＋ Somewhere
// else", and stays as typed.
const RETIRED_TEMPLATE_KEYS = new Set(['new:deep_freezer:freezer'])
export function resolveDraftPlace(place, chips) {
  if (!place) return null
  const list = chips ?? []
  if (place.id != null) return list.find(c => c.id != null && String(c.id) === String(place.id)) ?? null
  const same = list.find(c => c.key === place.key)
  if (same) return same
  if (!RETIRED_TEMPLATE_KEYS.has(place.key)) return place
  return list.find(c => c.kind === place.kind) ?? null
}

// `onExists` (optional): the page's re-read, called with the door still open when a Save found its item
// already in the Pantry and did not (or could not) put the change on it.
export default function PutSomethingUpSheet({
  open, onClose, onSaved, onExists = null, initialName = '', initialWhat = null, stockRows = null, onStartBatchInstead = null, now,
}) {
  if (!open) return null
  return <DoorOpen onClose={onClose} onSaved={onSaved} onExists={onExists} initialName={initialName} initialWhat={initialWhat}
    stockRows={stockRows} onStartBatchInstead={onStartBatchInstead} now={now} />
}

function DoorOpen({ onClose, onSaved, onExists, initialName, initialWhat, stockRows, onStartBatchInstead, now }) {
  const { fetch } = useApiFetch()
  const nowDate = useMemo(() => new Date(now ?? Date.now()), [now])
  const draftKey = useSheetDraftKey(DOOR_SHEET, 'new')
  const [{ initial, seed }] = useState(() => opening({ draftKey, initialWhat, initialName }))
  const openedWithWhat = !!(initialWhat || String(initialName ?? '').trim())
  const [key, setKey] = useState(initial.key)
  // What has gone out under `key` on the item route (idempotencyKey.js); dropped with the key.
  const [sent, setSent] = useState(() => (Array.isArray(initial.sent) ? initial.sent.filter(x => typeof x === 'string') : []))
  // Whether every body under `key` went out from THIS door. A draft restored with `sent` in it was sent from
  // an earlier one, and is never written onto the item it made; a key minted here is this door's.
  const mineRef = useRef(sent.length === 0)
  // The item this door has sent a PATCH to (its id): a PATCH that landed with its answer lost has moved the
  // item's updated_at, and Save again must still be able to finish it.
  const patchedRef = useRef(null)
  const [what, setWhat] = useState(initial.what)
  const [place, setPlace] = useState(initial.place)
  const [method, setMethod] = useState(initial.method)
  const [count, setCount] = useState(initial.count)
  const [whenChip, setWhenChip] = useState(initial.whenChip)
  const [estimate, setEstimate] = useState(initial.estimate)
  const [pickedDate, setPickedDate] = useState(initial.pickedDate)
  const [discard, setDiscard] = useState(initial.discard)
  const [notes, setNotes] = useState(initial.notes)
  const [sizeValue, setSizeValue] = useState(initial.sizeValue)
  const [sizeUnit, setSizeUnit] = useState(initial.sizeUnit)
  const [amountValue, setAmountValue] = useState(initial.amountValue)
  const [amountUnit, setAmountUnit] = useState(initial.amountUnit)
  const [sourceKind, setSourceKind] = useState(initial.sourceKind)
  const [sourceLabel, setSourceLabel] = useState(initial.sourceLabel)
  const [isRaw, setIsRaw] = useState(initial.isRaw)
  const [inOil, setInOil] = useState(initial.inOil)
  const [texture, setTexture] = useState(initial.texture)
  const [moreOpen, setMoreOpen] = useState(false)
  const [fromOpen, setFromOpen] = useState(false)
  const [sizeOpen, setSizeOpen] = useState(() => !!(initial.sizeValue || initial.sizeUnit))
  const [amountOpen, setAmountOpen] = useState(() => !!(initial.amountValue || initial.amountUnit))
  const [places, setPlaces] = useState(null)
  const [placesAnswered, setPlacesAnswered] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [field, setField] = useState(null)
  const writingRef = useRef(false)
  // Set once a save lands: the draft is cleared then, and nothing may write it back before the door
  // unmounts (a render between the clear and the close would otherwise re-stash a spent draft).
  const savedRef = useRef(false)
  // The stored draft is this door's to replace or clear only once it has written one (or restored it): a
  // fresh seeded open leaves a draft it did not make alone until the first real change.
  const ownsDraftRef = useRef(!seed)
  const sheetRef = useRef(null)
  const footerRef = useRef(null)
  const methodRef = useRef(null)
  const placesRef = useRef(null)
  const whatRef = useRef(null)
  const whenRef = useRef(null)
  const slotRef = useRef(null)
  const errRef = useRef(null)
  // Counts the replay refusals (saved earlier / the planting / the change did not save): each is brought into view.
  const [refusedSeq, setRefusedSeq] = useState(0)
  // Set by the preview's Change: once the options are open, focus goes to the When chips it opened them for.
  const [toWhen, setToWhen] = useState(false)
  // A field a tap or a refusal sends focus to, by test id, once it is on screen.
  const [toField, setToField] = useState(null)
  // Counts the method taps: the slot under the method row is brought into view after each.
  const [slotSeq, setSlotSeq] = useState(0)
  const notesId = `door-notes-${useId()}`

  useEffect(() => {
    let alive = true
    Promise.resolve().then(() => fetch('/api/storage-locations'))
      .then(r => { if (alive) { setPlaces(Array.isArray(r) ? r : []); setPlacesAnswered(Array.isArray(r)) } })
      .catch(() => { if (alive) setPlaces([]) })
    return () => { alive = false }
  }, [fetch])
  const chips = useMemo(() => placeChips(places ?? []), [places])

  // The place this door opened with is re-resolved ONCE, against the list the read answered with. A read
  // that failed resolves nothing: the place stays as stored and the server judges it.
  const resolvedRef = useRef(false)
  useEffect(() => {
    if (!placesAnswered || resolvedRef.current) return
    resolvedRef.current = true
    setPlace(p => resolveDraftPlace(p, chips))
  }, [chips, placesAnswered])

  // Opened with a What, the next question is the place: focus goes to its first chip once the places read
  // has settled (before that the row holds templates that the household's own places then replace) — once,
  // and only if focus is still where <Sheet> put it at open (its effect runs before this component's).
  const sheetFocusRef = useRef(null)
  useEffect(() => { sheetFocusRef.current = document.activeElement }, [])
  const placeFocusedRef = useRef(false)
  useEffect(() => {
    if (!openedWithWhat || places == null || placeFocusedRef.current) return
    placeFocusedRef.current = true
    if (document.activeElement === sheetFocusRef.current) focusFirstRadio(placesRef)
  }, [openedWithWhat, places])

  const choices = useMemo(() => methodChoices({ placeKind: place?.kind ?? null, what }), [place, what])
  // A method the new place or What no longer offers (a planting at a freezer drops As is) is cleared,
  // never kept silently.
  useEffect(() => {
    if (method === AS_IS && !choices.asIs) setMethod(null)
  }, [choices, method])

  const planting = isPlantingHit(what)
  const isPutUp = !!method && method !== AS_IS
  const slot = methodSlot(method)
  const n = stepperCount(count)

  // DIRTY = differs from what the door opened with. A plain open, and one that restored a draft, opened
  // on nothing; a fresh seeded open opened on its seed, so the seed alone is not a change.
  const whatDirty = seed ? !seedUntouched(seed, what) : !!String(what?.name ?? '').trim()
  const dirty = !!(whatDirty || place || method || count !== '1' || notes.trim()
    || discard.mode !== 'auto' || whenChip !== 'today'
    || sizeValue || sizeUnit || amountValue || amountUnit || sourceKind || sourceLabel.trim()
    || isRaw || inOil || texture)
  useEffect(() => { if (dirty && !key) setKey(mintKey()) }, [dirty, key])
  useEffect(() => {
    if (!draftKey || savedRef.current) return
    if (dirty) {
      ownsDraftRef.current = true
      writeSheetDraft(draftKey, DOOR_SHEET, {
        key, what, place, method, count, whenChip, estimate, pickedDate, discard, notes,
        sizeValue, sizeUnit, amountValue, amountUnit, sourceKind, sourceLabel, isRaw, inOil, texture,
        ...(sent.length ? { sent } : null),
      })
    } else if (ownsDraftRef.current) clearSheetDraft(draftKey)
  }, [draftKey, dirty, key, what, place, method, count, whenChip, estimate, pickedDate, discard, notes,
    sizeValue, sizeUnit, amountValue, amountUnit, sourceKind, sourceLabel, isRaw, inOil, texture, sent])

  const holdReload = dirty || saving
  const gateKey = `put-something-up:${useId()}`
  useEffect(() => {
    setReloadBlocked(gateKey, holdReload)
    return () => setReloadBlocked(gateKey, false)
  }, [gateKey, holdReload])

  const w = doorWhen({ chip: whenChip, estimate, pickedDate, now: nowDate })
  const preview = w.when ? previewLine({ method, place, when: w.when, discard, isRaw, inOil, texture, now: nowDate }) : null
  const echo = sizeEcho({ value: sizeValue, unit: sizeUnit }, n)

  useEffect(() => {
    if (!toWhen || !moreOpen) return
    setToWhen(false)
    const group = whenRef.current
    const chip = group?.querySelector?.('[role="radio"][aria-checked="true"]') ?? group?.querySelector?.('[role="radio"]')
    if (chip && typeof chip.focus === 'function') chip.focus()
    if (group && typeof group.scrollIntoView === 'function') group.scrollIntoView({ block: 'nearest' })
  }, [moreOpen, toWhen])

  useEffect(() => {
    if (!toField) return
    setToField(null)
    const el = sheetRef.current?.querySelector?.(`[data-testid="${toField}"]`)
    if (el && typeof el.focus === 'function') el.focus()
  }, [toField])

  // A method tap brings what it put under the method row into view: the nearest edge, then clear of the
  // pinned Save (a sticky band over it does not count as out of view). Focus does not move.
  useEffect(() => {
    if (!slotSeq) return
    const el = slotRef.current
    if (!el) return
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
    scrollClearOfFooter(el, footerRef.current)
  }, [slotSeq])

  // A replay refusal or a failed Save is the last line of the scroller and Save is pinned over its end:
  // without this the button comes back and nothing on screen has changed. The nearest edge, then clear of
  // the footer. Counted, not read off the text: the same failure twice is brought into view twice.
  useEffect(() => {
    if (!refusedSeq) return
    const el = errRef.current
    if (!el) return
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
    scrollClearOfFooter(el, footerRef.current)
  }, [refusedSeq])

  // THE PINNED SAVE AND A FOCUSED FIELD (sheetScroll.js): every field is kept clear of the footer, on focus
  // and again when the keyboard resizes the viewport. The size and the amount are cleared as a WHOLE block
  // — the field AND its unit chips — so the units are on screen while he types, when the block fits above
  // the footer at all.
  const keepFieldClear = useFieldsClearOfFooter(footerRef)
  const keepBlockClear = useCallback((el) => {
    const block = el?.closest?.('[data-clear-whole]')
    const footer = footerRef.current
    if (!block || !footer || !el.matches?.('input')) return
    const top = block.closest(PANEL)?.getBoundingClientRect?.().top ?? 0
    if (block.getBoundingClientRect().height <= footer.getBoundingClientRect().top - top - FOOTER_GAP_PX) scrollClearOfFooter(block, footer)
  }, [])
  const keepClear = useCallback((e) => { keepFieldClear(e); keepBlockClear(e?.target) }, [keepBlockClear, keepFieldClear])
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    // After the field's own correction (one frame, in the hook), the block's.
    const again = () => requestAnimationFrame(() => requestAnimationFrame(() => keepBlockClear(document.activeElement)))
    const vv = window.visualViewport
    window.addEventListener('resize', again)
    vv?.addEventListener?.('resize', again)
    return () => {
      window.removeEventListener('resize', again)
      vv?.removeEventListener?.('resize', again)
    }
  }, [keepBlockClear])

  // The way out to a batch: the name leaves this door, so its draft goes first (and nothing may write it
  // back before the door unmounts — the same latch a landed save sets).
  const startBatchInstead = useCallback(() => {
    savedRef.current = true
    clearSheetDraft(draftKey)
    onStartBatchInstead?.(String(what?.name ?? '').trim())
    onClose?.()
  }, [draftKey, onClose, onStartBatchInstead, what])

  const clearErr = (f) => { if (field === f) { setErr(null); setField(null) } }
  // A planting hit has no where-from row (its origin is the planting, and the server refuses the pair), so
  // a choice made before the hit is dropped rather than kept unseen.
  const changeWhat = (v) => {
    setWhat(v)
    if (isPlantingHit(v)) { setSourceKind(null); setSourceLabel('') }
    clearErr('what')
  }
  // Between two put-up methods a where-from choice stays as it is. Between As is and a put-up method it
  // stays too, and its disclosure opens: the question's label has changed, and keeping the answer unseen
  // would change its meaning unseen.
  const changeMethod = (m) => {
    if (method && m && (method === AS_IS) !== (m === AS_IS) && sourceKind && !planting) setFromOpen(true)
    setMethod(m)
    setSlotSeq(s => s + 1)
    clearErr('method')
  }

  const save = useCallback(async () => {
    if (writingRef.current) return
    const refuse = (error, f, focus = null) => { setErr(error); setField(f); if (focus) setToField(focus) }
    const e = doorError({ what, place, method, discard })
    if (e) {
      setErr(e.error); setField(e.field)
      if (e.field === 'method') focusFirstRadio(methodRef)
      else if (e.field === 'what') whatRef.current?.focus?.()
      else if (e.field === 'discard') setMoreOpen(true)
      return
    }
    if (w.error) { setErr(w.error); setField('when'); setMoreOpen(true); return }
    const route = routeFor(method)
    const size = { value: sizeValue, unit: sizeUnit }
    const amount = { value: amountValue, unit: amountUnit }
    const source = { kind: sourceKind, label: sourceLabel }
    // Only what this route sends is judged: a size typed before a switch to As is waits, unsent, in its own cell.
    if (route === 'jar') {
      const sizeErr = amountError(size, SIZE_WORDS) ?? sizeTotalError(size, n)
      if (sizeErr) { setSizeOpen(true); refuse(sizeErr, 'size', 'door-size-value'); return }
    } else {
      const amountErr = amountError(amount, AMOUNT_WORDS)
      if (amountErr) { setAmountOpen(true); refuse(amountErr, 'amount', 'door-amount-value'); return }
    }
    const fromErr = planting ? null : whereFromError(source)
    if (fromErr) { setFromOpen(true); refuse(fromErr, 'source', 'door-source-label'); return }
    const useKey = key || mintKey()
    if (!key) setKey(useKey)
    writingRef.current = true
    setSaving(true); setErr(null); setField(null)
    // The item a replay answered with, once it is being written onto: a failure after that is not a new key.
    let onRow = null
    try {
      let saved
      if (route === 'jar') {
        const storageLocationId = await ensurePlaceId(fetch, place)
        saved = await fetch('/api/preservation', { method: 'POST', body: JSON.stringify(jarBody({
          key: useKey, what, storageLocationId, method, when: w.when, count: n, discard, notes,
          isRaw, inOil, size, source, texture,
        })) })
      } else {
        const body = itemBody({ key: useKey, what, place, when: w.when, discard, notes, amount, source })
        const print = itemPrint(body, what, whenChoice(whenChip, estimate, pickedDate))
        const sentNow = noteSent(sent, print)
        setSent(sentNow)
        const r = await createPantryItem(fetch, body)
        saved = r?.item ?? r
        const todo = afterReplay(r, sentNow, print, {
          row: saved, mine: mineRef.current, updatedHere: saved?.id != null && patchedRef.current === saved.id,
          fixed: plantingDiffers(body, saved), holds: itemHolds(body, saved, what),
        })
        if (todo === 'stale' || todo === 'fixed') {
          // Nothing is written and the key is KEPT: Save again is this refusal again, never a second item.
          writingRef.current = false
          setSaving(false)
          if (todo === 'stale') { setErr(replayStaleText(saved)); setField(null) }
          else { setErr(replayFixedText(saved)); setField('what') }
          setRefusedSeq(s => s + 1)
          onExists?.()
          return
        }
        if (todo === 'update') {
          onRow = saved
          if (saved?.id == null) throw new Error('replayed without an item')
          const placeId = await ensurePlaceId(fetch, place)
          patchedRef.current = saved.id
          const u = await patchPantryItem(fetch, saved.id, itemPatchOf(body, placeId, saved))
          saved = u?.item ?? u
        }
      }
      savedRef.current = true
      clearSheetDraft(draftKey)
      writingRef.current = false
      setSaving(false)
      onSaved?.({ route, saved, place, what })
    } catch (ex) {
      writingRef.current = false
      setSaving(false)
      if (onRow) {
        // The item is in the Pantry; it is the change that did not go through. Said as that, the page told,
        // and the key kept whatever the status.
        const why = refusalOf(ex, '')
        setErr({ text: replayUnsavedText(onRow, { why: why.text, lost: answerLost(ex) }), refresh: why.refresh })
        setRefusedSeq(s => s + 1)
        onExists?.()
        return
      }
      // An ANSWERED 4xx wrote nothing, so the next attempt is a new request and gets a new key. Anything else
      // (no status, 0, a 5xx) may have landed with its answer lost: the key is kept, the retry replays it.
      // And it is kept after a 4xx too once an item Save has gone out under it before (`sent`): that one may
      // have landed, and the route refuses a body before it looks the key up.
      if (typeof ex?.status === 'number' && ex.status >= 400 && ex.status < 500 && !(route === 'item' && sent.length)) {
        mineRef.current = true; patchedRef.current = null
        setKey(mintKey()); setSent([])
      }
      setErr(refusalOf(ex, "Couldn't save it — nothing was lost. Try again."))
      setRefusedSeq(s => s + 1)
    }
  }, [amountUnit, amountValue, discard, draftKey, estimate, fetch, inOil, isRaw, key, method, n, notes, onExists, onSaved, pickedDate,
    place, planting, sent, sizeUnit, sizeValue, sourceKind, sourceLabel, texture, w, whenChip, what])

  const name = String(what?.name ?? '').trim() || 'this'
  return (
    <Sheet open onClose={onClose} title={DOOR_TITLE} size="full" busy={saving} armsBack>
      <div data-testid="door-sheet" ref={sheetRef} onFocus={keepClear}
        style={{ padding: '0 18px', display: 'flex', flexDirection: 'column', gap: T.space.md }}>
        <NameSearchField value={what} onChange={changeWhat}
          fetch={fetch} stockRows={stockRows} idPrefix="door-what" invalid={field === 'what'} inputRef={whatRef} disabled={saving}
          under={typeof onStartBatchInstead === 'function' ? (
            <button type="button" data-testid="door-start-batch-instead" disabled={saving} onClick={startBatchInstead}
              style={{ ...quietAction, display: 'block', textAlign: 'left' }}>
              {START_BATCH_INSTEAD_TEXT}
            </button>
          ) : null} />
        <PlaceChipRow chips={chips} value={place} idPrefix="door" disabled={saving} invalid={field === 'where'} groupRef={placesRef}
          onChange={c => { setPlace(c); clearErr('where') }} />
        <MethodRow choices={choices} value={method} what={what} idPrefix="door" disabled={saving} invalid={field === 'method'}
          groupRef={methodRef} onChange={changeMethod} />
        {field === 'method' && (
          <div role="alert" data-testid="door-method-required" style={{ color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>
            {METHOD_REQUIRED_TEXT}
          </div>
        )}
        {/* ONE slot, by method; never two at once. */}
        {slot && (
          <div ref={slotRef} data-testid="door-method-slot">
            {slot === 'canning' && <CanningLine idPrefix="door" />}
            {slot === 'raw' && (
              <RawInOilChips show="raw" hint method={method} isRaw={isRaw} inOil={inOil} idPrefix="door" disabled={saving}
                onRaw={() => setIsRaw(v => !v)} onOil={() => setInOil(v => !v)} />
            )}
            {slot === 'dry' && <HowDry value={texture} onChange={setTexture} idPrefix="door" disabled={saving} />}
          </div>
        )}
        {isPutUp && (
          <div>
            <span style={labelChrome} aria-hidden="true">How many?</span>
            <Stepper value={count} onChange={setCount} name={name} idPrefix="door-count" disabled={saving} />
            {!sizeOpen ? (
              <button type="button" data-testid="door-size-open" disabled={saving}
                onClick={() => { setSizeOpen(true); setToField('door-size-value') }}
                style={{ ...quietAction, display: 'block', marginTop: T.space.xs }}>
                {SIZE_LINK_LABEL}
              </button>
            ) : (
              <div data-testid="door-size" data-clear-whole="" style={{ marginTop: T.space.sm }}>
                <AmountField value={sizeValue} unit={sizeUnit} idPrefix="door-size" disabled={saving} invalid={field === 'size'}
                  label={SIZE_WORDS.label} placeholder={SIZE_WORDS.placeholder} clearLabel={SIZE_WORDS.clearLabel}
                  units={SIZE_UNITS} moreUnits={MORE_SIZE_UNITS}
                  onChange={v => { setSizeValue(v.value); setSizeUnit(v.unit); clearErr('size') }} />
                {/* Both numbers, where the size is typed: what is stored is the total. */}
                <p role="status" data-testid="door-size-echo" style={{ margin: echo ? '6px 0 0' : 0, color: P.mid, fontSize: T.type.sm }}>{echo ?? ''}</p>
              </div>
            )}
          </div>
        )}
        {method === AS_IS && (!amountOpen ? (
          <button type="button" data-testid="door-amount-open" disabled={saving}
            onClick={() => { setAmountOpen(true); setToField('door-amount-value') }}
            style={{ ...quietAction, alignSelf: 'flex-start' }}>
            {AMOUNT_LINK_LABEL}
          </button>
        ) : (
          <div data-testid="door-amount" data-clear-whole="">
            <AmountField value={amountValue} unit={amountUnit} idPrefix="door-amount" disabled={saving} invalid={field === 'amount'}
              label={AMOUNT_WORDS.label} placeholder={AMOUNT_WORDS.placeholder} clearLabel={AMOUNT_WORDS.clearLabel}
              units={ITEM_AMOUNT_UNITS} moreUnits={MORE_ITEM_AMOUNT_UNITS}
              onChange={v => { setAmountValue(v.value); setAmountUnit(v.unit); clearErr('amount') }} />
          </div>
        ))}

        {/* A — what changes the date line: When · In oil (a put-up) · Discard by. */}
        <button type="button" aria-expanded={moreOpen} data-testid="door-more" onClick={() => setMoreOpen(o => !o)}
          style={{ ...quietAction, alignSelf: 'flex-start' }}>
          <span aria-hidden="true">{moreOpen ? '▾ ' : '▸ '}</span>{doorOptionsLabel(method)}
        </button>
        {moreOpen && (
          <div data-testid="door-more-panel" style={{ display: 'flex', flexDirection: 'column', gap: T.space.md }}>
            <div>
              <span style={labelChrome} aria-hidden="true">When?</span>
              <div role="radiogroup" aria-label="When?" ref={whenRef} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {WHEN_CHIPS.map(c => (
                  <SelectChip key={c.id} touch active={whenChip === c.id} disabled={saving} role="radio" aria-checked={whenChip === c.id}
                    aria-pressed={undefined} data-testid={`door-when-${c.id}`}
                    onClick={() => { setWhenChip(c.id); if (c.id !== 'earlier') { setEstimate(null); setPickedDate('') } }}>{c.label}</SelectChip>
                ))}
              </div>
              {whenChip === 'earlier' && (
                <div role="radiogroup" aria-label="Roughly when?" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  {estimateChips(nowDate).map(c => (
                    <SelectChip key={c.id} touch active={estimate === c.id} disabled={saving} role="radio" aria-checked={estimate === c.id}
                      aria-pressed={undefined} data-testid={`door-when-${c.id}`} onClick={() => setEstimate(c.id)}>{c.label}</SelectChip>
                  ))}
                </div>
              )}
              {whenChip === 'earlier' && estimate === 'pickdate' && (
                <input type="date" aria-label="The day" data-testid="door-when-date" value={pickedDate} disabled={saving}
                  onChange={e => setPickedDate(e.target.value)} style={{ marginTop: 8, minHeight: T.buttonMinHeight }} />
              )}
            </div>
            {isPutUp && (
              <RawInOilChips show="oil" method={method} isRaw={isRaw} inOil={inOil} idPrefix="door" disabled={saving}
                onRaw={() => setIsRaw(v => !v)} onOil={() => setInOil(v => !v)} />
            )}
            <DiscardChoice value={discard} onChange={setDiscard} idPrefix="door" itemMode={method === AS_IS} disabled={saving} />
          </div>
        )}

        {/* B — record only: where it's from (never for a planting), then notes. */}
        <button type="button" aria-expanded={fromOpen} data-testid="door-from" onClick={() => setFromOpen(o => !o)}
          style={{ ...quietAction, alignSelf: 'flex-start' }}>
          <span aria-hidden="true">{fromOpen ? '▾ ' : '▸ '}</span>{doorFromLabel(what)}
        </button>
        {fromOpen && (
          <div data-testid="door-from-panel" style={{ display: 'flex', flexDirection: 'column', gap: T.space.md }}>
            {!planting && (
              <WhereFromField kind={sourceKind} label={sourceLabel} heading={whereFromHeading(method)} idPrefix="door"
                disabled={saving} invalid={field === 'source'}
                onChange={v => { setSourceKind(v.kind); setSourceLabel(v.label ?? ''); clearErr('source') }} />
            )}
            <div>
              <label htmlFor={notesId} style={labelChrome}>Notes</label>
              <textarea id={notesId} data-testid="door-notes" value={notes} disabled={saving} onChange={e => setNotes(e.target.value)}
                placeholder={doorNotesPlaceholder(method)}
                style={{ width: '100%', minHeight: 60, fontFamily: 'inherit', fontSize: T.type.base }} />
            </div>
          </div>
        )}

        {/* The line and its Change are SIBLINGS: the status text stays the sentence alone. */}
        {preview && (
          <div style={{ display: 'flex', alignItems: 'center', gap: T.space.sm, flexWrap: 'wrap' }}>
            <p role="status" data-testid="door-preview" style={{ margin: 0, flex: 1, minWidth: 160, color: P.mid, fontSize: T.type.sm }}>{preview}</p>
            <button type="button" data-testid="door-preview-change" aria-label="Change — the date" disabled={saving}
              onClick={() => { setMoreOpen(true); setToWhen(true) }}
              style={{ ...quietAction, minWidth: 48, textDecoration: 'underline' }}>
              Change
            </button>
          </div>
        )}
        {field !== 'method' && <RefusalLine err={err} testId="door-error" lineRef={errRef} style={{ marginBottom: FOOTER_GAP_PX }} />}
      </div>
      <div ref={footerRef} data-testid="door-footer"
        style={{ position: 'sticky', bottom: 0, background: P.white, padding: `${T.space.sm}px 18px`, borderTop: `1px solid ${P.border}` }}>
        <Button data-testid="door-save" variant="primary" loading={saving} loadingLabel="Saving…" onClick={save} style={{ width: '100%' }}>
          {saveLabel(method, what)}
        </Button>
      </div>
    </Sheet>
  )
}
