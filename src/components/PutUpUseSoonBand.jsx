// src/components/PutUpUseSoonBand.jsx
// V4-HARVESTCENTER-001 (L10) — the "use soon" ambient card on the Today surface. Mirrors TodayBand's
// data posture: useApiFetch, refresh on mount / in-app nav / app-foreground, and the fetch error is
// SWALLOWED (supplementary glance — it must never throw or surface an error onto Today).
//
// NEUTRAL framing (Reward-UX + Notification rules): "cook these next" / "from your stores" — NO
// loss-aversion ("don't let it rot"), NO "X days left" countdown (streak-psychology through the back
// door), NO push. `past_use_by` rows render as a distinct CALM state (a quiet "past date" tag), not an
// alarm. The whole card is hidden when there is nothing to surface. Reads /api/preservation/use-soon,
// whose server-side shelf-life window (L6) already decides membership — this component only presents.
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useOverlayLocation, useOverlayNavigate } from '../context/OverlayContext.jsx'
import { useApiFetch } from '../lib/api.js'
import { P } from '../lib/constants.js'

const METHOD_LABELS = {
  roast_freeze: 'roasted & frozen', whole_freeze: 'frozen', blanch_freeze: 'blanched & frozen',
  dehydrate: 'dehydrated', powder: 'powder', passata: 'passata', can_water_bath: 'canned',
  can_pressure: 'pressure-canned', jam_preserve: 'jam', ferment: 'fermented',
  cure_store: 'cured', cold_store: 'cold-stored', other: 'put up',
}

function itemTitle(it) {
  const crop = it.crop_display_name || it.crop_type_slug || 'From your stores'
  return crop
}
function itemDetail(it) {
  const parts = []
  if (it.quantity_value != null && it.quantity_unit) parts.push(`${it.quantity_value} ${it.quantity_unit}`)
  const m = METHOD_LABELS[it.method]
  if (m) parts.push(m)
  if (it.storage_label) parts.push(`in ${it.storage_label}`)
  return parts.join(' · ')
}

export default function PutUpUseSoonBand() {
  const { fetch } = useApiFetch()
  const location = useOverlayLocation()
  const overlayNavigate = useOverlayNavigate()
  const [items, setItems] = useState(null)
  const inflight = useRef(false)

  const load = useCallback(() => {
    if (inflight.current) return
    inflight.current = true
    fetch('/api/preservation/use-soon')
      .then(d => setItems(Array.isArray(d?.items) ? d.items : []))
      .catch(() => { /* supplementary glance — never surface a fetch error */ })
      .finally(() => { inflight.current = false })
  }, [fetch])

  useEffect(() => { load() }, [load, location.pathname])

  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    window.addEventListener('focus', load)
    document.addEventListener('visibilitychange', onVis)
    return () => { window.removeEventListener('focus', load); document.removeEventListener('visibilitychange', onVis) }
  }, [load])

  // Hidden entirely when empty (or before the first load resolves).
  if (!items || items.length === 0) return null

  const shown = items.slice(0, 5)
  const more = items.length - shown.length

  return (
    <section
      aria-label="From your stores — cook these next"
      style={{
        backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 12,
        padding: '14px 16px', marginTop: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: P.light }}>
            From your stores
          </div>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: P.dark }}>Cook these next</div>
        </div>
        <button
          type="button"
          onClick={() => overlayNavigate('/put-up')}
          style={{ background: 'none', border: 'none', color: P.green, cursor: 'pointer', fontSize: '0.82rem',
            fontWeight: 600, fontFamily: 'inherit', textDecoration: 'underline', padding: 4, flexShrink: 0 }}
        >
          Open Put-Up
        </button>
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {shown.map(it => {
          const past = it.use_by_status === 'past_use_by'
          return (
            <li key={it.id} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 600, color: P.dark, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {itemTitle(it)}
                </div>
                <div style={{ fontSize: '0.78rem', color: P.light, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {itemDetail(it)}
                </div>
              </div>
              {past && (
                // Distinct CALM state (not alarm): a quiet neutral tag, no red, no countdown.
                <span style={{ fontSize: '0.68rem', fontWeight: 600, color: P.mid, backgroundColor: P.cream,
                  border: `1px solid ${P.border}`, borderRadius: 999, padding: '2px 8px', flexShrink: 0 }}>
                  past date
                </span>
              )}
            </li>
          )
        })}
      </ul>

      {more > 0 && (
        <div style={{ fontSize: '0.78rem', color: P.light, marginTop: 8 }}>
          +{more} more in your stores
        </div>
      )}
    </section>
  )
}
