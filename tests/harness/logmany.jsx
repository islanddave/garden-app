// V4-LOGMANYUXREFRESH-001 S0+S1 — real-browser look at the Log Many review list at Dave's geometry.
//
// WHY THIS ENTRY EXISTS. There was none: main.jsx mounts EventNew only, so before this file nothing
// in the repo could render Log Many's selector at 390px, and the design recon that scoped this work
// said so explicitly — every geometry claim it made about this surface was arithmetic from source
// constants, not a measurement. jsdom returns zero for every getBoundingClientRect(), so the vitest
// suites next door prove the search field FILTERS and cannot prove it is reachable, tappable, or
// above the fold.
//
// Fixture is 239 plantings with the measured prod crop distribution (tomato 46, pepper 38, and a
// long tail of 1-3), because the whole complaint is about scale: a 12-row fixture makes any list
// look fine. runDryRun is a local promise — no network, no Lambda — since the wire shape is pinned
// by lambda/events/logmany-cropslug.test.js and what is under measurement here is layout.
//
// __h.measure() reports the numbers a screenshot cannot: tap-target heights against the app's own
// 44px floor (T.tapMinHeight) and whether the three named plantings are reachable without scrolling.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import ScopeChecklist from '../../src/components/forms/ScopeChecklist.jsx'

// Measured prod distribution, 2026-08-31 (design-logmany-selector.md §3.1): tomato 46, pepper 38,
// basil 7, geranium 6, lettuce 5, broccoli 4, melon 4, none 3, onion 3, tomatillo 3, kale 3, then a
// tail of 1-3 across 88 distinct crop types. Padded to 239 with a synthetic tail of the same shape.
const HEAD = [
  ['tomato', 46], ['pepper', 38], ['basil', 7], ['geranium', 6], ['lettuce', 5],
  ['broccoli', 4], ['melon', 4], [null, 3], ['onion', 3], ['tomatillo', 3], ['kale', 3],
]
const CULTIVARS = {
  tomato: ['Sun Gold', 'San Marzano', 'Black Krim', 'Brandywine', 'Sunray', 'Cherokee Purple'],
  pepper: ['Aji Dulce', 'Jalapeno', 'Shishito', 'Chili Red', 'Padron', 'Habanero'],
  basil: ['Genovese', 'Thai Basil', 'Lemon Basil'],
  melon: ['Charentais', 'Hales Best'],
}
const PLANTINGS = []
let n = 0
for (const [slug, count] of HEAD) {
  for (let i = 0; i < count; i++) {
    const names = CULTIVARS[slug]
    const name = names ? `${names[i % names.length]} ${Math.floor(i / names.length) + 1}` : null
    PLANTINGS.push({
      id: `pl-${++n}`,
      name: name ?? (slug ? `${slug[0].toUpperCase()}${slug.slice(1)} ${i + 1}` : `Kousa Dogwood ${i + 1}`),
      crop_type_slug: slug,
    })
  }
}
// The tail: 1-3 plantings each across enough crop types to reach the measured 239.
const TAIL = ['squash', 'cucumber', 'bean', 'pea', 'carrot', 'beet', 'chard', 'arugula', 'cilantro',
  'dill', 'mint', 'oregano', 'parsley', 'rosemary', 'sage', 'thyme', 'chive', 'leek', 'radish',
  'spinach', 'turnip', 'eggplant', 'okra', 'celery', 'fennel', 'garlic', 'shallot', 'strawberry',
  'raspberry', 'blueberry', 'zinnia', 'marigold', 'nasturtium', 'sunflower', 'cosmos', 'dahlia',
  'hydrangea', 'dogwood', 'hosta', 'fern', 'sedum', 'lavender', 'yarrow', 'echinacea', 'aster']
for (let t = 0; PLANTINGS.length < 239; t++) {
  const slug = TAIL[t % TAIL.length]
  PLANTINGS.push({
    id: `pl-${++n}`,
    name: `${slug[0].toUpperCase()}${slug.slice(1)} ${Math.floor(t / TAIL.length) + 1}`,
    crop_type_slug: slug,
  })
}

const runDryRun = () => Promise.resolve({ count: PLANTINGS.length, capped: false, plantings: PLANTINGS })

function Harness() {
  const [scope, setScope] = useState({ type: 'all' })
  const [sel, setSel] = useState(null)
  window.__sel = sel
  return (
    <ScopeChecklist
      scope={scope}
      onScopeChange={setScope}
      projects={[]}
      locations={[{ id: 'bag', name: 'Bag Area' }, { id: 'trough', name: 'Trough' }]}
      eventType="watering"
      eventDate=""
      verbLabel="watered"
      runDryRun={runDryRun}
      onSelectionChange={setSel}
    />
  )
}

createRoot(document.getElementById('root')).render(<Harness />)

const q = (s) => document.querySelector(s)
const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null)

// The 44px floor is the app's OWN named token (formStyles.js T.tapMinHeight), minted by
// BUG-DISCLOSURETAPSIZE-001 precisely because four controls on Log Event shipped under it.
window.__h = {
  open: () => {
    const link = [...document.querySelectorAll('button')].find(b => /^Review \d+ plantings/.test(b.textContent))
    if (link) link.click()
    return !!link
  },
  type: (v) => {
    const el = q('[data-testid="sc-search"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  },
  tapSelectNone: () => { q('[data-testid="sc-select-none"]')?.click(); return true },
  tapChip: (label) => {
    const b = [...document.querySelectorAll('[data-testid="sc-crop-chips"] button')].find(x => x.textContent === label)
    if (b) b.click()
    return !!b
  },
  rows: () => [...document.querySelectorAll('ul li button[aria-pressed]')].map(b => b.textContent.replace(/^[✓○]/, '')),
  measure: () => {
    const ul = q('ul')
    const rows = [...document.querySelectorAll('ul li button[aria-pressed]')]
    const chipRow = q('[data-testid="sc-crop-chips"]')
    const chips = chipRow ? [...chipRow.querySelectorAll('button')] : []
    const search = q('[data-testid="sc-search"]')
    const selNone = q('[data-testid="sc-select-none"]')
    const selShown = q('[data-testid="sc-select-shown"]')
    const kb = q('[data-testid="sc-kb"]')
    const listRect = ul ? ul.getBoundingClientRect() : null
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      docHeight: Math.round(document.documentElement.scrollHeight),
      shownNote: q('[data-testid="sc-shown-note"]')?.textContent ?? null,
      rowCount: rows.length,
      // Targets, against the 44px floor.
      searchH: h(search),
      kbH: h(kb),
      chipH: chips.length ? Math.min(...chips.map(h)) : null,
      selectNoneH: h(selNone),
      selectShownH: h(selShown),
      rowH: rows.length ? Math.min(...rows.map(h)) : null,
      reviewLinkH: h([...document.querySelectorAll('button')].find(b => /plantings/.test(b.textContent))),
      prefCheckboxH: h(document.querySelector('input[type="checkbox"]')),
      // Does the list need scrolling to reach every row it is showing?
      listScrollTop: ul ? Math.round(ul.scrollTop) : null,
      listClientH: ul ? Math.round(ul.clientHeight) : null,
      listScrollH: ul ? Math.round(ul.scrollHeight) : null,
      listNeedsScroll: ul ? ul.scrollHeight > ul.clientHeight + 1 : null,
      // Is the whole list inside the viewport without page scrolling?
      listBottomInView: listRect ? Math.round(listRect.bottom) <= window.innerHeight : null,
      committedCount: window.__sel?.committedCount ?? null,
    }
  },
}

setTimeout(() => {
  const v = document.getElementById('verdict')
  v.textContent = `239 plantings · ${window.innerWidth}x${window.innerHeight} · __h.open() then __h.measure()`
}, 300)
