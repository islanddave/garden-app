// src/components/planting/PlantingKitchen.jsx
// B′ release 3 — the planting page's kitchen section (V4 §2.5 "Planting page"): what was put up from the
// planting (the shipped PutUpFromPlanting, now with "from <batch> →" and each jar's "Next time…" lines),
// what is kept fresh from it (pantry items with this plant_id) and every batch that used it — directly or
// through stock drawn from it. A list, never a sum or a percentage. Plain markup; no new visual design.
//
// One read: GET /api/kitchen-batches?plant_id=. If it fails or answers nothing, the shipped put-up list
// still renders exactly as before and the two new lists stay away (no error state on a planting page).
//
// Put-Up UX pass R1: a link to a batch is a 48 px target and carries where it came from (router state
// `from`, putup/origin.js), so the batch's Back can read "← <this planting>" and return here; a stored
// "Next time (2026-09-02): …" line is read as "Next time: … · Sep 2" (putup/howItWasMade.js nextTimeWords,
// the same reading the Pantry's row sheet gives it).
import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { P, T } from '../../lib/tokens.js'
import PutUpFromPlanting from './PutUpFromPlanting.jsx'
import { nextTimeLines, nextTimeWords } from '../putup/howItWasMade.js'
import { plantingBatchesPath, batchHref, batchLinkState, batchByJar, listedBatches, batchNextTime, usedWords } from './plantingKitchen.js'

const sub = { fontSize: '0.8rem', fontWeight: 700, color: P.mid, margin: '14px 0 4px' }
const li = { padding: '8px 0', borderTop: `1px solid ${P.cream}`, fontSize: '0.875rem', color: P.dark }
const quiet = { fontSize: '0.78rem', color: P.light, marginTop: 2 }
// A link to a batch: its words as they were, on a 48 px target.
const batchLink = { display: 'inline-flex', alignItems: 'center', minHeight: T.buttonMinHeight, color: P.green }

function NextTime({ lines, testid, now }) {
  if (!lines?.length) return null
  return (
    <ul data-testid={testid} style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: T.type.sm, color: P.mid }}>
      {lines.map(n => <li key={n}>{nextTimeWords(n, now)}</li>)}
    </ul>
  )
}

// `now` (optional): the clock dates are read against; a test pins it.
export default function PlantingKitchen({ planting, fetch, now }) {
  const [data, setData] = useState(null)
  const [shown, setShown] = useState([])
  const nowDate = useMemo(() => (now != null ? new Date(now) : new Date()), [now])

  useEffect(() => {
    if (!planting?.id) return undefined
    let alive = true
    Promise.resolve(fetch(plantingBatchesPath(planting.id)))
      .then(r => { if (alive) setData(r && Array.isArray(r.batches) ? r : null) })
      .catch(() => { if (alive) setData(null) })
    return () => { alive = false }
  }, [planting, fetch])

  const batches = data?.batches ?? []
  const fresh = data?.kept_fresh ?? []
  const byJar = batchByJar(batches)
  const listed = listedBatches(batches, shown)
  const linkState = batchLinkState(planting)

  return (
    <div data-testid="planting-kitchen">
      <PutUpFromPlanting planting={planting} fetch={fetch} now={now} onRows={rows => setShown(rows.map(r => r.id))}
        renderExtra={r => {
          const b = byJar.get(r.id)
          return (
            <>
              {b && <div style={{ fontSize: T.type.sm }}><Link to={batchHref(b.id)} state={linkState} data-testid={`planting-jar-batch-${r.id}`}
                style={batchLink}>from {b.label} →</Link></div>}
              <NextTime lines={[...(b ? batchNextTime(b) : []), ...nextTimeLines(r.notes)]} testid={`planting-jar-next-${r.id}`} now={nowDate} />
            </>
          )
        }} />

      {fresh.length > 0 && (
        <section aria-label="Kept fresh" data-testid="planting-kept-fresh">
          <div style={sub}>Kept fresh</div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {fresh.map(f => (
              <li key={f.id} style={{ ...li, opacity: f.used_up_at ? 0.62 : 1 }} data-testid={`planting-fresh-${f.id}`}>
                {f.name}
                <div style={quiet}>{[f.place_label, f.used_up_at ? 'used up' : null].filter(Boolean).join(' · ')}</div>
                <NextTime lines={f.next_time} testid={`planting-fresh-next-${f.id}`} now={nowDate} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {listed.length > 0 && (
        <section aria-label="Went into batches" data-testid="planting-batches">
          <div style={sub}>Went into batches</div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {listed.map(b => (
              <li key={b.id} style={li} data-testid={`planting-batch-${b.id}`}>
                <Link to={batchHref(b.id)} state={linkState} style={{ ...batchLink, fontWeight: 600 }}>{b.label} →</Link>
                <div style={quiet}>{usedWords(b)}</div>
                <NextTime lines={batchNextTime(b)} testid={`planting-batch-next-${b.id}`} now={nowDate} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
