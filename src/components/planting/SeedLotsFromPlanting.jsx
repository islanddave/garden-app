// SeedLotsFromPlanting — V4-SEEDREVERSE-001. "Did I already save seed from this one?"
//
// The read end of inventory_items.source_plant_id. V4-SEEDLINK-001 shipped the column and the index
// for THIS direction (migrations/v4-seedlink-001/0a-additive-ddl.sql:48 — "It is also the index for
// 'which lots came from this plant?'") and nothing ever queried it: the packet knew its parent
// planting, the planting knew nothing about its packets. Now that a save-seed control lives on
// planting detail, the next thing a user does is come back and look for the answer here.
//
// Data: GET /api/plants/:id/seed-lots -> { plant_id, seed_lots: [...] }. Self-fetching, like
// HarvestFromPlanting and PutUpFromPlanting; it does not widen /api/plants/:id, which is already
// the app's largest response body.
//
// SPLIT INTO A HOOK AND A VIEW, and the split is the whole reason the section can stay off an empty
// page. PlantingDetail renders its own sticky SectionHeader plus the card chrome AROUND a child, so
// a child that returns null still leaves a heading over an empty box on every planting that has
// never had seed saved from it. The page calls the hook, and renders the heading only when the hook
// has something to say.
//
// THE ERROR BRANCH IS NOT THE EMPTY BRANCH. A failed request rendering as "no seed saved" would be a
// different and worse claim than "we could not check" — it is the one answer that makes a user stop
// looking for a lot they really do have. So `failed` is surfaced as its own state and the page
// treats it as content: heading, card, and a line that says the check did not complete.
import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { formatQty } from '../../lib/format.js'
import { seedStageLabel } from '../seed/seedStages.js'

// { lots, failed, loading }. `loading` renders as nothing at all rather than as a skeleton: the
// section has no reserved space on the page, so a placeholder would be a block appearing and
// disappearing above the fold on every planting.
export function useSeedLotsFromPlanting(plantingId, fetch) {
  const [lots, setLots] = useState([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!plantingId) return
    let cancelled = false
    setLoading(true); setFailed(false)
    Promise.resolve(fetch(`/api/plants/${plantingId}/seed-lots`))
      .then(data => {
        if (cancelled) return
        setLots(Array.isArray(data?.seed_lots) ? data.seed_lots : [])
        setLoading(false)
      })
      .catch(() => { if (!cancelled) { setFailed(true); setLoading(false) } })
    return () => { cancelled = true }
  }, [plantingId, fetch])

  return { lots, loading, failed }
}

// True when the section is worth a heading: something to show, or something to admit.
export const seedLotsWorthRendering = (state) => state.failed || state.lots.length > 0

export default function SeedLotsFromPlanting({ lots, failed }) {
  if (failed) {
    return (
      <div style={{ fontSize: T.type.sm, color: P.mid }}>
        Couldn&rsquo;t check for seed saved from this planting. This is not the same as
        &ldquo;none saved&rdquo; &mdash; reload to try again.
      </div>
    )
  }

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {lots.map((lot, i) => {
        // The lot's own name is the packet label the user typed; the variety is what the cultivar
        // is actually called. Show the variety only when it adds something — on a lot named after
        // its variety (the common case) repeating it reads as a stutter.
        const variety = lot.variety_name && lot.variety_name !== lot.name ? lot.variety_name : null
        const stage = lot.seed_stage ? seedStageLabel(lot.seed_stage) : null
        // Explicit zero is "none left"; NULL is "never counted", which is not the same claim and
        // must not render as 0. Same reading sowEngine's isDepleted takes of this column.
        const qty = lot.quantity_on_hand == null ? null : formatQty(lot.quantity_on_hand)
        const meta = [variety, stage, qty == null ? null : `${qty} on hand`].filter(Boolean)
        return (
          <li
            key={lot.id}
            style={{
              padding: '10px 0',
              borderTop: i === 0 ? 'none' : `1px solid ${P.cream}`,
            }}
          >
            <Link
              to={`/inventory/${lot.id}`}
              style={{
                display: 'block', textDecoration: 'none',
                fontSize: T.type.sm2, fontWeight: 600, color: P.green,
              }}
            >
              {lot.name || 'Untitled seed lot'}
            </Link>
            {meta.length > 0 && (
              <div style={{ fontSize: T.type.xs, color: P.light, marginTop: 2 }}>
                {meta.join(' · ')}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
