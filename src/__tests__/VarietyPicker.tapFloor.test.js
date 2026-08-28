// VarietyPicker.tapFloor.test.js — BUG-ADOPTTAPFLOOR-001.
//
// The "Use <existing crop>" adopt button declared minHeight: 40, under the 44px floor the app
// enforces everywhere else. It is a real interactive button, not a chip, so it takes tapMinHeight
// rather than chipMinHeight. It was left as a literal during the Pass A token migration ON PURPOSE
// — aliasing it to the chip token would have buried an accessibility finding inside a mechanical
// rename and made it invisible.
//
// WHAT THIS CAN AND CANNOT PROVE. jsdom has no layout engine, so nothing here measures 44 CSS px —
// same honesty scoping as EventNew.micTouchTarget.test.jsx. And the style object is a module-level
// const that VarietyPicker.jsx does not export, so it cannot be imported and inspected either. What
// this pins is the SOURCE: that the declaration routes through the token and carries no numeric
// literal. Rendering it would need the component driven into the crop-mint error state with a
// server-steered `existing` crop, which is a lot of fixture for a constant.
//
// Assertions run against DECOMMENTED source. The fix's own explanatory comment names both
// `minHeight` and the number 40 while describing the defect, and a raw-source guard would find its
// own epitaph and pass.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { T } from '../components/forms/formStyles.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const decomment = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')

const RAW = readFileSync(resolve(__dirname, '../components/VarietyPicker.jsx'), 'utf8')
const SRC = decomment(RAW)

function styleBlock(name) {
  const start = SRC.indexOf(`const ${name} = {`)
  if (start === -1) return null
  const end = SRC.indexOf('\n}', start)
  return end === -1 ? null : SRC.slice(start, end)
}

describe('BUG-ADOPTTAPFLOOR-001 — the adopt button clears the tap floor', () => {
  // INSTRUMENT CHECK, first. Every assertion below is worthless if the token is not actually 44:
  // routing a control "through the token" satisfies the guard just as well at 20.
  it('T.tapMinHeight is 44 — the WCAG 2.5.5 target this file is about', () => {
    expect(T.tapMinHeight).toBe(44)
  })

  // NON-VACUITY. If the const is renamed or restructured, styleBlock returns null and every
  // toContain below would pass against an empty string. Fail loudly instead.
  it('the adoptButtonStyle declaration is findable', () => {
    expect(styleBlock('adoptButtonStyle'), 'adoptButtonStyle not found — rename? update this guard').toBeTruthy()
  })

  it('routes minHeight through T.tapMinHeight, not a literal', () => {
    const block = styleBlock('adoptButtonStyle')
    expect(block).toContain('minHeight: T.tapMinHeight')
    // No numeric minHeight anywhere in the block — this is what fails if someone "tidies" it back
    // to a number, including a number that happens to be 44 today and drifts later.
    expect(block).not.toMatch(/minHeight:\s*\d/)
  })

  it('does NOT use the chip token — this is a button, not a chip', () => {
    // The distinction is the entire reason the literal was left in place rather than swept up by
    // the Pass A migration. chipMinHeight is a smaller floor and is correct for chips.
    expect(styleBlock('adoptButtonStyle')).not.toContain('chipMinHeight')
  })

  it('the guard actually reads the file it thinks it does', () => {
    // Cheap anchor: if this ever fails, the path resolved somewhere unexpected and every assertion
    // above has been inspecting the wrong source.
    expect(RAW).toContain('adoptSteeredCropType')
  })
})
