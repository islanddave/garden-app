// V4-BEANHABITCHIP-001 (lane B, mainsync11-20260925) — what a planting's CropCard chip rows show
// TODAY, in real Chrome at Dave's 426x836. Built as evidence for a brief that asked for a new
// "Bush"/"Pole"/"Half-runner" chip on the bean CropCard: the card already renders one. The
// V4-BEANFACET-001 derived bean_habit tag reaches it through GET /api/entity-tags (the tags Lambda
// projects EVERY derived tag on the planting's cultivar, no facet filter) and CropCard maps
// `projected` straight into TagChips.
//
// ?case=bean    Contender Bush Bean — prod rows as of 2026-09-25 (read-only). Also shows the defect
//               this capture surfaced: determinacyLabel is not gated to tomatoes, and its last branch
//               returns the whole growth_habit sentence, so the green "determinacy" pill carries a
//               150-character bean description (146 non-tomato live plantings on prod, 2026-09-25).
// ?case=tomato  1884 — one of the 41/46 live tomato cards that show determinacy TWICE: the green
//               V4-VARSLUG-001 spec chip (determinacyLabel over growth_habit prose) AND the
//               V4-CLASSIFY-001 derived determinacy facet chip. That is the "parity" the brief named.
//
// Fixtures: variety_ref in the plants Lambda's single-planting shape, projected in the tags Lambda's
// exact projection SQL, both read from prod. Only the far side of /api/entity-tags is stubbed; the
// card, useEntityTags, api.js routing and TagChip are the real modules.
//
// tagsEnabled() reads VITE_API_TAGS, which prod's build sets and this harness config does not, so:
//   VITE_API_TAGS=https://tags.harness.invalid npx vite --config tests/harness/vite.harness.config.mjs
// Without it the facet row never renders and the page would under-report what prod shows; the
// verdict bar says so in red rather than letting that pass as a clean capture.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import CropCard from '../../src/components/planting/CropCard.jsx'
import { AuthProvider } from '../../src/context/AuthContext.jsx'

const CASES = {
  bean: {
    planting: {
      id: 'pl-contender', name: 'Contender Bush Bean', status: 'harvested',
      sown_at: '2026-07-21', sown_at_approx: false, germinated_at: '2026-07-31',
      transplanted_at: null, planted_out_at: null, acquired_mature: null,
      created_at: '2026-07-21T20:33:42.114313+00:00',
      variety_ref: {
        name: 'Contender', genus: 'Phaseolus', species: 'Phaseolus vulgaris', crop_type_slug: 'bean',
        lifecycle: 'annual', dtm_basis: 'from-sow', default_unit: 'count', harvest_habit: 'repeat',
        growth_habit: 'Compact bush plant ~18-24 in tall, self-supporting; heavy sets of round, meaty, medium-green stringless snap pods ~6 in long. Early and heat-tolerant.',
        scoville_min: null, scoville_max: null, scoville_source: null, breeding_system: null,
        sun_requirements: 'full_sun', days_to_maturity_min: 50, days_to_maturity_max: 50,
        expected_yield_notes: 'Reliable, concentrated early set; ~225-340 g per plant. Good fresh, canning, freezing.',
      },
    },
    projected: [
      { facet: 'type', slug: 'bean', label: 'Bean' },
      { facet: 'bean_type', slug: 'common', label: 'Common bean' },
      { facet: 'bean_habit', slug: 'bush', label: 'Bush' },
      { facet: 'bean_use', slug: 'snap', label: 'Snap / green' },
      { facet: 'lifecycle', slug: 'annual', label: 'Annual' },
    ],
  },
  tomato: {
    planting: {
      id: 'pl-1884', name: '1884', status: 'harvested',
      sown_at: null, sown_at_approx: null, germinated_at: null,
      transplanted_at: '2026-06-07', planted_out_at: null, acquired_mature: null,
      created_at: '2026-06-07T05:22:01.245082+00:00',
      variety_ref: {
        name: '1884', genus: 'Solanum', species: 'lycopersicum', crop_type_slug: 'tomato',
        lifecycle: 'tender_perennial', dtm_basis: 'from-transplant', default_unit: 'count', harvest_habit: 'repeat',
        growth_habit: 'indeterminate vine; 5-7 ft; stake or cage required',
        scoville_min: null, scoville_max: null, scoville_source: null, breeding_system: 'open_pollinated',
        sun_requirements: 'full_sun', days_to_maturity_min: 78, days_to_maturity_max: 85,
        expected_yield_notes: 'Heavy yields of 450-900 g pink beefsteak fruits; somewhat ribbed; exceptional flavor; consistent performer in tastings',
      },
    },
    projected: [
      { facet: 'determinacy', slug: 'indeterminate', label: 'Indeterminate' },
      { facet: 'type', slug: 'tomato', label: 'Tomato' },
      { facet: 'lifecycle', slug: 'tender_perennial', label: 'Tender Perennial' },
    ],
  },
}

const qs = new URLSearchParams(location.search)
const CASE = CASES[qs.get('case')] ? qs.get('case') : 'bean'
const C = CASES[CASE]
const derived = t => ({ ...t, id: `${t.facet}:${t.slug}`, source: 'derived', owner_id: 'system', visibility: 'shared' })

let tagCalls = 0
const realFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url
  const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url
  if (!path.startsWith('/api/')) return realFetch(input, init)
  let body = {}
  if (path.startsWith('/api/entity-tags?')) {
    tagCalls++
    body = { direct: [], projected: C.projected.map(derived) }
  }
  await new Promise(r => setTimeout(r, 30))
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

let firstError = null
window.addEventListener('error', e => { firstError ??= e.message }, true)
window.addEventListener('unhandledrejection', e => { firstError ??= String(e.reason?.message ?? e.reason) })

createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <MemoryRouter initialEntries={['/plantings/' + C.planting.id]}>
      <div id="verdict" style={{ color: '#fff', font: '600 12px/1.4 system-ui', padding: '6px 10px' }}>…</div>
      <div style={{ padding: 16 }}>
        <h1 style={{ fontSize: '1.3rem', margin: '0 0 12px', color: '#2d3a2e' }}>{C.planting.name}</h1>
        <CropCard planting={C.planting} />
      </div>
    </MemoryRouter>
  </AuthProvider>
)

const seen = el => el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })
window.__h = {
  case: CASE,
  error: () => firstError,
  tagCalls: () => tagCalls,
  // Facet chips carry TagChip's data-testid; spec chips are CropCard's own 999px pills. Visible only.
  census() {
    const facet = [...document.querySelectorAll('#root [data-testid="tag-chip"]')].filter(seen).map(e => e.textContent.trim())
    const spec = [...document.querySelectorAll('#root span')]
      .filter(e => e.style.borderRadius === '999px' && !e.closest('[data-testid="tag-chip"]') && seen(e))
      .map(e => e.textContent.trim())
    return { innerWidth, innerHeight, dpr: devicePixelRatio, tagsEnabled: Boolean(import.meta.env.VITE_API_TAGS), facet, spec }
  },
  ready() { return window.__h.census().facet.length > 0 || firstError != null },
}

const paint = (ticks = 0) => {
  const el = document.getElementById('verdict')
  const c = window.__h.census()
  const bad = firstError || !c.tagsEnabled
  el.style.background = bad ? '#a4161a' : '#2d6a4f'
  el.textContent = firstError ? 'ERROR: ' + firstError
    : !c.tagsEnabled ? 'VITE_API_TAGS unset: facet row cannot render, capture is NOT prod-shaped'
    : `${CASE} · innerWidth ${c.innerWidth} x ${c.innerHeight} @${c.dpr} · spec chips [${c.spec.join(', ')}] · facet chips [${c.facet.join(', ')}]`
  if (ticks < 20) setTimeout(() => paint(ticks + 1), 250)
}
setTimeout(paint, 250)
