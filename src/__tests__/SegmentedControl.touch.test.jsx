// Put-Up R2a (prep) — SegmentedControl's opt-in `touch` prop (FROZEN.md: "extend one of these — new prop").
// Absent, every caller renders as before: 40 px options. With it, the options are the 48 px tap target.
// The third test is the one-literal contract: gate:seeds-saved and gate:seeds-page READ the primitive's
// floor from its source (scripts/layout-gate/segmented-control-exemption.mjs) and throw unless the file
// carries exactly one numeric minHeight — so the 48 must come from the token, never a second literal, and
// no comment in the primitive may spell one. Asserted here so it fails in vitest, not only in two gates.
// MUTATION: write the touch height as a literal 48 in SegmentedControl.jsx -> the floor test reds (it throws).
// CI lane: `npm test` plus the TZ re-run. Nothing here reads a clock. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import SegmentedControl from '../components/forms/SegmentedControl.jsx'
import { T } from '../components/forms/formStyles.js'
import { segmentedRadioFloorPx } from '../../scripts/layout-gate/segmented-control-exemption.mjs'

afterEach(() => cleanup())

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OPTIONS = [{ value: 'a', label: 'Pantry' }, { value: 'b', label: 'Going now' }, { value: 'c', label: 'Recipes' }]
const heights = () => screen.getAllByRole('radio').map(r => r.style.minHeight)

describe('SegmentedControl — the opt-in touch height', () => {
  it('without `touch`, every option is 40 px — small or not, and with touch={false}', () => {
    const { unmount } = render(<SegmentedControl options={OPTIONS} value="a" ariaLabel="View" />)
    expect(heights()).toEqual(['40px', '40px', '40px'])
    unmount()
    const small = render(<SegmentedControl options={OPTIONS} value="a" ariaLabel="View" small />)
    expect(heights()).toEqual(['40px', '40px', '40px'])
    small.unmount()
    render(<SegmentedControl options={OPTIONS} value="a" ariaLabel="View" touch={false} />)
    expect(heights()).toEqual(['40px', '40px', '40px'])
  })

  it('with `touch`, every option is the 48 px tap target, and nothing else about it changes', () => {
    const plain = render(<SegmentedControl options={OPTIONS} value="a" ariaLabel="View" small />)
    const before = plain.container.innerHTML
    plain.unmount()
    const { container } = render(<SegmentedControl options={OPTIONS} value="a" ariaLabel="View" small touch />)
    expect(T.buttonMinHeight).toBe(48)
    expect(heights()).toEqual(['48px', '48px', '48px'])
    expect(container.innerHTML).toBe(before.replaceAll('min-height: 40px', 'min-height: 48px'))
    // The prop is the control's own: it is not passed down to the DOM.
    expect(screen.getByRole('radiogroup').hasAttribute('touch')).toBe(false)
  })

  it('the gates still read one floor from the source, and it is 40', () => {
    expect(segmentedRadioFloorPx(REPO)).toBe(40)
    const src = readFileSync(resolve(REPO, 'src/components/forms/SegmentedControl.jsx'), 'utf8')
    expect(src.match(/minHeight:\s*\d+/g)).toEqual(['minHeight: 40'])
    expect(src).toContain('minHeight: T.buttonMinHeight')
  })
})
