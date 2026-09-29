// The start-chip vocabulary exists in TWO files, and where they share a word they must agree.
//
// WHY THIS FILE EXISTS. Two start-chip tables were built by concurrent lanes from one panel ruling and
// DISAGREED on "A few days ago" — 4 days on the Snap card, 3 on Going now — so the same chip on the same
// batch stored a different date depending on which screen it was tapped from, and nothing noticed. The
// panel's rule is the MIDPOINT of the window each chip names (3–5 days → 4, 14–21 → 18).
//
// ⚠ AMENDED by Put-Up 1a item 5, in the same commit as the change. The Snap card's seven-chip table in
// src/components/kitchen/StartChips.jsx was RETIRED: Snap now opens the ONE shared Start sheet, whose
// chips are Today · Yesterday · Earlier… · Not sure (V4 §2.2, Appendix B). The other table —
// goingNow.js's six chips, behind "Set a start date →", which moved to batch detail — is unchanged.
// So the two tables now share TWO labels, Today and Yesterday, plus one answer spelled differently on
// each ("Not sure" / "Longer / not sure"). This file binds exactly that overlap, and pins the two
// midpoints on the table that still carries them, so they cannot drift to the same wrong number.
//
// TEXT PARSE, not import: StartChips.jsx is JSX with React imports, and this assertion is about the
// declared literals rather than about anything either module computes.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..', '..')

const SHEET = readFileSync(resolve(root, 'src/components/kitchen/StartChips.jsx'), 'utf8')
const GOINGNOW = readFileSync(resolve(root, 'src/components/putup/goingNow.js'), 'utf8')

// Both tables are arrays of one-line object literals. Pull label -> {days, precision} out of each by
// its OWN key name, so a rename on either side reads as a parse failure rather than as agreement.
// Rows with no day count (Earlier…, and the window chips under it) are not fixed-day rows and are
// skipped by construction.
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

const sheet = parseChips(SHEET, 'daysAgo')
const goingNow = parseChips(GOINGNOW, 'days')

describe('start chips — the Start sheet and the batch-detail start editor mean the same thing', () => {
  // INSTRUMENT CHECK FIRST. Both objects being empty would satisfy every assertion below by iterating
  // nothing — the vacuity that let the original disagreement live.
  it('both tables parsed to a populated vocabulary', () => {
    expect(Object.keys(sheet).sort()).toEqual(['Not sure', 'Today', 'Yesterday'])
    expect(Object.keys(goingNow).length).toBeGreaterThanOrEqual(6)
  })

  it('the two tables actually overlap, so the comparison below is not over an empty set', () => {
    const shared = Object.keys(sheet).filter((l) => l in goingNow)
    expect(shared.sort()).toEqual(['Today', 'Yesterday'])
  })

  it.each(Object.keys(sheet).filter((l) => l in goingNow))(
    '"%s" back-dates by the same number of days and carries the same precision on both surfaces',
    (label) => {
      expect(
        goingNow[label],
        `"${label}": the Start sheet says ${JSON.stringify(sheet[label])}, ` +
          `Going-now says ${JSON.stringify(goingNow[label])} — the same tap must produce the same date`,
      ).toEqual(sheet[label])
    },
  )

  // The one answer spelled two ways. Both must be the permanent "asked, does not know" state — no
  // instant, precision 'unknown' — or one surface would store a guess where the other stores none.
  it('"Not sure" and "Longer / not sure" are the same answer', () => {
    expect(sheet['Not sure']).toEqual({ days: null, precision: 'unknown' })
    expect(goingNow['Longer / not sure']).toEqual(sheet['Not sure'])
  })

  // The midpoint rule itself, pinned on the table that still carries windowed chips.
  it('the two windowed chips sit at the midpoint of the window they name', () => {
    expect(goingNow['A few days ago'].days).toBe(4) // 3–5 days
    expect(goingNow['2–3 weeks'].days).toBe(18) // 14–21 days
  })
})
