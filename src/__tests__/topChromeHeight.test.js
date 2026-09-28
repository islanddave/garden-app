// V5-TODAYREDESIGN-001 S2 — TOP_CHROME_HEIGHT_PX (constants.js) and TopChrome's own BAR_H must be one number.
// Read off TopChrome's SOURCE with the same pattern the layout gates use (today-shape.mjs:118 and six
// siblings), because BAR_H is a module-private literal those gates depend on and cannot be imported.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TOP_CHROME_HEIGHT_PX } from '../lib/constants.js'

describe('TOP_CHROME_HEIGHT_PX', () => {
  it('equals TopChrome.jsx BAR_H, declared exactly once as a literal the gates can parse', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/components/TopChrome.jsx'), 'utf8')
    const found = [...src.matchAll(/const BAR_H = (\d+)/g)].map((m) => Number(m[1]))
    expect(found).toHaveLength(1)
    expect(found[0]).toBe(TOP_CHROME_HEIGHT_PX)
  })
})
