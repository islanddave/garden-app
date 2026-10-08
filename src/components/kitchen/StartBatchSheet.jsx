// src/components/kitchen/StartBatchSheet.jsx
// Put-Up 1a item 4 (V4 §2.2 "Start a batch", §6.2–§6.6) — ONE start sheet, two doors: the quiet
// "Start a batch" at the top of Going now (mounted by PutUp.jsx, the page lane) and Snap's "Something
// in the kitchen" (CaptureFlow.jsx). The same sheet in both, so a batch cannot be started two ways.
//
// THE CONTRACT with the page lane: `{ open, onClose, onStarted(batch) }`, plus two OPTIONAL props
// only Snap passes — `photo` (the File it already holds) and `photoPreview` (its object URL).
//   · onStarted(batch) fires AFTER the sheet has closed itself (onClose) AND its own Android-Back
//     entry has been consumed. So the host may push OR replace freely in onStarted: a push lands as
//     [page, page?batch=] and a replace can take the entry UNDER the sheet (Snap's /capture) — neither
//     strands a dead Back entry mid-stack (the SheetRowLink hazard). If no Back entry was armed
//     (flags off, no provider) it fires at once.
//
// FIELDS (the Jen rule, V4 §6.3 — required at open: 1):
//   · Name it — the label, the ONLY required field. ("What is it?" until Put-Up UX pass R1: Dave could not
//     tell that this is where a ferment's name goes.)
//   · Start from — R1 (PLAN-V3 D10), optional, directly under the name: two 48px buttons, "a recipe" and
//     "a past batch". Not a radiogroup and nothing required: each opens a list, and a pick fills an EMPTY
//     name (never a typed one) and an unpicked kind, shows what was picked, and can be undone.
//       a recipe     — the household's recipes as rows grouped by what they make (recipes/FollowingRecipe.jsx
//                      RecipePick); the pick is recipe_id on the create.
//       a past batch — B′ release 3's "Like a past batch, except…" (putup/LikeBatchPicker.jsx, here with
//                      this row as its door): copies that batch's lines and kind in (putup/likeBatch.js);
//                      the copied lines are posted, keyed, to POST /:id/inputs right after the create, and
//                      are then ordinary lines of the new batch to edit or take out.
//   · When did it start? — Today (preselected) · Yesterday · Earlier… · Not sure; Earlier… offers only
//     what the live CHECK can store in 1a (see StartChips.jsx SHEET_START_CHIPS).
//   · Photo — optional; Snap hands its photo in, Going now can add one.
//   · "What kind of batch?" — collapsed, optional (KindChips). "Other" still asks its short name in 1a.
//   · "Following a recipe? · tested recipes →" — the ruled row, unchanged: a free-text reference and the
//     tested-recipe caution behind its toggle.
// The salt/brine note Snap used to ask at pack time is NOT here: the plan puts Salt with What went in
// in release 3 (V4 §2.2) — recorded in the lane report as a disclosed change.
//
// ONE WRITE: the photo (if any) is uploaded first into the inbox as `pending_tag` with no parent —
// the one parentless shape photos_must_have_parent admits — then POST /api/kitchen-batches carries
// its id as cover_photo_id. A retry after a failed POST reuses the already-uploaded photo rather than
// uploading it twice. No idempotency key in 1a (they arrive with release 1b); `busy` + a synchronous
// ref refuse a second Start it, and Back / the backdrop are refused mid-write.
//
// A REPLAYED START (BUG-PUTUPREPLAYREST-001; kitchen/idempotencyKey.js; the precedent on this PUT is
// putup/HowItWasMadeSheet.jsx). A Start it whose answer was lost, a change, and Start it again is answered
// with the batch the FIRST tap made. A changed name, kind or typed recipe reference goes onto it through the
// batch's own merge PUT and the sheet lands on what the PUT answered — when the batch is this sitting's (sent
// from the sheet that is open, made minutes ago, untouched since). When it started, the recipe it was started
// from and its photo ride no route (the PUT would move the start and the photo on the batch and leave its
// `started` row behind; nothing sets recipe_id), and a batch that is not this sitting's is not written onto:
// NOTHING is written, the sheet stays open and says so (START_REPLAY_NOT_ON_IT), and the page is told
// (`onExists`). That refusal has no way through in this sheet — which tap landed is not known — so it ends the
// STORED draft: the sheet opened next is a clean one with a new key, while this one keeps its key and is
// refused again, never a second batch. A PUT that fails is said as that (START_CHANGE_UNSAVED; _MAYBE when no
// answer came back), with the draft kept so Start it again can finish it. A batch that already holds the
// name, kind and reference on screen (and no other part differs) is started, with nothing written.
// What has gone out under the key rides in the draft as `sent`; its print is of what was CHOSEN — the start
// chip, never the instant "Today" came to.
//
// <Sheet armsBack>, size full; the draft survives a dismiss (kitchen/sheetDraft.js, sheet 'start',
// batch 'new'); confirmOnDirty off; the reload gate is held while anything is typed or a write is in
// flight. "Start it" is pinned above the keyboard (a sticky footer; the app's viewport meta resizes
// content for the keyboard). Completion is shown in place by the host landing on the new batch —
// never a toast.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { useUploadPhoto } from '../../hooks/useUploadPhoto.js'
import { setReloadBlocked } from '../../lib/reloadGate.js'
import { landAfterClose } from './sheetLanding.js'
import Sheet from '../forms/Sheet.jsx'
import Button from '../forms/Button.jsx'
import Field from '../forms/Field.jsx'
import Input from '../forms/Input.jsx'
import { SheetStartChips, SHEET_START_CHIPS, EARLIER_CHIPS, resolveSheetStart } from './StartChips.jsx'
import KindChips, { KIND_CHIPS, kindBody } from './KindChips.jsx'
import { readSheetDraft, writeSheetDraft, clearSheetDraft } from './sheetDraft.js'
import { useSheetDraftKey } from './useSheetDraftKey.js'
import { useFieldsClearOfFooter, scrollClearOfFooter } from './sheetScroll.js'
import { readCaptureMeta } from '../../lib/imagePipeline.js'
import { mintKey, sendPrint, noteSent, afterReplay, whenChoice, answerLost, sameFact, answeredNo, updateSent, holdsOwnUpdate } from './idempotencyKey.js'
import LikeBatchPicker from '../putup/LikeBatchPicker.jsx'
// Put-Up release 4 — "Following a recipe?" (pick one of the household's recipes → recipe_id, or F's free text),
// and Make this's prefill (a recipe's name, kind and process jar).
import FollowingRecipe, { RecipePick, followingBody } from '../recipes/FollowingRecipe.jsx'
import { startPrefill, vesselPatch } from '../recipes/recipes.js'

export const START_SHEET = 'start'
export const START_SHEET_TITLE = 'Start a batch'
export const START_CTA = 'Start it'
// Put-Up UX pass R1 (PLAN-V3 D10) — the field's words. The placeholder is one of his own batch names, so
// the field reads as "the name you will look for it under", not as a description to fill in.
export const START_LABEL_TEXT = 'Name it'
export const START_LABEL_PLACEHOLDER = 'e.g. Megatron mash'
export const START_LABEL_MAX = 120
export const START_FROM_LABEL = 'Start from'
export const START_FROM_RECIPE = 'a recipe'
export const START_FROM_BATCH = 'a past batch'
// How long the landing waits for the sheet's own Back entry before going anyway. It lives with the
// landing now (sheetLanding.js) and is still exported from here, where it has always been found.
export { LAND_FALLBACK_MS } from './sheetLanding.js'
const FOOTER_PX = 76
// The parts of the create the batch's merge PUT is not used for (it carries the name, the kind and the typed
// recipe reference): when it started, the recipe it was started from, the photo.
const START_FIXED = ['started', 'recipe_id', 'cover_photo_id']
// Which tap made the batch is not known here, so no sentence says the change is missing: only that this tap
// wrote nothing, or that the change to what the PUT carries did not go through.
export const START_REPLAY_NOT_ON_IT = 'This batch is already started — an earlier tap on Start it went through. This one changed nothing on it. Close this and open the batch to see it.'
export const START_CHANGE_UNSAVED = 'This batch is already started — an earlier tap on Start it went through. Your last change did not save. Try again, or close this and open the batch.'
export const START_CHANGE_MAYBE = 'This batch is already started — an earlier tap on Start it went through. Your last change may not have saved. Try again, or close this and check the batch.'

const EMPTY = { label: '', chip: 'today', earlier: null, pickedDate: '', kind: null, kindOther: '', key: '', recipeId: null, recipeRef: '' }

// The Start-from row's two buttons: outlined, 48px, never filled — the sheet's one filled button is Start it.
const fromButton = (open) => ({
  minHeight: T.buttonMinHeight, padding: '6px 14px', cursor: 'pointer', fontFamily: 'inherit', fontSize: T.type.sm, fontWeight: 600,
  borderRadius: T.radiusButton, border: `1px solid ${open ? P.green : P.border}`, background: open ? P.greenPale : 'none',
  color: open ? P.green : P.mid,
})

// `key` (release 1b, V4 §5.2/§6.5) is optional on read: a 1a draft has none and gets one when it is
// next written, which is before any POST can carry it.
// `recipe` (R1) is optional on read the same way: it is the picked recipe's `{ id, name, kind }`, stored
// beside `recipeId` so the sheet can say what was picked without a read. A draft a release-4 client stored
// has `recipeId` alone and still restores (the Start-from row names it from the list); one whose `recipe`
// is not that shape is dropped whole, like any other draft that would half-restore.
// `sent` (what has gone out under `key`, idempotencyKey.js) is optional the same way.
export function isStartDraft(d) {
  return !!d && typeof d === 'object' && !Array.isArray(d)
    && typeof d.label === 'string' && typeof d.pickedDate === 'string' && typeof d.kindOther === 'string'
    && SHEET_START_CHIPS.some(c => c.id === d.chip)
    && (d.earlier === null || EARLIER_CHIPS.some(c => c.id === d.earlier))
    && (d.kind === null || KIND_CHIPS.some(c => c.value === d.kind))
    && (d.key === undefined || typeof d.key === 'string')
    && (d.recipeId == null || typeof d.recipeId === 'string')
    && (d.recipeRef === undefined || typeof d.recipeRef === 'string')
    && (d.recipe == null || (typeof d.recipe === 'object' && !Array.isArray(d.recipe)
      && typeof d.recipe.id === 'string' && typeof d.recipe.name === 'string' && d.recipe.id === d.recipeId))
    && (d.sent == null || Array.isArray(d.sent))
}

// Put-Up release 1b (train §6a "Snap's start date"): Snap's photo carries the day it was taken, and
// the shipped kitchen path used it. The chip that says that day: Yesterday, or Earlier… → Pick a date.
// null when the photo is from today (Today stays), has no capture time, or is in the future.
export function photoDayChoice(takenAt, now = new Date()) {
  const t = takenAt instanceof Date ? takenAt : (takenAt ? new Date(takenAt) : null)
  if (!t || Number.isNaN(t.getTime())) return null
  const day = new Date(t.getFullYear(), t.getMonth(), t.getDate())
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diff = Math.round((today.getTime() - day.getTime()) / 86400000)
  if (diff <= 0) return null
  if (diff === 1) return { chip: 'yesterday', earlier: null, pickedDate: '' }
  const pad = n => String(n).padStart(2, '0')
  return { chip: 'earlier', earlier: 'pickdate', pickedDate: `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}` }
}

// `photoTakenAt` (optional): a host that already knows when Snap's photo was taken. Absent, the sheet
// reads it off the photo itself (readCaptureMeta, the upload pipeline's own EXIF read).
// `recipe` (release 4, optional): Make this — the recipe the batch is made from (its detail). The sheet opens
// prefilled with its name, kind and recipe, under its own draft key so a half-typed plain start is untouched.
// `initialLabel` (R1, optional): a name the sheet is opened WITH — the Put something up door's escape,
// "Still going (a ferment)? Start a batch instead →", carries what was typed there. A non-blank one is a
// fresh intent and WINS over a stored draft (the door's own "seeded" rule, PutSomethingUpSheet.jsx): the
// draft is not restored, and the first write replaces it. Read ONCE, at mount: a host that re-renders with
// another value does not retype the field under the cook.
// `onExists(batch)` (optional): the page's re-read, called with the sheet still open when a Start it found its
// batch already started and did not (or could not) put the change on it.
export default function StartBatchSheet({ open, onClose, onStarted, onExists = null, photo = null, photoPreview = null, photoTakenAt, now, recipe = null, initialLabel = '' }) {
  if (!open) return null
  return <StartBatchOpen onClose={onClose} onStarted={onStarted} onExists={onExists} photo={photo} photoPreview={photoPreview}
    photoTakenAt={photoTakenAt} now={now} recipe={recipe} initialLabel={initialLabel} />
}

function StartBatchOpen({ onClose, onStarted, onExists, photo, photoPreview, photoTakenAt, now, recipe, initialLabel }) {
  const { fetch } = useApiFetch()
  const uploader = useUploadPhoto({ errorMode: 'surface' })
  const draftKey = useSheetDraftKey(START_SHEET, recipe?.id ? `recipe-${recipe.id}` : 'new')
  const [seed] = useState(() => (typeof initialLabel === 'string' && initialLabel.trim() !== '' ? initialLabel.slice(0, START_LABEL_MAX) : ''))
  // Read ONCE, at open — see CheckOnItSheet for why the first commit must already hold it.
  const [restored] = useState(() => (seed ? null : readSheetDraft(draftKey, START_SHEET, isStartDraft)))
  const pre = recipe ? startPrefill(recipe) : null
  const initial = restored ?? {
    ...EMPTY,
    ...(pre ? { label: pre.label, kind: pre.kind, recipeId: pre.recipeId, recipe: { id: pre.recipeId, name: pre.recipeName, kind: pre.kind } } : null),
    ...(seed ? { label: seed } : null),
  }
  const [key, setKey] = useState(initial.key ?? '')
  // What has gone out under `key` (idempotencyKey.js), kept with it in the draft.
  const [sent, setSent] = useState(() => (Array.isArray(initial.sent) ? initial.sent.filter(x => typeof x === 'string') : []))
  // Whether every body under `key` went out from THIS sheet: a draft restored with `sent` in it was sent from
  // an earlier one, and is never written onto the batch it made.
  const mineRef = useRef(sent.length === 0)
  // The PUT this sheet last sent that may have landed — the batch's id and the body as it went (idempotencyKey.js
  // updateSent): a PUT that landed with its answer lost has moved the batch's updated_at, and Start it again must
  // still be able to finish it — only while the batch still holds that body.
  const putRef = useRef(null)
  // Set by a replay refusal: the first tap landed, so the STORED draft has done its job. It is taken out of
  // storage and not written back, while this sheet keeps its key and `sent`.
  const [spent, setSpent] = useState(false)
  // Set once a start lands: the draft is cleared then, and nothing may write it back before the sheet
  // unmounts (`sent` changes while the create is out, and its render can be committed after the clear).
  const landedRef = useRef(false)
  const [label, setLabel] = useState(initial.label)
  const [chip, setChip] = useState(initial.chip)
  const [earlier, setEarlier] = useState(initial.earlier)
  const [pickedDate, setPickedDate] = useState(initial.pickedDate)
  const [kind, setKind] = useState(initial.kind)
  const [kindOther, setKindOther] = useState(initial.kindOther)
  const [kindOpen, setKindOpen] = useState(initial.kind != null)
  // B′ release 3: "Like <batch>, except…" — { from, lines, kind } or null. Held for this open only.
  const [like, setLike] = useState(null)
  const [following, setFollowing] = useState({ recipeId: initial.recipeId ?? null, recipeRef: initial.recipeRef ?? '', recipe: initial.recipe ?? null })
  // R1 — which Start-from list is open: 'recipe' | 'batch' | null. One at a time, so the sheet stays short.
  const [fromOpen, setFromOpen] = useState(null)
  // What each Start-from pick PUT into the name and the kind, so undoing the pick takes back exactly that
  // — and never a name typed, or a kind chosen, since.
  const filledRef = useRef({ recipe: null, batch: null })
  // The row's two buttons. A list closes when a row in it is picked, and the picked line goes when it is
  // undone — either way the control that had focus is gone, so focus returns to the button it came from
  // rather than falling to the top of the page (a button, so no keyboard comes up on a phone).
  const fromRecipeRef = useRef(null)
  const fromBatchRef = useRef(null)
  // A photo added HERE (the Going-now door). Snap's arrives as `photo` and is the host's to keep.
  const [ownFile, setOwnFile] = useState(null)
  const [ownPreview, setOwnPreview] = useState(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const writingRef = useRef(false)
  const uploadedRef = useRef(null)          // { file, photoId } — a retry never uploads twice
  const fileRef = useRef(null)
  // The focused field is kept clear of the pinned Start it (see sheetScroll.js).
  const footerRef = useRef(null)
  const keepClear = useFieldsClearOfFooter(footerRef)
  // A failed start or a replay refusal is the last line of the scroller, under the pinned Start it: each is
  // brought into view (counted, so the same failure twice is brought into view twice).
  const errRef = useRef(null)
  const [failedSeq, setFailedSeq] = useState(0)
  useEffect(() => {
    if (!failedSeq) return
    const el = errRef.current
    if (!el) return
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
    scrollClearOfFooter(el, footerRef.current)
  }, [failedSeq])
  const labelId = `start-label-${useId()}`

  useEffect(() => () => { if (ownPreview) URL.revokeObjectURL(ownPreview) }, [ownPreview])

  // Snap's photo day, preselected ONCE — never over a restored draft, and never after the cook has
  // touched the chips (a late EXIF read must not move an answer they gave).
  const chipTouchedRef = useRef(!!restored)
  useEffect(() => {
    if (!photo || chipTouchedRef.current) return
    let alive = true
    Promise.resolve(photoTakenAt !== undefined ? { takenAt: photoTakenAt } : readCaptureMeta(photo))
      .then(meta => {
        if (!alive || chipTouchedRef.current) return
        const pick = photoDayChoice(meta?.takenAt ?? null, new Date(now ?? Date.now()))
        if (pick) { setChip(pick.chip); setEarlier(pick.earlier); setPickedDate(pick.pickedDate) }
      })
      .catch(() => {})
    return () => { alive = false }
  }, [photo, photoTakenAt, now])

  const dirty = label.trim() !== '' || chip !== 'today' || earlier != null || pickedDate !== ''
    || kind != null || kindOther.trim() !== '' || !!ownFile
    || following.recipeId != null || following.recipeRef.trim() !== ''

  useEffect(() => {
    if (!draftKey || landedRef.current) return
    // The draft carries what can be serialised; a picked File cannot, and is not pretended to.
    const text = label.trim() !== '' || chip !== 'today' || earlier != null || pickedDate !== '' || kind != null || kindOther.trim() !== ''
      || following.recipeId != null || following.recipeRef.trim() !== ''
    // The recipe pair rides only when answered, so a plain start's draft keeps its 1b shape exactly; the
    // picked recipe's `{ id, name, kind }` rides beside its id (R1, additive).
    const recipePart = following.recipeId != null || following.recipeRef !== ''
      ? { recipeId: following.recipeId, recipeRef: following.recipeRef, ...(following.recipe ? { recipe: following.recipe } : null) }
      : {}
    if (text && !spent) {
      writeSheetDraft(draftKey, START_SHEET, { label, chip, earlier, pickedDate, kind, kindOther, key, ...recipePart, ...(sent.length ? { sent } : null) })
    } else clearSheetDraft(draftKey)
  }, [draftKey, label, chip, earlier, pickedDate, kind, kindOther, key, following, sent, spent])

  // The create's idempotency key (release 1b, V4 §6.5): minted the first time the sheet is dirty, kept
  // in the draft, reused on every retry — a Start it whose answer was lost is a replay, not a twin.
  useEffect(() => { if (dirty && !key) setKey(mintKey()) }, [dirty, key])

  // ONE boolean dependency — see CheckOnItSheet: the release transition can fire a deferred reload.
  const holdReload = dirty || saving
  const gateKey = `start-sheet:${useId()}`
  useEffect(() => {
    setReloadBlocked(gateKey, holdReload)
    return () => setReloadBlocked(gateKey, false)
  }, [gateKey, holdReload])

  const file = photo ?? ownFile
  const preview = photo ? photoPreview : ownPreview

  const pickPhoto = useCallback((e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setOwnFile(f)
    setOwnPreview(URL.createObjectURL(f))
  }, [])

  // THE LANDING: close first, let the sheet's own Back entry be consumed, then hand the batch over.
  const land = useCallback((batch) => {
    landAfterClose(onClose, () => onStarted?.(batch))
  }, [onClose, onStarted])

  // START FROM (R1). A pick fills what is EMPTY and only that: a typed name is never replaced, a chosen kind
  // never overridden — and a kind no chip offers (a legacy `age` batch) is not put in the kind at all, where
  // it could not be sent. Undoing the pick takes back what THAT pick filled, if it still stands.
  //
  // "Empty" is judged WHEN THE PICK LANDS, not when it was tapped: a past batch is read from the server
  // before it is handed over, and on a slow connection that is long enough to type a name. So both read
  // the name and the kind as they stand now (these refs), never as the handler that started the read saw them.
  const labelRef = useRef(label); labelRef.current = label
  const kindRef = useRef(kind); kindRef.current = kind
  const fillFrom = (who, name, pickedKind) => {
    const filled = { label: null, kind: null }
    const text = String(name ?? '').slice(0, START_LABEL_MAX)
    if (labelRef.current.trim() === '' && text.trim() !== '') { setLabel(text); filled.label = text }
    if (kindRef.current == null && KIND_CHIPS.some(c => c.value === pickedKind)) { setKind(pickedKind); setKindOpen(true); filled.kind = pickedKind }
    filledRef.current[who] = filled
    setErr(null)
  }
  const unfill = (who) => {
    const filled = filledRef.current[who]
    filledRef.current[who] = null
    if (filled?.label != null && labelRef.current === filled.label) setLabel('')
    if (filled?.kind != null && kindRef.current === filled.kind) setKind(null)
    setErr(null)
  }
  const lockedRecipe = recipe && following.recipeId === recipe.id ? recipe : null

  const start = useCallback(async () => {
    if (writingRef.current) return
    const text = label.trim()
    if (!text) { setErr('Give it a name first.'); document.getElementById(labelId)?.focus(); return }
    const when = resolveSheetStart({ chip, earlier, pickedDate, now: new Date(now ?? Date.now()) })
    if (when.error) { setErr(when.error); return }
    const kindPart = kindBody(kind, kindOther)
    if (kindPart === null) { setErr('Give the kind a short name — or leave the kind unpicked.'); setKindOpen(true); return }
    const useKey = key || mintKey()
    if (!key) setKey(useKey)
    writingRef.current = true
    setSaving(true); setErr(null)
    // The batch a replay answered with, once it is being written onto.
    let onRow = null
    try {
      let coverId = uploadedRef.current && uploadedRef.current.file === file ? uploadedRef.current.photoId : null
      if (file && !coverId) {
        const r = await uploader.upload(file, {
          keyPrefix: 'standalone', parentId: null, linkage: { intake_status: 'pending_tag' }, is_public: true,
        })
        if (r?.error || !r?.photo?.id) throw Object.assign(new Error(r?.error || 'upload'), { photo: true })
        coverId = r.photo.id
        uploadedRef.current = { file, photoId: coverId }
      }
      const chose = { label: text, ...kindPart, ...(coverId ? { cover_photo_id: coverId } : {}), ...followingBody(following) }
      // The print's start is the chip, not the date it came to: Today is the instant, a new one at every tap.
      const print = sendPrint({ ...chose, started: whenChoice(chip, earlier, pickedDate) }, START_FIXED)
      const sentNow = noteSent(sent, print)
      setSent(sentNow)
      let batch = await fetch('/api/kitchen-batches', { method: 'POST', body: JSON.stringify({ ...chose, ...when.start, idempotency_key: useKey }) })
      const todo = afterReplay(batch, sentNow, print, {
        row: batch, mine: mineRef.current, updatedHere: holdsOwnUpdate(batch, putRef.current),
        // What the PUT could carry is all the batch has to hold; a difference in any other part is 'fixed'.
        holds: sameFact(batch?.label, chose.label) && sameFact(batch?.kind, chose.kind) && sameFact(batch?.kind_other, chose.kind_other)
          && sameFact(batch?.recipe_ref, chose.recipe_ref),
      })
      if (todo === 'fixed' || todo === 'stale') {
        // Nothing is written and the key is KEPT: Start it again is this refusal again, never a second batch.
        writingRef.current = false
        setSaving(false)
        setSpent(true)
        setErr(START_REPLAY_NOT_ON_IT)
        setFailedSeq(s => s + 1)
        onExists?.(batch)
        return
      }
      if (todo === 'update') {
        onRow = batch
        if (batch?.id == null) throw new Error('replayed without a batch')
        const was = putRef.current
        const put = { label: chose.label, kind: chose.kind ?? null, kind_other: chose.kind_other ?? null, recipe_ref: chose.recipe_ref ?? null }
        putRef.current = updateSent(batch.id, put)
        let updated
        try {
          updated = await fetch(`/api/kitchen-batches/${batch.id}`, { method: 'PUT', body: JSON.stringify(put) })
        } catch (e) {
          // An ANSWERED 4xx did not land: the PUT this sheet keeps is the one before it.
          if (answeredNo(e)) putRef.current = was
          throw e
        }
        batch = { ...batch, ...updated }
      }
      // The copied lines, keyed (a retry replays them). A refusal here leaves a batch with fewer lines,
      // never a lost batch: its detail page adds or edits lines as usual.
      if (like?.lines?.length && batch?.id) {
        await Promise.resolve(fetch(`/api/kitchen-batches/${batch.id}/inputs`, {
          method: 'POST', body: JSON.stringify({ inputs: like.lines }),
        })).catch(() => {})
      }
      // Make this (release 4): the recipe's process jar, through the merge PUT. Best effort — the batch is
      // already started, and its Jar & heat row can set the jar if this does not land.
      const vp = recipe && batch?.id && following.recipeId === recipe.id ? vesselPatch(recipe) : null
      if (vp) await fetch(`/api/kitchen-batches/${batch.id}`, { method: 'PUT', body: JSON.stringify(vp) }).catch(() => {})
      landedRef.current = true
      clearSheetDraft(draftKey)
      land(batch)
    } catch (e) {
      writingRef.current = false
      setSaving(false)
      if (onRow?.id != null) {
        // The batch is started; it is the change that did not go through. Said as that, and the page told.
        setErr(answerLost(e) ? START_CHANGE_MAYBE : START_CHANGE_UNSAVED)
        setFailedSeq(s => s + 1)
        onExists?.(onRow)
        return
      }
      // An ANSWERED 4xx wrote nothing, so this body is not one that may have landed: `sent` is as it was
      // before it went (a body that went out earlier, and may have landed then, is still in it).
      if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) setSent(sent)
      setErr(e?.photo
        ? "Couldn't save the photo — try again, or remove it."
        : "Couldn't start it — try again. What you typed is still here.")
      setFailedSeq(s => s + 1)
    }
  }, [chip, draftKey, earlier, fetch, file, following, key, kind, kindOther, label, labelId, land, like, now, onExists, pickedDate, recipe, sent, uploader])

  return (
    <Sheet open onClose={onClose} title={START_SHEET_TITLE} size="full" busy={saving} armsBack>
      <div data-testid="start-sheet" onFocus={keepClear} style={{ padding: '0 18px' }}>
        <Field label={START_LABEL_TEXT} htmlFor={labelId} required style={{ marginBottom: T.space.md }}>
          <Input id={labelId} data-testid="start-label" value={label} disabled={saving}
            placeholder={START_LABEL_PLACEHOLDER} maxLength={START_LABEL_MAX}
            onChange={e => { setLabel(e.target.value); setErr(null) }}
            style={{ scrollMarginBottom: FOOTER_PX }} />
        </Field>

        {/* START FROM (R1, PLAN-V3 D10). Two doors, not a choice: a group of buttons that each open a list
            (aria-expanded), so nothing here reads as required and nothing is preselected. Made from a
            recipe (Make this) the recipe is already chosen, and only the past batch is offered. */}
        <div data-testid="start-from" style={{ marginBottom: T.space.md }}>
          <div role="group" aria-label={START_FROM_LABEL} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <span aria-hidden="true" style={{ fontSize: T.type.sm, fontWeight: 600, color: P.mid }}>{START_FROM_LABEL}</span>
            {!lockedRecipe && (
              <button type="button" ref={fromRecipeRef} data-testid="start-from-recipe" aria-expanded={fromOpen === 'recipe'} disabled={saving}
                onClick={() => setFromOpen(o => (o === 'recipe' ? null : 'recipe'))} style={fromButton(fromOpen === 'recipe')}>
                {START_FROM_RECIPE}
              </button>
            )}
            <button type="button" ref={fromBatchRef} data-testid="start-from-batch" aria-expanded={fromOpen === 'batch'} disabled={saving}
              onClick={() => setFromOpen(o => (o === 'batch' ? null : 'batch'))} style={fromButton(fromOpen === 'batch')}>
              {START_FROM_BATCH}
            </button>
          </div>
          <RecipePick value={following} fetch={fetch} open={fromOpen === 'recipe'} locked={lockedRecipe} disabled={saving}
            onChange={v => { setFollowing(v); setErr(null) }}
            onPick={r => { const p = startPrefill(r); fillFrom('recipe', p.label, p.kind); setFromOpen(null); fromRecipeRef.current?.focus() }}
            onClear={() => { unfill('recipe'); fromRecipeRef.current?.focus() }} />
          <LikeBatchPicker idPrefix="start-like" picked={like} disabled={saving}
            open={fromOpen === 'batch'} onOpenChange={o => { setFromOpen(o ? 'batch' : null); if (!o) fromBatchRef.current?.focus() }}
            onPick={d => { setLike(d); fillFrom('batch', d.from?.label, d.kind) }}
            onClear={() => { setLike(null); unfill('batch'); fromBatchRef.current?.focus() }} />
        </div>

        <div style={{ marginBottom: T.space.md }}>
          <SheetStartChips value={chip} disabled={saving}
            onChange={v => { chipTouchedRef.current = true; setChip(v); if (v !== 'earlier') { setEarlier(null); setPickedDate('') } setErr(null) }}
            earlier={earlier} onEarlierChange={v => { chipTouchedRef.current = true; setEarlier(v); if (v !== 'pickdate') setPickedDate(''); setErr(null) }}
            pickedDate={pickedDate} onPickedDateChange={v => { chipTouchedRef.current = true; setPickedDate(v); setErr(null) }}
            now={new Date(now ?? Date.now())} />
        </div>

        <div data-testid="start-photo" style={{ marginBottom: T.space.md, display: 'flex', alignItems: 'center', gap: T.space.sm }}>
          {preview && (
            <img src={preview} alt="The batch's photo" data-testid="start-photo-preview"
              style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: T.radiusButton, border: `1px solid ${P.border}` }} />
          )}
          {!photo && (
            <>
              {/* A real button carries the name and the focus; the input stays hidden (the
                  a11yLabelledFileInput pattern). Library, not forced camera. */}
              <input ref={fileRef} type="file" accept="image/*" data-testid="start-photo-input"
                onChange={pickPhoto} style={{ display: 'none' }} />
              <button type="button" data-testid="start-photo-add" disabled={saving}
                onClick={() => fileRef.current?.click()}
                style={{ minHeight: T.buttonMinHeight, padding: '6px 12px', background: 'none', cursor: 'pointer',
                  border: `1px solid ${P.border}`, borderRadius: T.radiusButton, fontFamily: 'inherit',
                  fontSize: T.type.sm, color: P.mid }}>
                {ownFile ? 'Change photo' : 'Add a photo'}
              </button>
              {ownFile && (
                <button type="button" data-testid="start-photo-remove" disabled={saving}
                  onClick={() => { setOwnFile(null); setOwnPreview(null); uploadedRef.current = null }}
                  style={{ minHeight: T.buttonMinHeight, padding: '6px 8px', background: 'none', border: 'none',
                    cursor: 'pointer', fontFamily: 'inherit', fontSize: T.type.sm, color: P.light }}>
                  Remove
                </button>
              )}
            </>
          )}
          {photo && <span style={{ color: P.light, fontSize: '0.78rem' }}>This photo goes with it.</span>}
        </div>

        <div style={{ marginBottom: T.space.sm }}>
          <button type="button" data-testid="start-kind-toggle" aria-expanded={kindOpen}
            onClick={() => setKindOpen(o => !o)} disabled={saving}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: T.buttonMinHeight,
              padding: '2px 0', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              fontSize: T.type.sm, fontWeight: 600, color: P.green }}>
            What kind of batch?
            <span style={{ color: P.light, fontWeight: 400, fontSize: '0.78rem' }}>optional</span>
          </button>
          {kindOpen && (
            <div style={{ marginTop: 6 }}>
              <KindChips idPrefix="start-kind" value={kind} disabled={saving}
                onChange={v => { setKind(v); setErr(null) }} otherText={kindOther}
                onOtherTextChange={v => { setKindOther(v); setErr(null) }} />
            </div>
          )}
        </div>

        <FollowingRecipe value={following} onChange={v => { setFollowing(v); setErr(null) }} disabled={saving}
          locked={lockedRecipe} />

        {err && (
          <div ref={errRef} role="alert" data-testid="start-error"
            style={{ marginBottom: T.space.sm, color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>{err}</div>
        )}
      </div>

      <div ref={footerRef} data-testid="start-footer" style={{ position: 'sticky', bottom: 0, background: P.white,
        padding: `${T.space.sm}px 18px`, borderTop: `1px solid ${P.border}` }}>
        <Button data-testid="start-submit" variant="primary" loading={saving} loadingLabel="Starting…"
          onClick={start} style={{ width: '100%' }}>
          {START_CTA}
        </Button>
      </div>
    </Sheet>
  )
}
