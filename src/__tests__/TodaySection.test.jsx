// V5-TODAYREDESIGN-001 — TodaySection as a controlled section. Moved verbatim at the L8 review (QA MINOR) from
// TodayRoute.test.jsx, which S8c (L8) deleted with the old page's switch: TodaySection is the redesign's own
// component, not switch code. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import TodaySection from '../components/today/v2/TodaySection.jsx'

afterEach(() => cleanup())

describe('TodaySection', () => {
  function Host() {
    const [open, setOpen] = useState(false)
    return <TodaySection sectionKey="care" title="Needs care" count={233} summary="8 tray cells due" open={open} onToggle={() => setOpen((o) => !o)}><p data-testid="body">rows</p></TodaySection>
  }

  it('is controlled: `open` drives aria-expanded and the mounted body; the anchor is today-sec-<key>', () => {
    render(<Host />)
    const sec = screen.getByTestId('today-sec-care')
    expect(sec.tagName).toBe('SECTION')
    const btn = sec.querySelector('[aria-expanded]')
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.closest('h2')).toBeTruthy()
    expect(screen.queryByTestId('body')).toBeNull()
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(sec.contains(screen.getByTestId('body'))).toBe(true)
    expect(sec.querySelectorAll('[data-testid^="today-sec-"]')).toHaveLength(0)
  })

  it('without onToggle it is the non-collapsible form', () => {
    render(<TodaySection sectionKey="hh-member_j" title="Jen’s care" count={15}><p data-testid="body">rows</p></TodaySection>)
    expect(screen.getByTestId('body')).toBeTruthy()
    expect(screen.getByTestId('today-sec-hh-member_j').querySelector('[aria-expanded]')).toBeNull()
  })

  it('an open section ignores a click that is not its own', () => {
    const onToggle = vi.fn()
    render(<TodaySection sectionKey="resting" title="Resting" open onToggle={onToggle}><button type="button">Resume</button></TodaySection>)
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(onToggle).not.toHaveBeenCalled()
  })
})
