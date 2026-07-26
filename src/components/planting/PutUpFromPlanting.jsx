// PutUpFromPlanting — V4-PUTUPLINK-001. "What came off THIS planting and is still in the stores."
// The read end of the seed → planting → harvest → put-up spine: PutUp.jsx writes preservation_log
// .plant_id, this renders it back on the planting that produced it.
//
// Data: GET /api/preservation/whats-put-up?plant_id=<id>. The Lambda returns storage-grouped
// records already scoped to the planting (and already excluding soft-deleted + fully-consumed
// rows), so this flattens the groups and keeps each group's label as the row's storage location —
// there is no per-record storage_label on the projection.
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
    Promise.resolve(fetch(`/api/preservation/whats-put-up?plant_id=${planting.id}`))
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

  // Headline counts PACKAGES and LISTS the distinct units — never a cross-unit sum (L5), the same
  // rule the Put-Up inventory headline follows. "6 lbs + 3 jars" is not 9 of anything.
  const totalPackages = rows.reduce((n, r) => n + (Number(r.package_count) || 0), 0)
  const units = [...new Set(rows.map(r => r.quantity_unit).filter(Boolean))]
  const useSoon = rows.filter(r => r.use_by_status === 'use_soon' || r.use_by_status === 'past_use_by').length

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div style={{ fontSize: '0.875rem', color: P.mid }}>
          <strong style={{ color: P.dark }}>
            {totalPackages} {totalPackages === 1 ? 'container' : 'containers'}
          </strong>
          {units.length ? ` · ${units.join(', ')}` : ''}
          {` · ${rows.length} ${rows.length === 1 ? 'put-up' : 'put-ups'}`}
        </div>
        {useSoon > 0 && (
          <span style={{ fontSize: '0.7rem', fontWeight: 700, color: P.gold, backgroundColor: P.warn,
            border: `1px solid ${P.warnBorder}`, borderRadius: 999, padding: '2px 8px', flexShrink: 0 }}>
            {useSoon} use soon
          </span>
        )}
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map(r => {
          const remaining = r.remaining_count ?? r.package_count ?? 0
          return (
            <li key={r.id} style={{ padding: '10px 0', borderTop: `1px solid ${P.cream}`, display: 'flex', gap: 10 }}>
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
                {remaining !== r.package_count ? ` · ${remaining} left` : ''}
                {r.use_by_target ? ` · use by ${prettyDate(r.use_by_target)}` : ''}
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
