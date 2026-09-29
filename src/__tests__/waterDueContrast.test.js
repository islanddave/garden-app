import { describe, it, expect } from 'vitest'
import { SEVERITY_STYLES } from '../lib/waterDue.js'
import { P } from '../lib/constants.js'

// V5-TODAYREDESIGN-001 R18 — every severity tier's text must clear WCAG AA (4.5:1) on its own chip
// fill: the care chip label is 0.8rem, normal-size text. terra's P.terra text sat at 4.15:1.
function lum(hex) {
  const h = hex.replace('#', '')
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }

describe('SEVERITY_STYLES text contrast (R18)', () => {
  it('terra text is P.severityUrgent, border stays P.terra', () => {
    expect(SEVERITY_STYLES.terra.text).toBe(P.severityUrgent)
    expect(SEVERITY_STYLES.terra.border).toBe(P.terra)
  })
  for (const tier of ['green', 'gold', 'terra', 'terra-bold']) {
    it(`${tier} text clears 4.5:1 on its fill`, () => {
      const s = SEVERITY_STYLES[tier]
      expect(ratio(s.text, s.bg)).toBeGreaterThanOrEqual(4.5)
    })
  }
})
