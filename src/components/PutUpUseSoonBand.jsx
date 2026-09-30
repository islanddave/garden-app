// src/components/PutUpUseSoonBand.jsx
// V4-HARVESTCENTER-001 (L10) — the "use soon" ambient card on the Today surface. Mirrors TodayBand's
// data posture: useApiFetch, refresh on mount / in-app nav / app-foreground, and the fetch error is
// SWALLOWED (supplementary glance — it must never throw or surface an error onto Today).
// BUG-READYBANDFETCH-001: swallowing still holds, but a failed fetch no longer renders identically to
// an empty shelf — useAmbientBandFetch retries once, then this renders one muted ambient line.
//
// Put-Up B′ release 2 (V4 §2.5 rename bridge): "stores" swept to "the Pantry" — words only; the fetch,
// the props and the default export are unchanged (Today V2 mounts this band).
// NEUTRAL framing (Reward-UX + Notification rules): "cook these next" / "from the Pantry" — NO
// loss-aversion ("don't let it rot"), NO "X days left" countdown (streak-psychology through the back
// door), NO push. `past_use_by` rows render as a distinct CALM state (a quiet "past date" tag), not an
// alarm. The whole card is hidden when there is nothing to surface. Reads /api/preservation/use-soon,
// whose server-side shelf-life window (L6) already decides membership — this component only presents.
import React from 'react'
import { useOverlayNavigate } from '../context/OverlayContext.jsx'
import { P } from '../lib/constants.js'
import { PUTUP_SOURCE_LABELS } from '../lib/dropdownRegistry.js'
import { useAmbientBandFetch } from '../lib/useAmbientBandFetch.js'
import AmbientBandNotice from './AmbientBandNotice.jsx'

// Module-level so the hook's load callback stays referentially stable across renders.
const normalize = (d) => (Array.isArray(d?.items) ? d.items : [])

const METHOD_LABELS = {
  roast_freeze: 'roasted & frozen', whole_freeze: 'frozen', blanch_freeze: 'blanched & frozen',
  dehydrate: 'dehydrated', powder: 'powder', passata: 'passata', can_water_bath: 'canned',
  can_pressure: 'pressure-canned', jam_preserve: 'jam', ferment: 'fermented',
  cure_store: 'cured', cold_store: 'cold-stored',
  purchased_preserved: 'bought preserved',   // D6 (V4-PUTUPPROV-001) — keep in step with PutUp.jsx
  // V4-PUTUPTAXONOMY-001 (BD-034). Lower-case past-participle phrasing here, because these read
  // INSIDE a sentence fragment ("6 quarts · pickled · in Chest Freezer 2"), not as picker labels.
  // Omitting any of them is silent: itemDetail() drops an unmapped method from the line entirely
  // rather than falling back to the slug, so the jar would read as though no method were recorded.
  quick_pickle: 'pickled', pesto: 'pesto', hot_sauce: 'hot sauce',
  ferment_mash: 'fermenting mash',
  // V5-PUTUPCANDY-001. Same reason and same phrasing rule as the four above. NOTE for whoever
  // revisits this band: candy's use-by is the one HOUSE-SOURCED figure in the vocabulary
  // (FOODSAFETY-RULING-V101 §8.2), and this card shows no date and no warn-coloured chip — only the
  // calm "past date" tag — so the provenance line lives where the DATE is, on PutUp's RecordRow and
  // in its log form. If this card ever starts rendering a use-by date, it needs that line too.
  candy: 'candied',
  other: 'put up',
}

// Label first: a ferment jar can carry a name and no crop (projectRow returns `label`; null on every row today).
function itemTitle(it) {
  return it.label || it.crop_display_name || it.crop_type_slug || 'From the Pantry'
}
function itemDetail(it) {
  const parts = []
  if (it.quantity_value != null && it.quantity_unit) parts.push(`${it.quantity_value} ${it.quantity_unit}`)
  const m = METHOD_LABELS[it.method]
  if (m) parts.push(m)
  if (it.storage_label) parts.push(`in ${it.storage_label}`)
  // V4-PUTUPPROV-001. Provenance where the Pantry is actually browsed, not only on the form.
  // own_garden and NULL append nothing, so every existing row's detail line is byte-identical.
  if (it.source_kind && it.source_kind !== 'own_garden') {
    parts.push(`from ${it.source_label || PUTUP_SOURCE_LABELS[it.source_kind] || it.source_kind}`)
  }
  return parts.join(' · ')
}

// V5-TODAYREDESIGN-001 S6 — THE DATA HOOK, split out of the band: the redesigned Today fetches at the PAGE (its
// Put-Up section's presence and header summary are read while the section's body — this band — is unmounted)
// and hands the result in as `data`. Without `data` the band calls it itself.
export function usePutUpUseSoonFeed() {
  return useAmbientBandFetch('/api/preservation/use-soon', normalize)
}

// The band's own slice — the jars it lists and how many it leaves to "+N more" — exported so a header summary
// names exactly those jars, in that order (plan-v2 §8 S6), and the words each row leads with.
export function putUpSoonSlice(items) {
  const list = Array.isArray(items) ? items : []
  const shown = list.slice(0, 5)
  return { shown, more: list.length - shown.length }
}
export const putUpSoonTitle = (it) => itemTitle(it)

// `data` = usePutUpUseSoonFeed()'s result, fetched by the caller; `bare` = no card, no eyebrow / title, no
// landmark name — the section holding it is the heading (Today V2's Put-Up). With neither, as it always was.
export default function PutUpUseSoonBand({ data, bare = false }) {
  return data ? <UseSoonBand feed={data} bare={bare} /> : <OwnUseSoonBand bare={bare} />
}

function OwnUseSoonBand({ bare }) {
  return <UseSoonBand feed={usePutUpUseSoonFeed()} bare={bare} />
}

function UseSoonBand({ feed, bare }) {
  const overlayNavigate = useOverlayNavigate()
  const { data: items, failed, reload } = feed

  // BUG-READYBANDFETCH-001 — "could not ask" is not "nothing to use soon". See useAmbientBandFetch.
  if (failed && !items) return <AmbientBandNotice eyebrow="Put up" onRetry={reload} bare={bare} />

  // Hidden entirely when empty (or before the first load resolves).
  if (!items || items.length === 0) return null

  const { shown, more } = putUpSoonSlice(items)

  // data-testid: a region anchor for the Today layout gate (scripts/layout-gate/today-shape.mjs). It
  // adds no node, no style and no behaviour.
  return (
    <section
      data-testid="putup-use-soon"
      aria-label={bare ? undefined : 'From the Pantry — cook these next'}
      style={bare ? undefined : {
        backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 12,
        padding: '14px 16px', marginTop: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: bare ? 'flex-end' : 'space-between', gap: 10, marginBottom: 10 }}>
        {!bare && (
        <div>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: P.light }}>
            From the Pantry
          </div>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: P.dark }}>Cook these next</div>
        </div>
        )}
        <button
          type="button"
          onClick={() => overlayNavigate('/put-up?view=pantry&filter=use-soon')}
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
          +{more} more in the Pantry
        </div>
      )}
    </section>
  )
}
