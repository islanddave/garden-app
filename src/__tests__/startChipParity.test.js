// The start-chip vocabulary exists in TWO files, and they must agree.
//
// WHY THIS FILE EXISTS. `src/components/kitchen/StartChips.jsx` (the capture card) and
// `src/components/putup/goingNow.js` (the Going-now "Set a start date" sheet) were built by two
// concurrent lanes from the same panel ruling. Both offer the same six labels, and both turn a tapped
// label into a back-dated instant plus a precision grade. They agreed on 18 days for "2–3 weeks" and
// DISAGREED on "A few days ago" — 4 in capture, 3 in Going-now. Same chip, same batch, different
// stored date depending on which screen the user reached it from, and nothing anywhere would have
// noticed.
//
// The panel's stated rule is the MIDPOINT of the window each chip names (3–5 days → 4, 14–21 → 18),
// so capture was right and Going-now was corrected at integration.
//
// WHY A PARITY TEST RATHER THAN ONE SHARED MODULE. The two tables genuinely differ in shape:
// Going-now carries an `anchor` and keys rows by `value`, capture keys by `id` and carries an extra
// `pickdate` row that has no Going-now equivalent. Collapsing them would mean one surface importing a
// field it never reads, which is how a shared constant starts drifting for real reasons. Asserting
// the OVERLAP is the honest guard: it binds exactly what both surfaces claim to mean and leaves each
// free where they legitimately differ.
//
// TEXT PARSE, not import: StartChips.jsx is JSX with React imports, and this assertion is about the
// declared literals rather than about anything either module computes.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..', '..')

const CAPTURE = readFileSync(resolve(root, 'src/components/kitchen/StartChips.jsx'), 'utf8')
const GOINGNOW = readFileSync(resolve(root, 'src/components/putup/goingNow.js'), 'utf8')

// Both tables are arrays of one-line object literals. Pull label -> {days, precision} out of each by
// its OWN key name, so a rename on either side reads as a parse failure rather than as agreement.
function parseChips(src, daysKey) {
  const out = {}
  for (const line of src.split('\n')) {
    if (!line.includes('label:')) continue
    const label = line.match(/label:\s*'([^']+)'/)?.[1]
    const days = line.match(new RegExp(`${daysKey}:\\s*(null|-?\\d+)`))?.[1]
    const precision = line.match(/precision:\s*'([^']+)'/)?.[1]
    if (!label || days === undefined || !precision) continue
    out[label] = { days: days === 'null' ? null : Number(days), precision }
  }
  return out
}

const capture = parseChips(CAPTURE, 'daysAgo')
const goingNow = parseChips(GOINGNOW, 'days')

describe('start chips — the capture card and the Going-now sheet mean the same thing', () => {
  // INSTRUMENT CHECK FIRST. Both objects being empty would satisfy every assertion below by iterating
  // nothing — the vacuity that let the original disagreement live. Floors, not inventories, so adding
  // a chip does not red this.
  it('both tables parsed to a populated vocabulary', () => {
    expect(Object.keys(capture).length).toBeGreaterThanOrEqual(6)
    expect(Object.keys(goingNow).length).toBeGreaterThanOrEqual(6)
  })

  it('the two tables actually overlap, so the comparison below is not over an empty set', () => {
    const shared = Object.keys(capture).filter((l) => l in goingNow)
    expect(shared.length).toBeGreaterThanOrEqual(6)
    // The chip that was wrong. Named so a future edit cannot quietly drop it from the overlap and
    // make this file pass by comparing five rows instead of six.
    expect(shared).toContain('A few days ago')
    expect(shared).toContain('2–3 weeks')
  })

  it.each(Object.keys(capture).filter((l) => l in goingNow))(
    '"%s" back-dates by the same number of days and carries the same precision on both surfaces',
    (label) => {
      expect(
        goingNow[label],
        `"${label}": capture says ${JSON.stringify(capture[label])}, ` +
          `Going-now says ${JSON.stringify(goingNow[label])} — the same tap must produce the same date`,
      ).toEqual(capture[label])
    },
  )

  // The midpoint rule itself, pinned once so the agreed values cannot both drift to the same wrong
  // number. A parity test alone would stay green if someone "fixed" capture down to 3 to match.
  it('the two windowed chips sit at the midpoint of the window they name', () => {
    expect(capture['A few days ago'].days).toBe(4) // 3–5 days
    expect(capture['2–3 weeks'].days).toBe(18) // 14–21 days
  })
})
