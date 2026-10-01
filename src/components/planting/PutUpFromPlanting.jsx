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
// contract. The two links go out to Put-Up's Log form carrying this planting as prefill, which is the
// only action this section offers.
import React, { useMemo, useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
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
import { isUsedUp, leftWords, plantingDiscardWords, isSoonOrPast } from './plantingKitchen.js'

// V4-PUTUPPROV-001 — NO PROVENANCE LINE HERE, AND THAT IS DELIBERATE. This component fetches
// whats-put-up?plant_id=<id>, so every row it can render has a non-null plant_id; the provenance
// design's client clear and its chk_preservation_log_source_plant CHECK together guarantee those
// rows are own_garden or NULL — both of which render nothing anyway. Adding the line here would be
// dead code that manufactures confidence provenance is visible in three places when it is visible
// in two (PutUp RecordRow and PutUpUseSoonBand). The D6 method label below IS needed.
const METHOD_LABELS = {
  roast_freeze: 'Roast & freeze', whole_freeze: 'Freeze', blanch_freeze: 'Blanch & freeze',
  dehydrate: 'Dehydrate', powder: 'Powder', passata: 'Passata / sauce',
  can_water_bath: 'Water-bath can', can_pressure: 'Pressure can', jam_preserve: 'Jam / preserve',
  ferment: 'Ferment', cure_store: 'Cure & store', cold_store: 'Cold store',
  purchased_preserved: 'Bought already preserved',   // D6 (V4-PUTUPPROV-001)
  // V4-PUTUPTAXONOMY-001 (BD-034). This map is the least dangerous of the three — the row below falls
  // back to the raw slug — so an omission surfaces as "ferment_mash" rather than as a blank. Ugly
  // is still a defect, and the parity test binds all three regardless.
  quick_pickle: 'Quick / vinegar pickle', pesto: 'Pesto', hot_sauce: 'Hot sauce',
  ferment_mash: 'Fermenting mash (unfinished)',
  candy: 'Candied',   // V5-PUTUPCANDY-001 — matches PutUp.jsx's picker label
  other: 'Other',
}

// Local-time YYYY-MM-DD → friendly. The neon driver hands dates back as JS Date objects, so this
// accepts both (mirrors PutUp.jsx's ymd/prettyDate pair).
function prettyDate(v) {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(typeof v === 'string' && v.length === 10 ? v + 'T00:00:00' : v)
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// The two links out to the Log form: 48 px tall (UX pass R1), their words and their destination unchanged.
const logLink = { display: 'inline-flex', alignItems: 'center', minHeight: T.buttonMinHeight, color: P.green,
  fontSize: '0.85rem', fontWeight: 600, textDecoration: 'underline' }

// B′ release 3 (V4 §2.5 "Planting page") — two OPTIONAL props, both absent = exactly the shipped render:
//   onRows(rows)    the rows it shows, once loaded (PlantingKitchen uses the ids to decide which batch
//                   reads "from <batch> →" on a jar row instead of as a row of its own);
//   renderExtra(r)  extra lines under a jar row ("from <batch> →", its "Next time…" lines).
// `now` (optional): the clock the date sentence is read against (a year is said only when it is not
// this one); a test pins it.
export default function PutUpFromPlanting({ planting, fetch, onRows, renderExtra, now }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const nowDate = useMemo(() => (now != null ? new Date(now) : new Date()), [now])

  useEffect(() => {
    if (!planting?.id) return
    let cancelled = false
    setLoading(true); setFailed(false)
    Promise.resolve(fetch(`/api/preservation/whats-put-up?plant_id=${planting.id}&include_consumed=1`))
      .then(data => {
        if (cancelled) return
        // Flatten groups → records, carrying the group's storage label down onto each row.
        const flat = (data?.groups ?? []).flatMap(g =>
          (g.records ?? []).map(r => ({ ...r, storage_label: g.label ?? null }))
        )
        flat.sort((a, b) => String(b.preserved_at ?? '').localeCompare(String(a.preserved_at ?? '')))
        setRows(flat)
        setLoading(false)
        onRows?.(flat)
      })
      .catch(() => { if (!cancelled) { setFailed(true); setLoading(false) } })
    return () => { cancelled = true }
  }, [planting, fetch])

  // Prefill for the "log one" link — crop/variety ride along so Put-Up opens fully attributed.
  const prefill = {
    plant_id: planting?.id,
    ...(planting?.variety_ref?.crop_type_slug ? { crop_type_slug: planting.variety_ref.crop_type_slug } : {}),
    ...(planting?.variety_id ?? planting?.variety_ref?.id
      ? { variety_id: planting.variety_id ?? planting.variety_ref?.id } : {}),
  }

  if (failed) {
    return <div style={{ padding: '8px 0', color: P.light, fontSize: '0.85rem' }}>
      Couldn&rsquo;t load what&rsquo;s put up from this planting.
    </div>
  }
  if (loading) {
    return <div style={{ padding: '8px 0', color: P.light, fontSize: '0.875rem' }}>Loading&hellip;</div>
  }

  if (rows.length === 0) {
    return (
      <div>
        <div style={{ fontSize: '0.875rem', color: P.mid, marginBottom: 2 }}>
          Nothing from this planting is in the Pantry yet.
        </div>
        <Link to="/put-up" state={{ prefill }} style={logLink}>
          Log a put-up from this planting
        </Link>
      </div>
    )
  }

  const usedUp = rows.filter(isUsedUp)
  const inStores = rows.filter(r => !isUsedUp(r))

  return (
    <div>
      {/* What is still there first, then the used-up rows. Both are listed — a finished jar is the ANSWER
          to "where did it go", so hiding it would leave the section quieter the more of the harvest
          actually got eaten, which is backwards. A used row is dimmed and says "all used" instead of a
          count left; it never carries a date sentence. */}
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

      <div style={{ marginTop: 2 }}>
        <Link to="/put-up" state={{ prefill }} style={logLink}>
          Log another from this planting
        </Link>
      </div>
    </div>
  )
}
