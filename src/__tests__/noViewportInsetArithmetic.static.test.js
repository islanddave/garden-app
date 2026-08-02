// V4-KBVIEWPORT-001 — anti-regression guard against reintroducing the visualViewport inset lift.
//
// WHY THIS EXISTS. Deleting `useVisualViewportInset` from EventNew.jsx is a provable NO-OP in the
// test suite: jsdom has no `window.visualViewport`, so the hook early-returned and `kbInset` was
// ALWAYS 0. `bottom: kbInset` rendered `0px` and `bottom: 68 + kbInset` rendered `68px` — byte
// identical to the post-delete values. Zero tests broke; zero tests confirmed. There is therefore
// no behavioral test that can guard this deletion, and a future session re-adding the hook to
// "fix the keyboard" would break nothing. A source-text guard is the only instrument available.
//
// WHY THE SCOPE IS NARROW. A blanket "no visualViewport in src/" would fail on day one:
// PlantingSelect.jsx uses it LEGITIMATELY in measurePlacement, and that usage is correct under both
// viewport models. The invariant is not "no visualViewport" — it is "no keyboard-inset arithmetic".
//
// WHAT IT CATCHES: the hook, or an equivalent `innerHeight - <viewport>.height` lift, coming back
// in EventNew.jsx; and that arithmetic pattern appearing anywhere else under src/.
// WHAT IT DOES NOT CATCH: the same lift split across two statements or accumulated into a variable
// before subtraction; and it is brittle to a legitimate rename of EventNew.jsx, which would
// silently stop guarding it.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = process.cwd()
const EVENT_NEW = resolve(ROOT, 'src/pages/EventNew.jsx')

// `innerHeight - <anything>.height`. Deliberately matches a LOCAL ALIAS (`vv.height`), not just a
// literal `visualViewport.height` — the deleted hook aliased it, and an alias is the most likely
// shape for it to return in. Walking node_modules is not a risk: the walk below stays under src/.
const INSET_ARITHMETIC = /innerHeight\s*-\s*[\w.]+\.height/

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue
      walk(full, out)
    } else if (/\.(js|jsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

// Strip comments: the files deliberately DOCUMENT the deleted hook by name, and that prose is the
// thing stopping the next reader from re-adding it. Guard the code, not the commentary.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('no visualViewport keyboard-inset arithmetic (V4-KBVIEWPORT-001)', () => {
  it('EventNew.jsx carries no live visualViewport usage or kbInset binding', () => {
    const code = stripComments(readFileSync(EVENT_NEW, 'utf8'))
    expect(code).not.toMatch(/visualViewport/)
    expect(code).not.toMatch(/kbInset/)
    expect(code).not.toMatch(/useVisualViewportInset/)
  })

  it('no file under src/ computes a keyboard inset from innerHeight minus a viewport height', () => {
    const offenders = walk(resolve(ROOT, 'src'))
      .filter(f => INSET_ARITHMETIC.test(stripComments(readFileSync(f, 'utf8'))))
      .map(f => f.slice(ROOT.length + 1))
    expect(offenders).toEqual([])
  })

  it('SELF-TEST: the matcher flags the exact expression that was deleted, alias and all', () => {
    // Verbatim body of the removed hook. If this stops matching, the sweep above is vacuous.
    const removed = 'setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))'
    expect(INSET_ARITHMETIC.test(removed)).toBe(true)
    expect(INSET_ARITHMETIC.test('window.innerHeight - window.visualViewport.height')).toBe(true)
    // And does not fire on unrelated arithmetic.
    expect(INSET_ARITHMETIC.test('const pad = window.innerHeight - 120')).toBe(false)
  })
})
