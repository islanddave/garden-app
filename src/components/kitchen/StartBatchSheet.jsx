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
//   · What is it? — the label, the ONLY required field.
//   · When did it start? — Today (preselected) · Yesterday · Earlier… · Not sure; Earlier… offers only
//     what the live CHECK can store in 1a (see StartChips.jsx SHEET_START_CHIPS).
//   · Photo — optional; Snap hands its photo in, Going now can add one.
//   · "What kind of batch?" — collapsed, optional (KindChips). "Other" still asks its short name in 1a.
// The salt/brine note Snap used to ask at pack time is NOT here: the plan puts Salt with What went in
// in release 3 (V4 §2.2) — recorded in the lane report as a disclosed change.
//
// ONE WRITE: the photo (if any) is uploaded first into the inbox as `pending_tag` with no parent —
// the one parentless shape photos_must_have_parent admits — then POST /api/kitchen-batches carries
// its id as cover_photo_id. A retry after a failed POST reuses the already-uploaded photo rather than
// uploading it twice. No idempotency key in 1a (they arrive with release 1b); `busy` + a synchronous
// ref refuse a second Start it, and Back / the backdrop are refused mid-write.
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
import { readMarker } from '../../lib/backNav.js'
import Sheet from '../forms/Sheet.jsx'
import Button from '../forms/Button.jsx'
import Field from '../forms/Field.jsx'
import Input from '../forms/Input.jsx'
import { SheetStartChips, SHEET_START_CHIPS, EARLIER_CHIPS, resolveSheetStart } from './StartChips.jsx'
import KindChips, { KIND_CHIPS, kindBody } from './KindChips.jsx'
import { readSheetDraft, writeSheetDraft, clearSheetDraft } from './sheetDraft.js'
import { useSheetDraftKey } from './useSheetDraftKey.js'
import { useFieldsClearOfFooter } from './sheetScroll.js'
import { readCaptureMeta } from '../../lib/imagePipeline.js'
import { mintKey } from './idempotencyKey.js'

export const START_SHEET = 'start'
export const START_SHEET_TITLE = 'Start a batch'
export const START_CTA = 'Start it'
export const START_LABEL_PLACEHOLDER = 'e.g. Pepper mash'
// How long to wait for the sheet's own Back entry to be consumed before landing anyway. The popstate
// normally arrives within a frame or two; the ceiling only matters if nothing consumes the entry.
export const LAND_FALLBACK_MS = 1000
const FOOTER_PX = 76

const EMPTY = { label: '', chip: 'today', earlier: null, pickedDate: '', kind: null, kindOther: '', key: '' }

// `key` (release 1b, V4 §5.2/§6.5) is optional on read: a 1a draft has none and gets one when it is
// next written, which is before any POST can carry it.
export function isStartDraft(d) {
  return !!d && typeof d === 'object' && !Array.isArray(d)
    && typeof d.label === 'string' && typeof d.pickedDate === 'string' && typeof d.kindOther === 'string'
    && SHEET_START_CHIPS.some(c => c.id === d.chip)
    && (d.earlier === null || EARLIER_CHIPS.some(c => c.id === d.earlier))
    && (d.kind === null || KIND_CHIPS.some(c => c.value === d.kind))
    && (d.key === undefined || typeof d.key === 'string')
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
export default function StartBatchSheet({ open, onClose, onStarted, photo = null, photoPreview = null, photoTakenAt, now }) {
  if (!open) return null
  return <StartBatchOpen onClose={onClose} onStarted={onStarted} photo={photo} photoPreview={photoPreview}
    photoTakenAt={photoTakenAt} now={now} />
}

function StartBatchOpen({ onClose, onStarted, photo, photoPreview, photoTakenAt, now }) {
  const { fetch } = useApiFetch()
  const uploader = useUploadPhoto({ errorMode: 'surface' })
  const draftKey = useSheetDraftKey(START_SHEET, 'new')
  // Read ONCE, at open — see CheckOnItSheet for why the first commit must already hold it.
  const [restored] = useState(() => readSheetDraft(draftKey, START_SHEET, isStartDraft))
  const initial = restored ?? EMPTY
  const [key, setKey] = useState(initial.key ?? '')
  const [label, setLabel] = useState(initial.label)
  const [chip, setChip] = useState(initial.chip)
  const [earlier, setEarlier] = useState(initial.earlier)
  const [pickedDate, setPickedDate] = useState(initial.pickedDate)
  const [kind, setKind] = useState(initial.kind)
  const [kindOther, setKindOther] = useState(initial.kindOther)
  const [kindOpen, setKindOpen] = useState(initial.kind != null)
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

  useEffect(() => {
    if (!draftKey) return
    // The draft carries what can be serialised; a picked File cannot, and is not pretended to.
    const text = label.trim() !== '' || chip !== 'today' || earlier != null || pickedDate !== '' || kind != null || kindOther.trim() !== ''
    if (text) writeSheetDraft(draftKey, START_SHEET, { label, chip, earlier, pickedDate, kind, kindOther, key })
    else clearSheetDraft(draftKey)
  }, [draftKey, label, chip, earlier, pickedDate, kind, kindOther, key])

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
    const armed = typeof window !== 'undefined' && !!readMarker(window.history?.state)
    let done = false
    let timer = null
    const finish = () => {
      if (done) return
      done = true
      window.removeEventListener('popstate', finish)
      if (timer) clearTimeout(timer)
      onStarted?.(batch)
    }
    if (armed) {
      window.addEventListener('popstate', finish)
      timer = setTimeout(finish, LAND_FALLBACK_MS)
    }
    onClose?.()
    if (!armed) finish()
  }, [onClose, onStarted])

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
      const batch = await fetch('/api/kitchen-batches', { method: 'POST', body: JSON.stringify({
        label: text, ...when.start, ...kindPart, ...(coverId ? { cover_photo_id: coverId } : {}), idempotency_key: useKey,
      }) })
      clearSheetDraft(draftKey)
      land(batch)
    } catch (e) {
      writingRef.current = false
      setSaving(false)
      setErr(e?.photo
        ? "Couldn't save the photo — try again, or remove it."
        : "Couldn't start it — try again. What you typed is still here.")
    }
  }, [chip, draftKey, earlier, fetch, file, key, kind, kindOther, label, labelId, land, now, pickedDate, uploader])

  return (
    <Sheet open onClose={onClose} title={START_SHEET_TITLE} size="full" busy={saving} armsBack>
      <div data-testid="start-sheet" onFocus={keepClear} style={{ padding: '0 18px' }}>
        <Field label="What is it?" htmlFor={labelId} required style={{ marginBottom: T.space.md }}>
          <Input id={labelId} data-testid="start-label" value={label} disabled={saving}
            placeholder={START_LABEL_PLACEHOLDER} maxLength={120}
            onChange={e => { setLabel(e.target.value); setErr(null) }}
            style={{ scrollMarginBottom: FOOTER_PX }} />
        </Field>

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
                style={{ minHeight: T.tapMinHeight, padding: '6px 12px', background: 'none', cursor: 'pointer',
                  border: `1px solid ${P.border}`, borderRadius: T.radiusButton, fontFamily: 'inherit',
                  fontSize: T.type.sm, color: P.mid }}>
                {ownFile ? 'Change photo' : 'Add a photo'}
              </button>
              {ownFile && (
                <button type="button" data-testid="start-photo-remove" disabled={saving}
                  onClick={() => { setOwnFile(null); setOwnPreview(null); uploadedRef.current = null }}
                  style={{ minHeight: T.tapMinHeight, padding: '6px 8px', background: 'none', border: 'none',
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
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: T.tapMinHeight,
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

        {err && (
          <div role="alert" data-testid="start-error"
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
