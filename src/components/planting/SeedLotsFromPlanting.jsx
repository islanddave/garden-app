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
import { formatQty, formatSeedWeight } from '../../lib/format.js'
import { seedStageLabel } from '../seed/seedStages.js'
import { seedCountLabel } from '../seed/seedLots.js'

// The container, on a list where every row is a SAVED lot (V5-SEEDQTY-001: quantity_on_hand is the
// jar). One jar is the convention every saved lot carries, so it says nothing and is left out — Dave,
// 2026-09-25, of "1 packet": "not correct ever". 0 is the lot used up, said in those words. Any other
// amount is a real one somebody recorded (prod holds one saved lot at 272 'each') and keeps its number.
// NULL is "never recorded" and says nothing, as before. Exported for test.
export function lotContainerLabel(q) {
  if (q == null || q === '') return null
  const n = Number(q)
  if (n === 1) return null
  if (n === 0) return 'used up'
  return `${formatQty(q)} on hand`
}

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
        // The jar, by lotContainerLabel's rule: nothing for the one jar every saved lot is, "used up"
        // for 0 (explicit zero is "none left"; NULL is "never counted" and renders nothing — the
        // reading sowEngine's isDepleted takes of this column), and "N on hand" for any other amount.
        const container = lotContainerLabel(lot.quantity_on_hand)
        // V5-SEEDQTY-001 — the seeds themselves, which is what a gardener came here to read, in the
        // words every seed surface uses (seedLots.seedCountLabel): "185 seeds", or "approx. 185 seeds"
        // for a number taken off a packet rather than counted — the route projects
        // seed_count_estimated since 2026-09-25, when 8 of the 13 counted lots linked to a planting on
        // prod were estimates this line showed as exact.
        //
        // ABSENT AND NULL BOTH RENDER NOTHING: a row without the keys (an older Lambda, a stubbed
        // read) and a lot nobody counted read alike, and an explicit 0 survives — a counted-empty jar
        // reads "0 seeds", which is a fact somebody recorded, where nothing at all means nobody has
        // counted. An absent basis reads as counted, the historical default.
        const seeds = seedCountLabel(lot.seed_count, lot.seed_count_estimated) || null
        const weight = formatSeedWeight(lot.seed_weight_g) || null
        const meta = [variety, stage, seeds, weight, container].filter(Boolean)
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
