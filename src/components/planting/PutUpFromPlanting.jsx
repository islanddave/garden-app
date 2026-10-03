// PutUpFromPlanting — V4-PUTUPLINK-001. "What came off THIS planting, and what became of it."
// The read end of the seed → planting → harvest → put-up spine: PutUp.jsx writes preservation_log
// .plant_id, this renders it back on the planting that produced it.
//
// Data: GET /api/preservation/whats-put-up?plant_id=<id>&include_consumed=1. The Lambda returns
// storage-grouped records already scoped to the planting, so this flattens the groups and keeps each
// group's label as the row's storage location — there is no per-record storage_label on the
// projection.
//
// V4-HARVESTFATE-001 — WHY include_consumed, and why this section is two readings rather than one.
// The endpoint's default drops a fully-consumed jar, which is correct for the Pantry ("what is in the
// freezer") and WRONG here: this is the only surface that answers "where did this planting's harvest
// go", and on the default the answer silently reverts to "nothing" the day the last jar is finished.
// So the fetch keeps consumed rows and the component separates them — what is STILL THERE, then what
// was USED (gone, but still the planting's history). THIS SECTION KEEPS ITS OWN READ: the Pantry's
// list drops a finished jar, and here a finished jar is the answer.
//
// Put-Up UX pass R1 — A LIST, AND ONLY A LIST. The headline that counted containers, listed units and
// totalled put-ups is gone (V4 §2.5: a list, never a sum; "fl oz" stood alone in it), and with it the
// "N use soon" pill. Each row now says what the Pantry says about the same jar:
//   its name · its place · how many are left (on EVERY row still there) · when it was put up, and
//   the discard-date sentence from putup/jarWords.js — "discard by … · <where the date came from>",
//   "use by …" only for cured and cellared produce — tinted (putup/soonTint.js) when the server says
//   it is soon or past. The sentence carries the state; the tint is a second channel, not an alert.
// A used row is dimmed, says "all used", and carries no date sentence: a finished jar is never asked
// to be used soon.
//
// Deliberately READ-ONLY. Edit / "mark used" / remove all live on the Put-Up surface; duplicating
// the mutation affordances here would mean two places to keep in step with the PUT full-replace
// contract. The one action this section offers is adding: "Put something up from this planting".
//
// Put-Up R2a, lane K — THE DOOR OPENS HERE, IN PLACE. The link used to go to Put-Up's Log form with
// this planting as router-state prefill; it is now a button that opens the Pantry's own door
// (PutSomethingUpSheet) on this page, seeded with this planting (plantingKitchen.doorWhatOf). No
// navigation and no router state: X, Back and Save all leave him on the planting, and nothing is
// armed, read or written until the button is tapped. This component is the door's HOST:
//   · it closes the door on Save (the door never closes itself after a save) and shows what the
//     SERVER answered, in completionWords, on the Pantry's own line (CompletionLine) with Undo —
//     directly above the button, which is where his eyes and his focus are. No timer: it goes on ×,
//     or with the page;
//   · after a Save and after an Undo it re-reads BOTH of the page's reads: this list (a put-up), and
//     PlantingKitchen's kept-fresh read (a "Fresh, as picked" item), through onStockChanged;
//   · a re-read never blanks the section: the door, the line and the button stay mounted, in the
//     same place in the tree whether the list is empty or not, so focus and the line's own state
//     (Undone) survive the list changing under them;
//   · onSheetOpenChange(open) tells the page while the door is open, so a sideways swipe or an arrow
//     key inside it cannot page to another planting with the sheet on screen.
// No "Start a batch instead" here (no onStartBatchInstead: the door then draws no such line).
import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react'
import { P, T } from '../../lib/tokens.js'
import PutUpPhotoThumb from '../PutUpPhotoThumb.jsx'
// V4-PUTUPSESSION-001 slice 1 — the "around" wording lives in exactly one module. This surface is
// the second reader of preserved_at (PutUp's RecordRow is the first) and would otherwise present a
// freezer-walk estimate as a date the user picked, which is the defect the slice exists to close.
import { describeApprox } from '../../lib/putUpSession.js'
// Put-Up release F: the jar's words come from the one module every put-up surface says them in. A jar
// may have NO size (the quantity pair is NULL from 1b — Put it up's "no size" rows, F's bottlings), and
// its quantity is the row's TOTAL (contract-F A3). Printed raw, that read "null null" and "Photo of null
// put up" here.
import { sizeWords } from '../putup/jarWords.js'
import { SOON_CHIP_STYLE } from '../putup/soonTint.js'
import PutSomethingUpSheet from '../pantry/PutSomethingUpSheet.jsx'
import CompletionLine from '../pantry/CompletionLine.jsx'
import { completionWords } from '../pantry/putSomethingUp.js'
import { isUsedUp, leftWords, plantingDiscardWords, isSoonOrPast, doorWhatOf } from './plantingKitchen.js'

// V4-PUTUPPROV-001 — NO PROVENANCE LINE HERE, AND THAT IS DELIBERATE. This component fetches
// whats-put-up?plant_id=<id>, so every row it can render has a non-null plant_id; the provenance
// design's client clear and its chk_preservation_log_source_plant CHECK together guarantee those
// rows are own_garden or NULL — both of which render nothing anyway. Adding the line here would be
// dead code that manufactures confidence provenance is visible in three places when it is visible
// in two (PutUp RecordRow and PutUpUseSoonBand). The D6 method label below IS needed.
// Put-Up R2a (UX 3.4 row 4): every VALUE is the one putup/putItUp.js METHOD_LABELS says — the door's and
// the Pantry's words — so a row here reads as the chip it was put up with (PutUpR2K.host.test.jsx binds them).
const METHOD_LABELS = {
  roast_freeze: 'Roast & freeze', whole_freeze: 'Freeze whole', blanch_freeze: 'Blanch & freeze',
  dehydrate: 'Dehydrate', powder: 'Powder', passata: 'Passata / sauce',
  can_water_bath: 'Water-bath can', can_pressure: 'Pressure can', jam_preserve: 'Jam / preserve',
  ferment: 'Ferment', cure_store: 'Cure & store', cold_store: 'Cold store',
  purchased_preserved: 'Bought already preserved',   // D6 (V4-PUTUPPROV-001)
  // V4-PUTUPTAXONOMY-001 (BD-034). This map is the least dangerous of the three — the row below falls
  // back to the raw slug — so an omission surfaces as "ferment_mash" rather than as a blank. Ugly
  // is still a defect, and the parity test binds all three regardless.
  quick_pickle: 'Quick / vinegar pickle', pesto: 'Pesto', hot_sauce: 'Hot sauce',
  ferment_mash: 'Fermenting mash (unfinished)',
  candy: 'Candied (pieces or sweets)',   // V5-PUTUPCANDY-001; R2a: the door's chip, not PutUp.jsx's picker
  other: 'Other',
}

// Local-time YYYY-MM-DD → friendly. The neon driver hands dates back as JS Date objects, so this
// accepts both (mirrors PutUp.jsx's ymd/prettyDate pair).
function prettyDate(v) {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(typeof v === 'string' && v.length === 10 ? v + 'T00:00:00' : v)
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// The section's one action: 48 px tall (UX pass R1), a BUTTON now (it opens the door here), drawn as the
// link it was.
const logLink = { display: 'inline-flex', alignItems: 'center', minHeight: T.buttonMinHeight, color: P.green,
  fontSize: '0.85rem', fontWeight: 600, textDecoration: 'underline',
  background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', cursor: 'pointer' }
// Put-Up R2a (UX seat, delta section 5). The button's words: before anything is put up, and after.
export const DOOR_FIRST_TEXT = 'Put something up from this planting'
export const DOOR_MORE_TEXT = 'Put up more from this planting'
// True after a "Fresh, as picked" save too: that is in the pantry, not put up, and lists under Kept fresh.
export const EMPTY_TEXT = 'Nothing put up from this planting yet.'

// B′ release 3 (V4 §2.5 "Planting page") — OPTIONAL props (the R2a two: the door still opens with them
// absent, and nobody is told):
//   onRows(rows)    the rows it shows, each time they are read (PlantingKitchen uses the ids to decide which
//                   batch reads "from <batch> →" on a jar row instead of as a row of its own);
//   renderExtra(r)  extra lines under a jar row ("from <batch> →", its "Next time…" lines);
//   onStockChanged()       (R2a) a save or an Undo here changed what this planting has: re-read your own;
//   onSheetOpenChange(on)  (R2a) the door opened (true) or closed (false); never called at rest.
// `now` (optional): the clock the date sentence is read against (a year is said only when it is not
// this one); a test pins it.
export default function PutUpFromPlanting({ planting, fetch, onRows, renderExtra, now, onStockChanged, onSheetOpenChange }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [doorOpen, setDoorOpen] = useState(false)
  const [completion, setCompletion] = useState(null)
  // Each line is its own: a second save gets a fresh line (with Undo), never the last one's "Undone".
  const [lineSeq, setLineSeq] = useState(0)
  const [reload, setReload] = useState(0)
  const nowDate = useMemo(() => (now != null ? new Date(now) : new Date()), [now])
  const what = useMemo(() => doorWhatOf(planting), [planting])

  // The planting whose rows are on screen. A read for the SAME planting (a re-read after a save or an Undo,
  // or the page handing down a fresh copy of the planting) replaces the rows when it answers and blanks
  // nothing meanwhile; a failed one leaves them as they were. Only a different planting starts over —
  // "Loading…", and no line from the last one.
  const shownForRef = useRef(null)
  useEffect(() => {
    if (!planting?.id) return
    let cancelled = false
    const again = shownForRef.current != null && String(shownForRef.current) === String(planting.id)
    if (!again) { setLoading(true); setFailed(false); setCompletion(null); setDoorOpen(false) }
    Promise.resolve(fetch(`/api/preservation/whats-put-up?plant_id=${planting.id}&include_consumed=1`))
      .then(data => {
        if (cancelled) return
        // Flatten groups → records, carrying the group's storage label down onto each row.
        const flat = (data?.groups ?? []).flatMap(g =>
          (g.records ?? []).map(r => ({ ...r, storage_label: g.label ?? null }))
        )
        flat.sort((a, b) => String(b.preserved_at ?? '').localeCompare(String(a.preserved_at ?? '')))
        shownForRef.current = planting.id
        setRows(flat)
        setLoading(false)
        onRows?.(flat)
      })
      .catch(() => { if (!cancelled && !again) { setFailed(true); setLoading(false) } })
    return () => { cancelled = true }
  }, [planting, fetch, reload])

  // The page is told while the door is open (and that it closed, if this unmounts with it open) — never
  // at rest.
  const sheetOpenRef = useRef(onSheetOpenChange)
  useEffect(() => { sheetOpenRef.current = onSheetOpenChange }, [onSheetOpenChange])
  useEffect(() => {
    if (!doorOpen) return undefined
    sheetOpenRef.current?.(true)
    return () => sheetOpenRef.current?.(false)
  }, [doorOpen])

  // Both of the page's reads, again: this list, and the kept-fresh read the page's kitchen section makes.
  const stockChanged = useCallback(() => {
    setReload(n => n + 1)
    onStockChanged?.()
  }, [onStockChanged])
  // The HOST closes the door on a save; the line says what the server answered (saved is its row).
  const onSaved = useCallback(({ route, saved, place }) => {
    setDoorOpen(false)
    setCompletion({ route, saved, place, text: completionWords({ route, saved, place, now: nowDate }) })
    setLineSeq(n => n + 1)
    stockChanged()
  }, [nowDate, stockChanged])

  if (failed) {
    return <div style={{ padding: '8px 0', color: P.light, fontSize: '0.85rem' }}>
      Couldn&rsquo;t load what&rsquo;s put up from this planting.
    </div>
  }
  if (loading) {
    return <div style={{ padding: '8px 0', color: P.light, fontSize: '0.875rem' }}>Loading&hellip;</div>
  }

  const empty = rows.length === 0
  const usedUp = rows.filter(isUsedUp)
  const inStores = rows.filter(r => !isUsedUp(r))

  return (
    <div>
      {/* What is still there first, then the used-up rows. Both are listed — a finished jar is the ANSWER
          to "where did it go", so hiding it would leave the section quieter the more of the harvest
          actually got eaten, which is backwards. A used row is dimmed and says "all used" instead of a
          count left; it never carries a date sentence. */}
      {empty ? (
        <div style={{ fontSize: '0.875rem', color: P.mid, marginBottom: 2 }}>{EMPTY_TEXT}</div>
      ) : (
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {[...inStores, ...usedUp].map((r, i) => {
          const used = isUsedUp(r)
          // The same headline the put-up list gives the row: its name and its size, either or neither.
          const head = [r.label, sizeWords(r)].filter(Boolean).join(' · ')
          const method = METHOD_LABELS[r.method] || r.method
          const putUp = prettyDate(r.preserved_at)
          const detail = [
            r.storage_label,
            used ? 'all used' : leftWords(r),
            putUp ? `put up ${describeApprox(putUp, r.preserved_at_approx === true)}` : null,
          ].filter(Boolean).join(' · ')
          const discard = plantingDiscardWords(r, nowDate)
          return (
            <li key={r.id} data-testid="putup-from-planting-row" data-used={used ? 'true' : undefined}
              style={{ padding: '10px 0', borderTop: i === 0 ? 'none' : `1px solid ${P.cream}`, display: 'flex', gap: 10, opacity: used ? 0.62 : 1 }}>
              <PutUpPhotoThumb photoId={r.photo_id} fetch={fetch} size={36}
                alt={`Photo of ${head || String(method ?? 'this put-up').toLowerCase()}`} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div data-testid="putup-from-planting-head" style={{ fontSize: T.type.base, color: P.dark, fontWeight: 600 }}>
                  {head}
                  <span style={{ color: P.mid, fontWeight: 400 }}>
                    {head ? ' · ' : ''}{method}
                    {r.method === 'other' && r.method_other_text ? ` (${r.method_other_text})` : ''}
                  </span>
                </div>
                <div data-testid="putup-from-planting-detail" style={{ fontSize: T.type.sm, color: P.mid, marginTop: 2 }}>{detail}</div>
                {discard && (
                  <div style={{ marginTop: 2 }}>
                    <span data-testid="putup-from-planting-discard" data-soon={isSoonOrPast(r) ? 'true' : undefined}
                      style={{ display: 'inline-block', fontSize: T.type.sm, color: P.mid, overflowWrap: 'anywhere', ...(isSoonOrPast(r) ? SOON_CHIP_STYLE : null) }}>
                      {discard}
                    </span>
                  </div>
                )}
                {renderExtra?.(r)}
              </div>
            </li>
          )
        })}
      </ul>
      )}

      {/* The saved line, then the button: ONE place in the tree whether the list is empty or not, so the
          first put-up turning "Put something up…" into "Put up more…" keeps focus on the same button, and
          an Undo that empties the list keeps the line's own "Undone". No name to say → no door. */}
      {what && (
        <div style={{ marginTop: empty ? 0 : 2 }}>
          {completion && (
            <CompletionLine key={lineSeq} completion={completion} fetch={fetch}
              onDone={() => setCompletion(null)} onChanged={stockChanged} />
          )}
          <button type="button" data-testid="putup-from-planting-door" onClick={() => setDoorOpen(true)} style={logLink}>
            {empty ? DOOR_FIRST_TEXT : DOOR_MORE_TEXT}
          </button>
        </div>
      )}
      <PutSomethingUpSheet open={doorOpen} initialWhat={what} stockRows={null} now={now}
        onClose={() => setDoorOpen(false)} onSaved={onSaved} />
    </div>
  )
}
