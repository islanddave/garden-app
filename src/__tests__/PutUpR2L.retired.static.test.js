// Put-Up R2b, lane T — the retirement of the "Log a put-up" form STAYS a retirement (PLAN-R2-V2 section 9;
// the QA seat's "retired-strings static test", mutant L-M14).
//
// SOURCE-TEXT pins, read off the files as they are on disk (withFrom's is on what it RETURNS: "does not
// carry" has no one spelling in source, and its answer is the pin). PutUpR2L.landing.test.jsx holds what the page
// DOES with an old entry; this file holds what must not come back in the source: the form and its harvest
// picker, the prefill module and every read of a prefill, the `log` segment, a read or a write of the
// form's draft, and the overlay's old name.
//
// CODE, NOT COMMENTS. Each "is gone" pin reads the file with its block comments and its whole-line `//`
// comments taken out, so a comment that says what used to be here stays free to say it. The stripper is
// checked against the same files (it must leave the code it is about to be asked about).
// CI lane: `npm test` plus the TZ re-run. Nothing here renders or reads a clock.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { withFrom, readFrom } from '../components/putup/origin.js'

// vitest rewrites import.meta.url to a server-root URL, so resolve off the project root instead
// (seedsDoorCensus.static.test.js does the same).
const ROOT = process.cwd()
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')
const PAGE = 'src/pages/PutUp.jsx'
const SHELL = 'src/components/putup/goingNow.js'
const ORIGIN = 'src/components/putup/origin.js'
const APP = 'src/App.jsx'
const PREFILL_MODULE = 'src/lib/putUpPrefill.js'

// The file's code: `/* … */` and `{/* … */}` blocks out, then every line that is only a `//` comment. A block
// opens only at the start of a line or after a space or a bracket, so the `/*` in a string (accept="image/*",
// a route's '/admin/*') opens nothing and hides nothing.
const code = (p) => read(p).replace(/(^|[\s{(,;])\/\*[\s\S]*?\*\//g, '$1').replace(/^\s*\/\/.*$/gm, '')
// Every line of `src` that matches, trimmed: what a red run prints.
const hits = (src, re) => src.split('\n').map(l => l.trim()).filter(l => re.test(l))

describe('the stripper leaves the code it is asked about', () => {
  it('the page, the shell and the origin module still read as themselves with their comments out', () => {
    expect(code(PAGE)).toContain('export default function PutUp(')
    expect(code(PAGE)).toContain('function RowEditor(')
    expect(code(SHELL)).toContain('export const PUT_UP_SEGMENTS = Object.freeze([')
    expect(code(SHELL)).toContain('export function originSegment(')
    expect(code(ORIGIN)).toContain('export function withFrom(')
    // …and takes the comments: goingNow.js opens on one, and none of its lines is left starting with `//`.
    expect(read(SHELL).trimStart().startsWith('//')).toBe(true)
    expect(hits(code(SHELL), /^\/\//)).toEqual([])
  })
})

describe('the form is gone from the page and the page shell', () => {
  it.each([PAGE, SHELL])('%s: no PutUpForm', (file) => {
    expect(hits(code(file), /PutUpForm/)).toEqual([])
  })

  it.each([PAGE, SHELL])('%s: no RecentHarvestPicker', (file) => {
    expect(hits(code(file), /RecentHarvestPicker/)).toEqual([])
  })

  it.each([PAGE, SHELL])('%s: nothing is imported from putUpPrefill, and no line of code names it', (file) => {
    expect(hits(code(file), /putUpPrefill/)).toEqual([])
  })

  it('src/lib/putUpPrefill.js does not exist', () => {
    expect(existsSync(resolve(ROOT, PREFILL_MODULE))).toBe(false)
  })

  // The static half of "the key is never read": the word is in no line of the page's code, in any case
  // (`prefill`, `hasPrefill`, `prefillKey`, `clearPrefill`, `putup-prefill-strip`).
  it('the page’s code never says "prefill"', () => {
    expect(hits(code(PAGE), /prefill/i)).toEqual([])
  })
})

describe('the log segment is gone', () => {
  it('the shell’s list has no `log` value and no "Log a put-up" label among its segments', () => {
    const list = code(SHELL).match(/export const PUT_UP_SEGMENTS = Object\.freeze\(\[([\s\S]*?)\]\)/)
    expect(list).not.toBeNull()
    const rows = [...list[1].matchAll(/value:\s*'([^']*)',\s*label:\s*'([^']*)'/g)].map(m => [m[1], m[2]])
    expect(rows).toEqual([['going', 'Going now'], ['pantry', 'Pantry'], ['recipes', 'Recipes']])
    expect(hits(code(SHELL), /value:\s*['"]log['"]/)).toEqual([])
  })

  it.each([PAGE, SHELL])('%s: no line of code holds the segment’s value, \'log\', as a string', (file) => {
    expect(hits(code(file), /(['"`])log\1/)).toEqual([])
  })
})

describe('the form’s draft key is kept, as retired', () => {
  it('the page still declares it, spelled as it is stored on a phone', () => {
    expect(hits(code(PAGE), /^const DRAFT_KEY = 'put-up'$/)).toEqual(["const DRAFT_KEY = 'put-up'"])
  })

  it('the page clears that key and does nothing else with it: no read, no write', () => {
    expect(hits(code(PAGE), /clearDraft\(\s*DRAFT_KEY\s*\)/).length).toBeGreaterThan(0)
    expect(hits(code(PAGE), /\b(readDraft|writeDraft)\b/)).toEqual([])
  })
})

describe('withFrom does not carry a prefill', () => {
  const BG = { pathname: '/today', search: '', hash: '', key: 'bg', historyEntry: { idx: 0, doc: 'd1' } }
  const PREFILL = { crop_type_slug: 'pepper', harvest_log_id: 'h-1' }

  it('it is dropped from the state a push or a replace is given, with or without an origin', () => {
    expect(withFrom({ background: BG, prefill: PREFILL }, null)).toEqual({ background: BG })
    expect(withFrom({ background: BG, prefill: PREFILL }, { label: 'Pantry' })).toEqual({ background: BG, from: { label: 'Pantry' } })
    expect(withFrom({ prefill: PREFILL }, null)).toBeNull()
    expect(withFrom({ prefill: PREFILL, from: { label: 'Recipes' } }, null)).toBeNull()
  })

  it('every other key still rides along by reference, and the state handed in is not changed', () => {
    const state = { background: BG, prefill: PREFILL, somethingNew: { a: 1 } }
    const out = withFrom(state, { label: 'Going now' })
    expect(Object.keys(out).sort()).toEqual(['background', 'from', 'somethingNew'])
    expect(out.background).toBe(BG)
    expect(out.somethingNew).toBe(state.somethingNew)
    expect(state.prefill).toBe(PREFILL)
    expect(readFrom(out)).toEqual({ label: 'Going now' })
  })
})

describe('the overlay names the page, not the form', () => {
  it('App.jsx’s /put-up route is labelled "Put-Up"', () => {
    const routes = read(APP).split('\n').filter(l => /path:\s*'\/put-up'/.test(l))
    expect(routes).toHaveLength(1)
    expect(routes[0].match(/ariaLabel:\s*'([^']*)'/)?.[1]).toBe('Put-Up')
    expect(hits(read(APP), /Log a put-up/)).toEqual([])
  })
})
