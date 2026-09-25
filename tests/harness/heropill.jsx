// Lane H (mainsync11-20260925) — the planting hero's gold key-fact pill, in real Chrome at Dave's
// 426x836. Mounts the REAL PlantingDetail (so the real HeroPhoto, PhotoHero and keyFact.js) under the
// real router; only the far side of /api/* is stubbed. The pill is white-space: nowrap, so a long value
// cannot wrap: the bar at the bottom measures whether it fits inside the hero box at this width.
//
// ?case=blush     Purple Blush Tomatillo — prod row, 2026-09-25 (read-only). Before the fix rung 2
//                 printed its whole 113-character growth_habit sentence here.
// ?case=pineapple Pineapple Tomatillo — the other sentence ("Low sprawling/bushy, 12-24 in; husked fruit").
// ?case=cherokee  Cherokee Green — a tomato named by cultivar; the name test missed it, so the pill was
//                 its days. With the crop-type rule it is Indeterminate.
// Lane P (same session) — peppers show their heat, and the white crop chip names the crop type:
// ?case=jalapeno  Jalapeno — 2,500–8,000 SHU; the pill was "70–80 days", the chip "Pepper" (by name).
// ?case=ghost     Ghost — 855,000–1,041,427 SHU, the longest live SHU label; no chip (name test misses).
// ?case=carmen    Carmen — a sweet pepper, 0–0: "Sweet · 0 SHU", as on the crop card.
// ?case=peppermint Peppermint — crop type mint; the chip said "Pepper" (\bpepper matched the name).
// (blush and pineapple also carry the chip: it said "Tomato" on both tomatillos.)
//
//   node node_modules/vite/bin/vite.js --config tests/harness/vite.harness.config.mjs --port <p> --strictPort
//   HARNESS_BASELINE_SHA=3aff926419a4bd59a7c77f9873a5af6d13e964ca … → src/** from before the fix
//   HARNESS_BASELINE_SHA=78ae1d5e91f36f176ec375c4fde0a50723805428 … → src/** from before lane P
// The bar names which rules the served keyFact.js carries (rungs 1 and 2, and the chip), read off the
// functions themselves, so a capture says what code it shows rather than trusting the command line.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import PlantingDetail from '../../src/pages/PlantingDetail.jsx'
import { DismissRegistryProvider } from '../../src/context/DismissRegistry.jsx'
// FavoriteToggle uses the strict useAuth, which throws without this provider (see editdeeplink.jsx).
import { AuthProvider } from '../../src/context/AuthContext.jsx'
import { selectKeyFact, selectCropType } from '../../src/lib/keyFact.js'
import { P } from '../../src/lib/constants.js'

// A stand-in photo (no real photo leaves the app): dark foliage tones so the overlay reads as on prod.
const PHOTO = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
  + '<stop offset="0" stop-color="#4f6b3a"/><stop offset=".55" stop-color="#2f4a2a"/><stop offset="1" stop-color="#4a2f52"/></linearGradient></defs>'
  + '<rect width="1200" height="900" fill="url(#g)"/><circle cx="820" cy="360" r="120" fill="#5a3a66"/><circle cx="640" cy="470" r="90" fill="#6b4a3a"/></svg>')

const base = { project_id: 'proj1', project_name: 'Drive', featured_photo_id: null, featured_photo_view_url: PHOTO,
  created_at: '2026-06-07T05:22:01.245082+00:00', transplanted_at: '2026-06-07', metadata: null }
const CASES = {
  blush: { ...base, id: 'pl-blush', name: 'Purple Blush Tomatillo', status: 'harvested', quantity: 2,
    variety_ref: { name: 'Purple blush', genus: 'Physalis', species: 'philadelphica', crop_type_slug: 'tomatillo',
      lifecycle: 'annual', dtm_basis: 'from-transplant', default_unit: 'count', harvest_habit: 'repeat',
      growth_habit: 'bushy upright; 3-5 in jalapeño-size fruit, compact productive plants; simultaneous green/purple/red fruit display',
      scoville_min: null, scoville_max: null, scoville_source: null, breeding_system: null,
      sun_requirements: 'full_sun', days_to_maturity_min: 70, days_to_maturity_max: 75,
      expected_yield_notes: 'Good; jalapeno-size purple-flushed pods' } },
  pineapple: { ...base, id: 'pl-pineapple', name: 'Pineapple Tomatillo', status: 'harvested', quantity: 2,
    variety_ref: { name: 'Pineapple Tomatillo', crop_type_slug: 'tomatillo', lifecycle: 'annual',
      dtm_basis: 'from-transplant', default_unit: 'count', harvest_habit: 'repeat',
      growth_habit: 'low sprawling/bushy, 12-24 in; husked fruit',
      sun_requirements: 'full_sun', days_to_maturity_min: 75, days_to_maturity_max: 90 } },
  cherokee: { ...base, id: 'pl-cherokee', name: 'Cherokee Green', status: 'harvested', quantity: 1,
    variety_ref: { name: 'Cherokee Green', genus: 'Solanum', species: 'lycopersicum', crop_type_slug: 'tomato',
      lifecycle: 'tender_perennial', dtm_basis: 'from-transplant', default_unit: 'count', harvest_habit: 'repeat',
      growth_habit: 'indeterminate vine; 6-8 ft; stake or cage required', breeding_system: 'open_pollinated',
      sun_requirements: 'full_sun', days_to_maturity_min: 75, days_to_maturity_max: 85,
      expected_yield_notes: '225-340 g fruits; green to yellow-green skin when ripe with amber blossom end; bold acidic complex flavor' } },
  // Prod rows, 2026-09-25 (read-only), in the plants Lambda's variety_ref shape.
  jalapeno: { ...base, id: 'pl-jalapeno', name: 'Jalapeno', status: 'fruiting', quantity: 1,
    variety_ref: { name: 'Jalapeno', genus: 'Capsicum', species: 'annuum', crop_type_slug: 'pepper', lifecycle: 'tender_perennial',
      dtm_basis: 'from-transplant', default_unit: 'count', harvest_habit: 'repeat', breeding_system: 'unknown',
      growth_habit: 'bushy upright, 24-35 in tall; produces 25-35 pods; 2-4 in fruit hanging downward',
      scoville_min: 2500, scoville_max: 8000, scoville_source: null,
      sun_requirements: 'full_sun', days_to_maturity_min: 70, days_to_maturity_max: 80 } },
  ghost: { ...base, id: 'pl-ghost', name: 'Ghost', status: 'harvested', quantity: 57,
    variety_ref: { name: 'Ghost', genus: 'Capsicum', species: 'chinense', crop_type_slug: 'pepper', lifecycle: 'tender_perennial',
      dtm_basis: 'from-transplant', default_unit: 'count', harvest_habit: 'repeat', breeding_system: 'open_pollinated',
      growth_habit: 'upright bushy 2-4 ft; wrinkled ~2.5 in ghost pods ripening green to red-orange; very long season',
      scoville_min: 855000, scoville_max: 1041427, scoville_source: 'reference_work',
      sun_requirements: 'full_sun', days_to_maturity_min: 100, days_to_maturity_max: 120 } },
  carmen: { ...base, id: 'pl-carmen', name: 'Carmen', status: 'ended', quantity: 1,
    variety_ref: { name: 'Carmen', genus: 'Capsicum', species: 'annuum', crop_type_slug: 'pepper', lifecycle: 'tender_perennial',
      dtm_basis: 'from-transplant', default_unit: 'count', harvest_habit: 'repeat', breeding_system: 'f1',
      growth_habit: "upright; sweet Italian bull's-horn type; large tapered fruit ripening red",
      scoville_min: 0, scoville_max: 0, scoville_source: null,
      sun_requirements: 'full_sun', days_to_maturity_min: 60, days_to_maturity_max: 80 } },
  peppermint: { ...base, id: 'pl-peppermint', name: 'Peppermint', status: 'vegetative', quantity: 3,
    variety_ref: { name: 'Peppermint', genus: 'Mentha', species: 'x piperita', crop_type_slug: 'mint', lifecycle: 'perennial',
      default_unit: 'cup', harvest_habit: 'cut_and_come_again',
      growth_habit: 'upright spreading perennial 12-36 in tall; reddish square stems; spreads aggressively by rhizomes; sterile hybrid',
      scoville_min: null, scoville_max: null, scoville_source: null,
      sun_requirements: 'part_sun', days_to_maturity_min: 70, days_to_maturity_max: 90 } },
}
const qs = new URLSearchParams(location.search)
const CASE = CASES[qs.get('case')] ? qs.get('case') : 'blush'
const PL = CASES[CASE]

const realFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url
  const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url
  if (!path.startsWith('/api/')) return realFetch(input, init)
  let body = []
  if (path === '/api/plants/' + PL.id) body = PL
  else if (path.startsWith('/api/plants/' + PL.id + '/seed-lots')) body = { plant_id: PL.id, seed_lots: [] }
  await new Promise(r => setTimeout(r, 30))
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

let firstError = null
window.addEventListener('error', e => { firstError ??= e.message }, true)
window.addEventListener('unhandledrejection', e => { firstError ??= String(e.reason?.message ?? e.reason) })

createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <DismissRegistryProvider>
      <MemoryRouter initialEntries={['/plantings/' + PL.id]}>
        <Routes>
          <Route path="/plantings/:plantingId" element={<PlantingDetail />} />
        </Routes>
      </MemoryRouter>
    </DismissRegistryProvider>
  </AuthProvider>
)

const RULE = (() => {
  const s = selectKeyFact.toString()   // as served: the transform may re-quote string literals
  const pepper = /crop_type_slug\s*===\s*["']pepper["']/.test(s) && s.includes('shuLabel') ? 'pepper: crop type + shuLabel' : 'pepper: names + shu keys'
  if (/crop_type_slug\s*===\s*["']tomato["']/.test(s)) return `keyFact: ${pepper}; tomato: crop type + determinacyLabel`
  if (s.includes('determinacyLabel')) return `keyFact: ${pepper}; tomato: names + determinacyLabel (commit A)`
  return `keyFact: ${pepper}; tomato: names + prose fallback (before the fix)`
})()
const CHIP_RULE = selectCropType.toString().includes('cropTypeLabel') ? 'chip: crop type words' : 'chip: name words'
const probe = document.createElement('span')
probe.style.backgroundColor = P.warn
document.body.appendChild(probe)
const GOLD = getComputedStyle(probe).backgroundColor
probe.style.backgroundColor = 'rgba(255,255,255,0.92)'   // the crop chip's paint (HeroPhoto.jsx); the ×N pill shares it
const CHIP_WHITE = getComputedStyle(probe).backgroundColor
probe.remove()
const seen = el => el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })

window.__h = {
  case: CASE,
  rule: RULE,
  error: () => firstError,
  census() {
    const h1 = document.querySelector('#root h1')
    const row = h1?.nextElementSibling
    const gold = row ? [...row.children].filter(el => getComputedStyle(el).backgroundColor === GOLD) : []
    const pill = gold[0] ?? null
    const chips = row ? [...row.children].filter(el => getComputedStyle(el).backgroundColor === CHIP_WHITE && !el.dataset.testid) : []
    const box = h1?.closest('[style*="aspect-ratio"]')
    const pr = pill?.getBoundingClientRect(), br = box?.getBoundingClientRect()
    return {
      innerWidth, innerHeight, dpr: devicePixelRatio, rule: RULE, chipRule: CHIP_RULE, h1: h1?.textContent ?? null,
      chip: chips.map(el => el.textContent).join(' + ') || null, chipVisible: chips[0] ? seen(chips[0]) : null,
      goldPills: gold.length, pill: pill?.textContent ?? null, pillChars: pill?.textContent.length ?? 0,
      pillVisible: pill ? seen(pill) : null, pillLeft: pr ? Math.round(pr.left) : null, pillRight: pr ? Math.round(pr.right) : null,
      pillWidth: pr ? Math.round(pr.width) : null, heroRight: br ? Math.round(br.right) : null,
      fitsHero: pr && br ? pr.right <= br.right + 0.5 : null,
      pageScrollWidth: document.documentElement.scrollWidth,
    }
  },
  ready() { const c = window.__h.census(); return (c.h1 === PL.name && c.goldPills > 0) || firstError != null || (c.h1 === PL.name && ticks > 8) },
}

let ticks = 0
const paint = () => {
  const el = document.getElementById('verdict')
  const c = window.__h.census()
  const bad = firstError || c.fitsHero === false
  el.style.background = bad ? '#a4161a' : '#2d6a4f'
  el.textContent = firstError ? 'ERROR: ' + firstError
    : `${CASE} · innerWidth ${c.innerWidth} x ${c.innerHeight} @${c.dpr} · ${c.rule} · ${c.chipRule}\n`
      + `gold pill ${c.pill == null ? 'none' : `"${c.pill}" (${c.pillChars} chars, ${c.pillWidth}px wide)`}`
      + ` · fits the hero: ${c.fitsHero == null ? 'n/a' : c.fitsHero ? 'yes' : `NO (right edge ${c.pillRight} > hero ${c.heroRight})`}`
      + ` · crop chip ${c.chip == null ? 'none' : `"${c.chip}"${c.chipVisible ? '' : ' (NOT visible)'}`}`
      + ` · page scrollWidth ${c.pageScrollWidth}`
  if (++ticks < 20) setTimeout(paint, 250)
}
setTimeout(paint, 250)
