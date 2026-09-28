// V5-TODAYREDESIGN-001 S2 — FacetGroupHeader's opt-in native mode (plan-v2 §4 section band, §5.2 disclosure).
// The contract is additive, FilterChipRow.leading's idiom: WITHOUT `headingLevel` every caller (Garden's
// faceted groups, My seeds' crop groups and "Sowed previously") must render exactly as before — pinned below as
// the HTML the component rendered at 34e473e5, captured by rendering that commit's file with these props.
// WITH it: a native <button> inside <hN>, the panel mounted only while open, ids from useId.
import React, { useState } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import FacetGroupHeader from '../components/forms/FacetGroupHeader.jsx'

afterEach(() => cleanup())
const noop = () => {}

// Captured at 34e473e518da521fc4ae1723e99f817dff2bb0c3 (the pre-S2 file), one per legacy caller shape.
const GOLDEN = [
  ['Garden type group, closed', { label: 'Peppers', count: 4, facet: 'type', value: 'pepper', collapsed: true, onToggle: noop },
    '<div data-testid="facet-group-header" role="button" tabindex="0" aria-expanded="false" style="display: flex; align-items: center; gap: 10px; padding: 5px 10px; background-color: rgb(230, 240, 232); color: rgb(31, 81, 56); border-left: 3px solid rgb(188, 215, 196); border-radius: 7px; font-weight: 700; font-size: 0.82rem; cursor: pointer;"><span aria-hidden="true" style="font-size: 0.72rem;">▸</span><span style="font-style: normal;">Peppers</span><span style="margin-left: auto; font-weight: 600;">4</span></div>'],
  ['Garden empty location, indented, no toggle', { label: 'Bag Area', count: 0, facet: 'location', value: 'bag', collapsed: true, style: { marginLeft: 16 } },
    '<div data-testid="facet-group-header" style="display: flex; align-items: center; gap: 10px; padding: 5px 10px; background-color: rgb(243, 236, 226); color: rgb(107, 79, 42); border-left: 3px solid rgb(221, 205, 182); border-radius: 7px; font-weight: 700; font-size: 0.82rem; cursor: default; margin-left: 16px;"><span style="font-style: normal;">Bag Area</span><span style="margin-left: auto; font-weight: 600;">0</span></div>'],
  ['Garden unsorted, open', { label: 'Unsorted', count: 3, facet: 'type', value: 'x', isUnsorted: true, collapsed: false, onToggle: noop },
    '<div data-testid="facet-group-header" role="button" tabindex="0" aria-expanded="true" style="display: flex; align-items: center; gap: 10px; padding: 5px 10px; background-color: rgb(240, 239, 237); color: rgb(74, 74, 74); border-left: 3px solid rgb(217, 212, 205); border-radius: 7px; font-weight: 700; font-size: 0.82rem; cursor: pointer;"><span aria-hidden="true" style="font-size: 0.72rem;">▾</span><span style="font-style: italic;">Unsorted</span><span style="margin-left: auto; font-weight: 600;">3</span></div>'],
  ['My seeds crop group, open, styled', { label: 'Tomato · hottest first', count: 12, facet: 'type', value: 'tomato', collapsed: false, onToggle: noop, style: { borderRadius: 6 } },
    '<div data-testid="facet-group-header" role="button" tabindex="0" aria-expanded="true" style="display: flex; align-items: center; gap: 10px; padding: 5px 10px; background-color: rgb(230, 240, 232); color: rgb(31, 81, 56); border-left: 3px solid rgb(188, 215, 196); border-radius: 6px; font-weight: 700; font-size: 0.82rem; cursor: pointer;"><span aria-hidden="true" style="font-size: 0.72rem;">▾</span><span style="font-style: normal;">Tomato · hottest first</span><span style="margin-left: auto; font-weight: 600;">12</span></div>'],
  ['My seeds "Sowed previously"', { label: 'Sowed previously', count: 7, isUnsorted: true, collapsed: true, onToggle: noop, style: { padding: 4 } },
    '<div data-testid="facet-group-header" role="button" tabindex="0" aria-expanded="false" style="display: flex; align-items: center; gap: 10px; padding: 4px; background-color: rgb(240, 239, 237); color: rgb(74, 74, 74); border-left: 3px solid rgb(217, 212, 205); border-radius: 7px; font-weight: 700; font-size: 0.82rem; cursor: pointer;"><span aria-hidden="true" style="font-size: 0.72rem;">▸</span><span style="font-style: italic;">Sowed previously</span><span style="margin-left: auto; font-weight: 600;">7</span></div>'],
  ['static, no count', { label: 'Herbs', facet: 'group', value: 'herbs' },
    '<div data-testid="facet-group-header" style="display: flex; align-items: center; gap: 10px; padding: 5px 10px; background-color: rgb(238, 240, 250); color: rgb(58, 63, 107); border-left: 3px solid rgb(201, 205, 236); border-radius: 7px; font-weight: 700; font-size: 0.82rem; cursor: default;"><span style="font-style: normal;">Herbs</span></div>'],
  ['lifecycle value colour', { label: 'Perennial', count: 2, facet: 'lifecycle', value: 'perennial', onToggle: noop },
    '<div data-testid="facet-group-header" role="button" tabindex="0" aria-expanded="true" style="display: flex; align-items: center; gap: 10px; padding: 5px 10px; background-color: rgb(222, 240, 234); color: rgb(20, 86, 74); border-left: 3px solid rgb(180, 221, 208); border-radius: 7px; font-weight: 700; font-size: 0.82rem; cursor: pointer;"><span aria-hidden="true" style="font-size: 0.72rem;">▾</span><span style="font-style: normal;">Perennial</span><span style="margin-left: auto; font-weight: 600;">2</span></div>'],
]

describe('FacetGroupHeader — without headingLevel, byte-identical to 34e473e5', () => {
  for (const [name, props, html] of GOLDEN) {
    it(name, () => {
      const { container } = render(<FacetGroupHeader {...props} />)
      expect(container.innerHTML).toBe(html)
    })
  }
  it('native-only props are ignored without headingLevel (no heading, no panel, no summary)', () => {
    const { container } = render(
      <FacetGroupHeader label="Peppers" count={4} facet="type" value="pepper" collapsed onToggle={noop} summary="S" trailing={<i>T</i>} size="row">
        <p>panel</p>
      </FacetGroupHeader>,
    )
    expect(container.innerHTML).toBe(GOLDEN[0][2])
  })
})

function Controlled({ initial = false, children = <p data-testid="panel-body">rows</p>, ...rest }) {
  const [open, setOpen] = useState(initial)
  return (
    <FacetGroupHeader headingLevel={2} label="Needs care" count={233} facet="type" collapsed={!open} onToggle={() => setOpen((o) => !o)} {...rest}>
      {children}
    </FacetGroupHeader>
  )
}

describe('FacetGroupHeader — native mode (headingLevel)', () => {
  it('the heading wraps a native button; the band keeps the facet fill and left rule', () => {
    render(<Controlled />)
    const btn = screen.getByRole('button', { name: /Needs care/ })
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('type')).toBe('button')
    expect(btn.parentElement.tagName).toBe('H2')
    const band = screen.getByTestId('facet-group-header')
    expect(band.contains(btn)).toBe(true)
    expect(band.style.borderLeft).toBe('3px solid rgb(188, 215, 196)')
    expect(band.style.backgroundColor).toBe('rgb(230, 240, 232)')
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('233')
  })

  it('aria-controls only while the panel is mounted, and it names the mounted panel', () => {
    render(<Controlled />)
    const btn = screen.getByRole('button', { name: /Needs care/ })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(btn.hasAttribute('aria-controls')).toBe(false)
    expect(screen.queryByTestId('panel-body')).toBeNull()
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    const id = btn.getAttribute('aria-controls')
    expect(id).toBeTruthy()
    expect(document.getElementById(id).contains(screen.getByTestId('panel-body'))).toBe(true)
    fireEvent.click(btn)
    expect(btn.hasAttribute('aria-controls')).toBe(false)
    expect(screen.queryByTestId('panel-body')).toBeNull()
  })

  it('an open header with nothing to show controls nothing', () => {
    render(<Controlled initial children={null} />)
    const btn = screen.getByRole('button', { name: /Needs care/ })
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(btn.hasAttribute('aria-controls')).toBe(false)
  })

  it('two instances never share a panel id', () => {
    render(<><Controlled initial label="A" /><Controlled initial label="B" /></>)
    const ids = screen.getAllByRole('button').map((b) => b.getAttribute('aria-controls'))
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    for (const id of ids) expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1)
  })

  it('trailing is a sibling of the heading, never inside the button', () => {
    render(<Controlled trailing={<button type="button">Water all 97</button>} />)
    const disclosure = screen.getByRole('button', { name: /Needs care/ })
    const action = screen.getByRole('button', { name: 'Water all 97' })
    expect(disclosure.contains(action)).toBe(false)
    expect(disclosure.closest('h2').contains(action)).toBe(false)
    expect(screen.getByTestId('facet-group-header').contains(action)).toBe(true)
  })

  it('the chevron is a glyph swap: no transform, no transition, aria-hidden', () => {
    render(<Controlled />)
    const btn = screen.getByRole('button', { name: /Needs care/ })
    const glyph = () => btn.querySelector('[aria-hidden="true"]')
    expect(glyph().textContent).toBe('▸')
    fireEvent.click(btn)
    expect(glyph().textContent).toBe('▾')
    for (const el of [btn, ...btn.querySelectorAll('*')]) {
      expect(el.style.transform || '').toBe('')
      expect(el.style.transition || '').toBe('')
    }
  })

  it('summary is line 2 inside the button, in P.mid (never P.light on the band)', () => {
    render(<Controlled summary="8 tray cells due · 9 spots" />)
    const btn = screen.getByRole('button', { name: /8 tray cells due/ })
    const line2 = [...btn.querySelectorAll('span')].find((s) => s.textContent === '8 tray cells due · 9 spots')
    expect(line2.style.color).toBe('rgb(74, 74, 74)')
  })

  it('meets the 48px floor and the heading carries no margin', () => {
    render(<Controlled />)
    const btn = screen.getByRole('button', { name: /Needs care/ })
    expect(btn.style.minHeight).toBe('48px')
    expect(btn.parentElement.style.margin).toBe('0px')
  })

  it('size="row": no band chrome of its own, chevron last, heading level honoured', () => {
    render(<FacetGroupHeader headingLevel={4} size="row" label="Bag Area" count={141} facet="type" collapsed onToggle={noop} />)
    const btn = screen.getByRole('button', { name: /Bag Area/ })
    expect(btn.parentElement.tagName).toBe('H4')
    const band = screen.getByTestId('facet-group-header')
    expect(band.style.backgroundColor).toBe('')
    expect(band.style.borderLeft).toBe('')
    const spans = [...btn.firstChild.children]
    expect(spans[spans.length - 1].textContent).toBe('▸')
  })

  it('without onToggle it is the non-collapsible form: a static heading and a panel always shown', () => {
    render(<FacetGroupHeader headingLevel={2} label="Jen’s care" count={15} facet="type"><p data-testid="always">rows</p></FacetGroupHeader>)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Jen’s care')
    expect(screen.getByTestId('always')).toBeTruthy()
    expect(document.querySelector('[aria-expanded]')).toBeNull()
  })
})
