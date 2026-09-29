// Put-Up 1a item 8 — scrollClearOfFooter, the arithmetic behind "the focused field under neither
// sticky band" (V4 §6.6–§6.7) on the two new sheets.
//
// jsdom lays nothing out (every rect is 0), so the GEOMETRY is proven in real Chrome by gate:putup at
// 426×492 — where the focused note sat at y425-489 under the pinned Save (top y411) before this, and at
// y339-403 after. This file pins the arithmetic with stubbed rects so a change to it reds here first:
// how far it scrolls, that it never scrolls a field already clear, and that it touches only the
// sheet panel. CI LANE: `npm test` plus the blocking TZ re-run.
import { describe, it, expect } from 'vitest'
import { scrollClearOfFooter, FOOTER_GAP_PX } from '../components/kitchen/sheetScroll.js'

function rig({ fieldTop, fieldBottom, footerTop, panelScroll = 0, maxScroll = 1000 }) {
  const panel = {
    _t: panelScroll,
    get scrollTop() { return this._t },
    set scrollTop(v) { this._t = Math.max(0, Math.min(maxScroll, v)) },
  }
  // The field's rect moves up by however far the panel has scrolled since the rig was built.
  const field = {
    closest: (sel) => (sel === '[role=dialog]' ? panel : null),
    getBoundingClientRect: () => ({ top: fieldTop - (panel._t - panelScroll), bottom: fieldBottom - (panel._t - panelScroll) }),
  }
  const footer = { getBoundingClientRect: () => ({ top: footerTop }) }
  return { panel, field, footer }
}

describe('scrollClearOfFooter', () => {
  // The measured case: note y425-489, footer top y411 → 489 + 8 − 411 = 86px.
  // MUTATION: drop the gap, or scroll by (bottom − top) of the field -> the literal reds.
  it('scrolls the panel exactly far enough to put the field one gap above the footer', () => {
    const { panel, field, footer } = rig({ fieldTop: 425, fieldBottom: 489, footerTop: 411 })
    expect(FOOTER_GAP_PX).toBe(8)
    expect(scrollClearOfFooter(field, footer)).toBe(86)
    expect(panel.scrollTop).toBe(86)
    expect(field.getBoundingClientRect().bottom + FOOTER_GAP_PX).toBe(411)
  })

  it('never scrolls a field that is already clear', () => {
    const { panel, field, footer } = rig({ fieldTop: 339, fieldBottom: 403, footerTop: 411, panelScroll: 40 })
    expect(scrollClearOfFooter(field, footer)).toBe(0)
    expect(panel.scrollTop).toBe(40)
  })

  it('reports what the panel actually moved when it runs out of scroll', () => {
    const { panel, field, footer } = rig({ fieldTop: 425, fieldBottom: 489, footerTop: 411, maxScroll: 50 })
    expect(scrollClearOfFooter(field, footer)).toBe(50)
    expect(panel.scrollTop).toBe(50)
  })

  it('does nothing outside a sheet, without a footer, or without a field', () => {
    const { field, footer } = rig({ fieldTop: 425, fieldBottom: 489, footerTop: 411 })
    const loose = { ...field, closest: () => null }
    expect(scrollClearOfFooter(loose, footer)).toBe(0)
    expect(scrollClearOfFooter(field, null)).toBe(0)
    expect(scrollClearOfFooter(null, footer)).toBe(0)
  })
})
