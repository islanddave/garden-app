// V5-SOURCEPICKER-001 — the source picker at Dave's geometry.
//
// WHY. jsdom returns zero from every getBoundingClientRect and rasterises nothing, so the 19 unit
// tests behind this component prove its BEHAVIOUR and can say nothing at all about whether it fits
// on the phone Dave actually uses. This component is the one that most needs the distinction: it
// opens a panel over a form, and inside that panel it can open a SECOND surface (the mint form) that
// itself contains a Select plus its own inline "＋ New kind" expansion. Three levels of disclosure
// inside a 390-wide field is exactly the arrangement that measures fine and is unusable.
//
// The questions this answers, none of which a vitest run can:
//   1. At 390x844, does the open panel fit, and does the list flip UP when the field sits low?
//   2. At 390x500 (the keyboard-open layout — `interactive-widget=resizes-content` SHRINKS the
//      layout viewport rather than covering it, so this is exact, not approximate), is the create
//      footer still reachable, or does it fall under the fold at the moment you need it?
//   3. Does the mint form — name + kind Select + the "＋ New kind" expansion — fit at 390x500?
//   4. Do the widest REAL catalogue names overflow the row, and does the panel scroll its own
//      content rather than the document?
//   5. Is every control at or above the 44px tap floor?
//
// FIXTURES ARE REAL PROD ROWS, longest-first. This matters and is not decoration: the /seeds/saved
// entry exists in this harness because a 44-character real name was the widest in its set and no
// invented "Vendor 1" would have found it. Every name below is a live row from public.source as
// backfilled on 2026-09-04 — 54 rows, of which these are the wide cases.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import SourcePicker from '../../src/components/forms/SourcePicker.jsx'

// The widest live names in the catalogue, measured by character count against prod on 2026-09-04.
const SOURCES = [
  { id: 's1',  name: 'Home-saved (source not recorded)',  kind: 'own_garden',    locality: null },
  { id: 's2',  name: 'Four Phantoms Brewing Company',     kind: 'organization',  locality: 'Greenfield, MA' },
  { id: 's3',  name: "Gardener's Supply Company",         kind: 'garden_center', locality: 'Hadley, MA' },
  { id: 's4',  name: 'Greenfield Farmers Co-op',          kind: 'retail',        locality: 'Greenfield, MA' },
  { id: 's5',  name: 'High Mowing Organic Seeds',         kind: 'seed_company',  locality: null },
  { id: 's6',  name: 'Long River Produce Market',         kind: 'market',        locality: 'Deerfield, MA' },
  { id: 's7',  name: 'Belchertown Plant Swap',            kind: 'plant_swap',    locality: 'Belchertown, MA' },
  { id: 's8',  name: 'Class Grass Garden Center',         kind: 'nursery',       locality: 'Granby, MA' },
  { id: 's9',  name: 'Botanical Interests',               kind: 'seed_company',  locality: null },
  { id: 's10', name: 'Whately Plant Swap',                kind: 'plant_swap',    locality: 'Whately, MA' },
  { id: 's11', name: 'Skawski Farms',                     kind: 'nursery',       locality: null },
  { id: 's12', name: 'Johnny’s Selected Seeds',      kind: 'seed_company',  locality: null },
  { id: 's13', name: 'Amazon',                            kind: 'retail',        locality: null },
  { id: 's14', name: 'Home Depot',                        kind: 'retail',        locality: null },
  { id: 's15', name: 'Unknown',                           kind: null,            locality: null },
]

// The twelve seeded kinds, in their real sort_order. 'Garden center' is the widest label and is what
// sets the Select's intrinsic width in the mint form.
const KINDS = [
  { slug: 'seed_company',  display_name: 'Seed company',  sort_order: 10 },
  { slug: 'nursery',       display_name: 'Nursery',       sort_order: 20 },
  { slug: 'garden_center', display_name: 'Garden center', sort_order: 30 },
  { slug: 'farm_stand',    display_name: 'Farm stand',    sort_order: 40 },
  { slug: 'market',        display_name: 'Market',        sort_order: 50 },
  { slug: 'retail',        display_name: 'Retail',        sort_order: 60 },
  { slug: 'plant_swap',    display_name: 'Plant swap',    sort_order: 70 },
  { slug: 'person',        display_name: 'Person',        sort_order: 80 },
  { slug: 'organization',  display_name: 'Organization',  sort_order: 90 },
  { slug: 'brand',         display_name: 'Brand',         sort_order: 100 },
  { slug: 'own_garden',    display_name: 'Own garden',    sort_order: 110 },
  { slug: 'other',         display_name: 'Other',         sort_order: 120 },
]

const params = new URLSearchParams(location.search)
// `low` pushes the field down the page so the panel has no room below it — the only way to exercise
// the measured flip-UP path, which is the half a top-of-page mount never reaches.
const CASE = params.get('case') || 'closed'
const SHOW_VERDICT = params.get('verdict') !== '0'

// The real useApiFetch seam runs; only the network under it is replaced.
window.fetch = async (url) => {
  const u = String(url)
  const body = u.includes('/source-kinds') ? KINDS
    : u.includes('/sources') ? SOURCES
    : []
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}

function Host() {
  const [value, setValue] = useState('')
  const [acq, setAcq] = useState('')
  return (
    <div>
      {CASE === 'low' && <div style={{ height: '60vh' }} aria-hidden="true" />}
      <div className="case-label">source — who it came from</div>
      <SourcePicker
        id="h-src"
        value={value}
        onChange={(id) => setValue(id)}
        label="Source"
        placeholder="Where did this come from?"
      />
      {/* The second axis renders only once the first is set — the contract's conditionality rule.
          Mounted here so the harness can measure BOTH pickers stacked, which is the real plant-form
          arrangement and the case where vertical room runs out. */}
      {value && (
        <>
          <div className="case-label">acquired from — the shop, when it differs</div>
          <SourcePicker
            id="h-acq"
            value={acq}
            onChange={(id) => setAcq(id)}
            label="Acquired from"
            placeholder="Where did you buy it?"
          />
        </>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')).render(<Host />)

// ── Measurement surface ──────────────────────────────────────────────────────────────────────────
// Reports only what it can actually see. Every number is layout, not usability — reachability by
// thumb and hit-target comfort are outside a geometric predicate, and env(safe-area-inset-bottom) is
// 0 in the emulator, so any slack figure here is an UPPER bound on a device with a gesture bar.
const vis = (el) => el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true

window.__h = {
  // Document-level horizontal overflow. Separate from panel(), deliberately: a panel scrolls its own
  // content, so a row wider than the panel does NOT show up as document hscroll.
  hscroll: () => ({
    docScrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    overflows: document.documentElement.scrollWidth > window.innerWidth,
  }),
  panel: () => {
    const p = document.querySelector('[role="listbox"]')?.closest('div')
    if (!p) return { open: false }
    const r = p.getBoundingClientRect()
    return {
      open: true,
      top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height),
      width: Math.round(r.width),
      // The two that matter: does it fit, and did it flip up rather than run off the bottom?
      fitsVertically: r.top >= 0 && r.bottom <= window.innerHeight,
      flippedUp: r.bottom <= (document.getElementById('h-src')?.getBoundingClientRect().top ?? 0) + 2,
      scrollsOwnContent: p.scrollHeight > p.clientHeight,
      overflowsHorizontally: p.scrollWidth > p.clientWidth,
    }
  },
  // Every option row, with the widest name, so a clipped label is attributable to a ROW rather than
  // reported as an anonymous overflow.
  rows: () => [...document.querySelectorAll('[role="option"]')].map(o => ({
    text: (o.textContent || '').trim().slice(0, 60),
    w: Math.round(o.getBoundingClientRect().width),
    h: Math.round(o.getBoundingClientRect().height),
    clipped: o.scrollWidth > o.clientWidth + 1,
    visible: vis(o),
  })),
  // 44px is the floor this repo's other layout gates use. offsetParent lies about visibility inside
  // a collapsed <details>; checkVisibility does not.
  tapTargets: () => [...document.querySelectorAll('button, [role="option"], input, select')]
    .filter(vis)
    .map(el => {
      const r = el.getBoundingClientRect()
      return { tag: el.tagName.toLowerCase(), label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 32), w: Math.round(r.width), h: Math.round(r.height) }
    })
    .filter(t => t.h > 0 && t.h < 44),
  all: () => ({
    innerW: window.innerWidth, innerH: window.innerHeight,
    hscroll: window.__h.hscroll(),
    panel: window.__h.panel(),
    rowCount: window.__h.rows().length,
    clippedRows: window.__h.rows().filter(r => r.clipped),
    smallTargets: window.__h.tapTargets(),
  }),
}

if (SHOW_VERDICT) {
  const paint = () => {
    const a = window.__h.all()
    const bad = a.hscroll.overflows || a.clippedRows.length > 0 || a.smallTargets.length > 0
      || (a.panel.open && !a.panel.fitsVertically)
    const v = document.getElementById('verdict')
    v.style.background = bad ? '#8a1c1c' : '#1c5c2e'
    v.textContent =
      `${a.innerW}x${a.innerH}  hscroll=${a.hscroll.overflows}  rows=${a.rowCount}` +
      `  clipped=${a.clippedRows.length}  <44px=${a.smallTargets.length}` +
      (a.panel.open ? `  panel ${a.panel.height}px fits=${a.panel.fitsVertically} up=${a.panel.flippedUp}` : '  panel closed')
    requestAnimationFrame(paint)
  }
  requestAnimationFrame(paint)
} else {
  document.getElementById('verdict').remove()
}
