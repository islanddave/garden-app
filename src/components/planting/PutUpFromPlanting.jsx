// PutUpFromPlanting — V4-PUTUPLINK-001. "What came off THIS planting, and what became of it."
// The read end of the seed → planting → harvest → put-up spine: PutUp.jsx writes preservation_log
// .plant_id, this renders it back on the planting that produced it.
//
// Data: GET /api/preservation/whats-put-up?plant_id=<id>&include_consumed=1. The Lambda returns
// storage-grouped records already scoped to the planting, so this flattens the groups and keeps each
// group's label as the row's storage location — there is no per-record storage_label on the
// projection.
//
// V4-HARVESTFATE-001 — WHY include_consumed, and why this section is now two readings rather than
// one. The endpoint's default drops a fully-consumed jar, which is correct for the Put-Up inventory
// page ("what is in the freezer") and WRONG here: this is the only surface that answers "where did
// this planting's harvest go", and on the default the answer silently reverts to "nothing" the day
// the last jar is finished. So the fetch keeps consumed rows and the component separates them —
// STORES (still there, the headline) and USED (gone, but still the planting's history). The fate
// reading is a COUNT AND A LIST, never a fraction: harvests are counted in count/cup/head/bunch and
// put-ups in quarts/cups, only cup↔cups overlaps, and preservation_log has no weight column at all
// (live prod, 2026-08-24). "40% preserved" is not computable from this data and would be invented.
//
// Zero live rows are consumed today, so this renders identically to before until the first jar is
// finished. That is the point: the gap is invisible right up until it eats a record.
//
// Deliberately READ-ONLY. Edit / "mark used" / remove all live on the Put-Up surface; duplicating
// the mutation affordances here would mean two places to keep in step with the PUT full-replace
// contract. The empty state links out to Put-Up carrying this planting as prefill, which is the
// only action this section offers.
import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../../lib/constants.js'
import PutUpPhotoThumb from '../PutUpPhotoThumb.jsx'

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
  // V4-PUTUPTAXONOMY-001 (BD-034). This map is the least dangerous of the three — line 165 falls
  // back to the raw slug — so an omission surfaces as "ferment_mash" rather than as a blank. Ugly
  // is still a defect, and the parity test binds all three regardless.
  quick_pickle: 'Quick / vinegar pickle', pesto: 'Pesto', hot_sauce: 'Hot sauce',
  ferment_mash: 'Fermenting mash (unfinished)',
  other: 'Other',
}

// Local-time YYYY-MM-DD → friendly. The neon driver hands dates back as JS Date objects, so this
// accepts both (mirrors PutUp.jsx's ymd/prettyDate pair).
function prettyDate(v) {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(typeof v === 'string' && v.length === 10 ? v + 'T00:00:00' : v)
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function PutUpFromPlanting({ planting, fetch }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

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
        <div style={{ fontSize: '0.875rem', color: P.mid, marginBottom: 10 }}>
          Nothing from this planting is in the stores yet.
        </div>
        <Link to="/put-up" state={{ prefill }}
          style={{ color: P.green, fontSize: '0.85rem', fontWeight: 600, textDecoration: 'underline' }}>
          Log a put-up from this planting
        </Link>
      </div>
    )
  }

  // A row is USED UP only on an explicit zero. NULL remaining_count means the count was never
  // tracked, not that the jar is gone — the same reading the endpoint's own default filter uses
  // (`remaining_count IS NULL OR remaining_count > 0`), so the two cannot disagree about which rows
  // the un-flagged call would have returned.
  const isUsedUp = (r) => r.remaining_count != null && Number(r.remaining_count) <= 0
  const usedUp = rows.filter(isUsedUp)
  const inStores = rows.filter(r => !isUsedUp(r))

  // Headline counts PACKAGES and LISTS the distinct units — never a cross-unit sum (L5), the same
  // rule the Put-Up inventory headline follows. "6 lbs + 3 jars" is not 9 of anything.
  // The container count and the unit list describe the STORES; the put-up count is the planting's
  // whole history. Two different questions, so two different denominators, said out loud rather
  // than blended into one number that answers neither.
  const totalPackages = inStores.reduce((n, r) => n + (Number(r.package_count) || 0), 0)
  const units = [...new Set(inStores.map(r => r.quantity_unit).filter(Boolean))]
  // A finished jar cannot be "use soon" — the prompt is to eat it and it has been eaten.
  const useSoon = inStores.filter(r => r.use_by_status === 'use_soon' || r.use_by_status === 'past_use_by').length

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div style={{ fontSize: '0.875rem', color: P.mid }}>
          <strong style={{ color: P.dark }}>
            {inStores.length === 0
              ? 'Nothing left in the stores'
              : `${totalPackages} ${totalPackages === 1 ? 'container' : 'containers'}`}
          </strong>
          {units.length ? ` · ${units.join(', ')}` : ''}
          {` · ${rows.length} ${rows.length === 1 ? 'put-up' : 'put-ups'}`}
          {usedUp.length > 0 ? ` · ${usedUp.length} used up` : ''}
        </div>
        {useSoon > 0 && (
          <span style={{ fontSize: '0.7rem', fontWeight: 700, color: P.gold, backgroundColor: P.warn,
            border: `1px solid ${P.warnBorder}`, borderRadius: 999, padding: '2px 8px', flexShrink: 0 }}>
            {useSoon} use soon
          </span>
        )}
      </div>

      {/* Stores first, then the used-up rows. Both are listed — a finished jar is the ANSWER to
          "where did it go", so hiding it would leave the section quieter the more of the harvest
          actually got eaten, which is backwards. A used row is dimmed and says "all used" instead of
          a remaining count; it never carries a use-by prompt. */}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {[...inStores, ...usedUp].map(r => {
          const used = isUsedUp(r)
          const remaining = r.remaining_count ?? r.package_count ?? 0
          return (
            <li key={r.id} style={{ padding: '10px 0', borderTop: `1px solid ${P.cream}`, display: 'flex', gap: 10, opacity: used ? 0.62 : 1 }}>
              <PutUpPhotoThumb photoId={r.photo_id} fetch={fetch} size={36}
                alt={`Photo of ${r.quantity_unit} put up`} />
              <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.9rem', color: P.dark, fontWeight: 600 }}>
                {r.quantity_value} {r.quantity_unit}
                <span style={{ color: P.mid, fontWeight: 400 }}>
                  {' · '}{METHOD_LABELS[r.method] || r.method}
                  {r.method === 'other' && r.method_other_text ? ` (${r.method_other_text})` : ''}
                </span>
              </div>
              <div style={{ fontSize: '0.78rem', color: P.light, marginTop: 2 }}>
                {r.storage_label ? `${r.storage_label} · ` : ''}
                put up {prettyDate(r.preserved_at)}
                {used ? ' · all used' : (remaining !== r.package_count ? ` · ${remaining} left` : '')}
                {!used && r.use_by_target ? ` · use by ${prettyDate(r.use_by_target)}` : ''}
              </div>
              </div>
            </li>
          )
        })}
      </ul>

      <div style={{ marginTop: 12 }}>
        <Link to="/put-up" state={{ prefill }}
          style={{ color: P.green, fontSize: '0.85rem', fontWeight: 600, textDecoration: 'underline' }}>
          Log another from this planting
        </Link>
      </div>
    </div>
  )
}
