// V5-VARIETYHYBRIDFLAG-001 — real-browser look at the F1 warning in SaveSeedSheet.
//
// WHAT ONLY A BROWSER ANSWERS. The warning is two or three lines of prose sitting directly above the
// primary action at 390px. vitest can prove the right string renders for the right enum value; it
// cannot say whether the sentence pushes Save below the fold, whether the badge and the sentence
// collide on a narrow screen, or whether the four arms are visually distinguishable enough that the
// F1 one reads as a warning and the other three read as ordinary facts. jsdom returns 0 for every
// rect, so none of that is falsifiable in the suite.
//
// FIXTURES ARE REAL PROD ROWS, one per breeding_system, read from public.cultivar on 2026-09-03 and
// taken LONGEST-NAME-FIRST within each value so the worst case for layout is the one on screen.
// 'Megatron F1 (jumbo jalapeno)' is a real 28-character F1 in the garden; an invented name would
// repeat nothing.
//
// ?case=f1 (default) | open_pollinated | landrace | unknown | none
// The default is f1 because that is the only arm that fires; `none` is the 404-of-483 empty case and
// is the one to check renders NOTHING rather than an empty gap above Save.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../src/context/ToastContext.jsx'
import SaveSeedSheet from '../../src/components/planting/SaveSeedSheet.jsx'

const q = new URLSearchParams(location.search)
const CASE = q.get('case') || 'f1'

// Real prod rows. breeding_system null for the `none` case is the DEFAULT state of the database,
// not an edge case: 404 of 483 live cultivars carry it.
const CULTIVARS = {
  f1:              { id: 'v-f1',   name: 'Megatron F1 (jumbo jalapeno)', crop_type_slug: 'pepper', breeding_system: 'f1' },
  open_pollinated: { id: 'v-op',   name: 'Bulgarian Carrot (Shipka)',    crop_type_slug: 'pepper', breeding_system: 'open_pollinated' },
  landrace:        { id: 'v-lr',   name: 'Kori Sitakame',                crop_type_slug: 'pepper', breeding_system: 'landrace' },
  unknown:         { id: 'v-unk',  name: 'Bell Pepper (Unknown)',        crop_type_slug: 'pepper', breeding_system: 'unknown' },
  none:            { id: 'v-null', name: 'Money Plant (self-saved, variety unrecorded)', crop_type_slug: 'money_plant', breeding_system: null },
}
const VARIETY = CULTIVARS[CASE] ?? CULTIVARS.f1

const PLANTING = {
  id: 'p-1',
  name: VARIETY.name,
  variety_id: VARIETY.id,
  variety_ref: VARIETY,
  project_id: 'proj-1',
}

// Stub the wire, not the module: the sheet then runs its real fetch path, its real error handling and
// its real VarietyPicker, and only the far side is faked. Same approach as harvestlog.jsx.
window.fetch = async (url, opts = {}) => {
  const u = String(url)
  const ok = (json) => ({ ok: true, status: 200, json: async () => json })
  // The picker's hook fetches this on mount. Every row carries breeding_system because the live
  // /api/varieties projection now does — that is the third door this feature had to cover.
  if (u.includes('/api/varieties')) return ok(Object.values(CULTIVARS))
  if (u.includes('/api/projects')) return ok([{ id: 'proj-1', name: 'Peppers 2026', status: 'growing' }])
  if (u.includes('/api/locations')) return ok([])
  if (u.includes('/api/plants')) return ok([PLANTING])
  if (u.includes('/api/inventory-items') && opts.method === 'POST') return ok({ id: 'lot-1' })
  return ok({})
}

// Reports what a screenshot cannot: whether Save is reachable without scrolling, and whether the
// notice actually sits ABOVE it. A warning below the button it is about would be invisible at the
// moment it matters and would still look correct in a full-page capture.
window.__h = {
  measure () {
    const notice = document.querySelector('[data-testid="breeding-notice"]')
    const save = document.querySelector('[data-testid="save-seed-submit"]')
    const r = (el) => (el ? el.getBoundingClientRect() : null)
    const n = r(notice); const s = r(save)
    return {
      case: CASE,
      breeding_system: VARIETY.breeding_system,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      noticePresent: !!notice,
      // checkVisibility(), not offsetParent: a collapsed ancestor fakes the latter.
      noticeVisible: notice ? notice.checkVisibility?.() ?? true : false,
      noticeText: notice ? notice.innerText.trim().slice(0, 160) : null,
      noticeTop: n ? Math.round(n.top) : null,
      noticeBottom: n ? Math.round(n.bottom) : null,
      noticeRight: n ? Math.round(n.right) : null,
      noticeOverflows: n ? n.right > window.innerWidth : null,
      saveTop: s ? Math.round(s.top) : null,
      noticeIsAboveSave: (n && s) ? n.bottom <= s.top : null,
      saveWithinViewport: s ? s.bottom <= window.innerHeight : null,
    }
  },
}

function boot () {
  const m = window.__h.measure()
  const el = document.getElementById('verdict')
  el.textContent =
    `case=${m.case} breeding_system=${m.breeding_system ?? 'NULL'}  vw ${m.innerWidth} · scrollW ${m.scrollWidth} · hscroll ${m.scrollWidth > m.innerWidth ? 'YES' : 'no'}\n`
    + `notice ${m.noticePresent ? 'present' : 'ABSENT'} · aboveSave ${m.noticeIsAboveSave} · overflows ${m.noticeOverflows} · saveInView ${m.saveWithinViewport}`
}

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/plantings/p-1']}>
    <ToastProvider>
      <SaveSeedSheet planting={PLANTING} onClose={() => {}} />
    </ToastProvider>
  </MemoryRouter>,
)

// After paint, so the rects are real.
setTimeout(boot, 400)
