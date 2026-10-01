// Put-Up UX pass R1 (prep) — src/components/putup/soonTint.js SOON_CHIP_STYLE: the style of a discard-date
// line whose status is "soon" or "past". Tokens only, and the ink must clear WCAG AA on the tint.
// Prep only exports it; the Pantry and the planting page apply it in their own lanes.
// MUTATION: swap the ink for P.light, or spell a colour as a hex -> red.
// CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182). Nothing here reads a clock.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { SOON_CHIP_STYLE } from '../components/putup/soonTint.js'
import { P } from '../lib/constants.js'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(resolve(here, '../components/putup/soonTint.js'), 'utf8')

// WCAG 2.x relative luminance and contrast ratio, from two #rrggbb tokens.
const channel = (hex, i) => {
  const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const luminance = (hex) => 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2)
const contrast = (ink, ground) => {
  const [hi, lo] = [luminance(ink), luminance(ground)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}
const AA_NORMAL_TEXT = 4.5

describe('SOON_CHIP_STYLE — the tint of a discard-date line that is soon or past', () => {
  it('is the warn background, dark ink, weight 600, and the small padding and radius of the use-soon pill', () => {
    expect(SOON_CHIP_STYLE).toStrictEqual({
      backgroundColor: P.warn, color: P.dark, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
    })
  })

  it('spells no colour of its own: every colour is a P token', () => {
    expect(SOON_CHIP_STYLE.backgroundColor).toBe(P.warn)
    expect(SOON_CHIP_STYLE.color).toBe(P.dark)
    // Green controls: the tokens are real six-digit colours, so the two lines above compared something.
    expect(P.warn).toMatch(/^#[0-9a-f]{6}$/i)
    expect(P.dark).toMatch(/^#[0-9a-f]{6}$/i)
    const code = SOURCE.replace(/^\s*\/\/.*$/gm, '')
    expect(code).toContain('SOON_CHIP_STYLE')
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(code).not.toMatch(/\brgba?\(|\bhsla?\(/i)
  })

  it('the ink on the tint clears WCAG AA for normal text', () => {
    const ratio = contrast(SOON_CHIP_STYLE.color, SOON_CHIP_STYLE.backgroundColor)
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
    // The measured figure, pinned so a token change that moves it is seen: 16.43 to 1.
    expect(Math.round(ratio * 100) / 100).toBe(16.43)
    // The instrument, checked against the two ends of the scale and against a figure the token file records.
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#ffffff', '#ffffff')).toBe(1)
    expect(Math.round(contrast(P.gold, P.cream) * 100) / 100).toBe(4.44)
  })

  it('the ink is at least as dark on the tint as the gold the use-soon pill used', () => {
    expect(contrast(SOON_CHIP_STYLE.color, P.warn)).toBeGreaterThanOrEqual(contrast(P.gold, P.warn))
  })

  it('is frozen: one surface cannot restyle it for the others', () => {
    expect(Object.isFrozen(SOON_CHIP_STYLE)).toBe(true)
    expect(() => { SOON_CHIP_STYLE.color = P.light }).toThrow(TypeError)
  })

  it('paints as a React style, alone and spread over a line\'s own style', () => {
    render(
      <>
        <span data-testid="alone" style={SOON_CHIP_STYLE}>discard by Oct 3 · soon</span>
        <p data-testid="spread" style={{ margin: 0, color: P.mid, fontSize: '0.82rem', ...SOON_CHIP_STYLE }}>discard date passed Sep 2</p>
      </>,
    )
    const rgb = (hex) => `rgb(${[0, 1, 2].map(i => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)).join(', ')})`
    for (const id of ['alone', 'spread']) {
      const s = screen.getByTestId(id).style
      expect(s.backgroundColor).toBe(rgb(P.warn))
      expect(s.color).toBe(rgb(P.dark))
      expect(s.fontWeight).toBe('600')
      expect(s.padding).toBe('2px 8px')
      expect(s.borderRadius).toBe('999px')
    }
    expect(screen.getByTestId('spread').style.fontSize).toBe('0.82rem')
  })
})
