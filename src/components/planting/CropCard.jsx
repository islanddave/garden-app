// V4-PLANTINGUI-001 — per-crop attribute slot (binds to PLANTTYPE substrate). Surfaces the
// computed maturity/harvest band + the cultivar's structured attributes + projected
// type:/lifecycle: faceted chips (GARDENIA bulk-tags substrate via useEntityTags).
import React from 'react'
import { P } from '../../lib/constants.js'
import { computeMaturity } from '../../lib/plantingMaturity.js'
import { useEntityTags } from '../../hooks/useTags.js'
import TagChip from '../forms/TagChip.jsx'

function Attr({ label, value }) {
  if (value == null || value === '') return null
  return (
    <div>
      <div style={{ fontSize: '0.72rem', fontWeight: 600, color: P.light, marginBottom: 2,
        textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
      <div style={{ fontSize: '0.9rem', color: P.dark, lineHeight: 1.5, wordBreak: 'break-word' }}>{value}</div>
    </div>
  )
}

export default function CropCard({ planting }) {
  const { projected } = useEntityTags('plant', planting?.id)
  const m = computeMaturity(planting)
  const v = planting?.variety_ref || {}

  const dtm = (v.days_to_maturity_min != null || v.days_to_maturity_max != null)
    ? (v.days_to_maturity_min != null && v.days_to_maturity_max != null && v.days_to_maturity_min !== v.days_to_maturity_max
        ? `${v.days_to_maturity_min}–${v.days_to_maturity_max} days`
        : `${v.days_to_maturity_min ?? v.days_to_maturity_max} days`)
    : null

  const hasMaturity = m.ageDays != null || m.harvestWindowLabel
  const hasChips = Array.isArray(projected) && projected.length > 0
  const attrs = [dtm, v.sun_requirements, v.expected_yield_notes].filter(Boolean)
  if (!hasMaturity && !hasChips && attrs.length === 0) return null

  return (
    <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 24,
      display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* maturity band */}
      {hasMaturity && (
        <div>
          {m.ageDays != null && (
            <div style={{ fontSize: '0.95rem', fontWeight: 700, color: P.green }}>
              Day {m.ageDays}{m.anchorLabel ? ` since ${m.anchorLabel}` : ''}
            </div>
          )}
          {m.harvestWindowLabel && (
            <div style={{ fontSize: '0.82rem', color: m.isMature ? P.green : P.mid, marginTop: 3 }}>
              {m.isMature ? '✅ ' : '⏳ '}{m.harvestWindowLabel}
            </div>
          )}
          {/* progress bar toward maturity */}
          {m.pctToMaturity != null && !m.isMature && (
            <div style={{ marginTop: 8, height: 6, backgroundColor: P.greenPale, borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${Math.round(m.pctToMaturity * 100)}%`, height: '100%', backgroundColor: P.green }} />
            </div>
          )}
        </div>
      )}

      {/* projected faceted chips */}
      {hasChips && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {projected.map(t => <TagChip key={`${t.facet}:${t.slug}`} tag={t} />)}
        </div>
      )}

      {/* structured cultivar attributes */}
      {attrs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Attr label="Days to maturity" value={dtm} />
          <Attr label="Sun" value={v.sun_requirements} />
          <Attr label="Expected yield" value={v.expected_yield_notes} />
        </div>
      )}
    </div>
  )
}
