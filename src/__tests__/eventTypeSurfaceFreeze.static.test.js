// V4-PICKERGATE-001 — freeze WHICH files render the event-type vocabulary, and in which role.
//
// WHY A STATIC SOURCE SCAN AND NOT A RUNTIME TEST. The failure this guards is a file that does not
// exist yet: a SIXTH surface that maps SELECTABLE_EVENT_TYPES into a <select> with no capture panel
// and re-creates the exact defect this lane fixed. A runtime test cannot see it — a surface that
// forgets to declare itself produces nothing to enumerate, and the absence is the bug. Only a scan
// of the source can. Idiom and comment-stripping copied from modalSurfaceFreeze.static.test.js.
//
// THE CLASSIFICATION IS THE POINT, not the file count. Every consumer of the vocabulary is one of
// exactly two things and they need opposite treatment:
//   read     — filters rows that ALREADY EXIST. Must see the WHOLE vocabulary; narrowing it hides
//              real history (FeedPage).
//   creation — builds a POST. Must offer only what it can submit, via creatableEventTypes().
// Getting these backwards is the plausible wrong fix, so the registry states the role explicitly
// rather than leaving it to be inferred from which constant a file happens to import.
//
// A THIRD SCAN ARM WAS TRIED AND REJECTED: "files containing bare EVENT_TYPES and a <option>",
// intended to catch a surface that routes around SELECTABLE_EVENT_TYPES entirely. Its only hit
// today is pages/EventNew.jsx, where the two tokens are unrelated (an EVENT_TYPES import used only
// via EVENT_TYPES_UI, and the harvest-unit <select>). Freezing a list with a known false positive
// in it is how a freeze test stops meaning anything, so the arm is documented here instead of
// shipped noisy.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(process.cwd(), 'src') + '/'

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(jsx?|tsx?)$/.test(name)) out.push(full)
  }
  return out
}

const rel = (f) => f.slice(SRC.length)

// Comments stripped LINE-WISE, not with a /* */ regex: this codebase documents heavily and several
// of these very files DISCUSS the constant in prose. A block-comment stripper has already swallowed
// real code in this repo once (App.jsx's <Sheet> site), which is the worse failure — a scanner that
// under-reports leaves the freeze passing while blind.
const isCommentLine = (line) => {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')
}
const codeOf = (src) => src.split('\n').filter((l) => !isCommentLine(l)).join('\n')

function scan() {
  const selectable = new Set()
  const creatable = new Set()
  for (const f of walk(SRC)) {
    const src = codeOf(readFileSync(f, 'utf8'))
    if (/\bSELECTABLE_EVENT_TYPES\b/.test(src)) selectable.add(rel(f))
    if (/\bcreatableEventTypes\b/.test(src)) creatable.add(rel(f))
  }
  return { selectable, creatable }
}

// ── The frozen registry. Adding a row is a DELIBERATE act: state the role and, for a creation
//    surface, the capabilities it declares. ───────────────────────────────────────────────────────

// Files naming SELECTABLE_EVENT_TYPES. `role: 'seam'` = defines or re-exports it, renders nothing.
const SELECTABLE_CONSUMERS = {
  'lib/eventTypes.js':                  { role: 'seam', note: 'defines it; creatableEventTypes reads it' },
  'lib/constants.js':                   { role: 'seam', note: 're-export for the historic importers' },
  'pages/FeedPage.jsx':                 { role: 'read', note: 'activity-feed filter — MUST show every type' },
  // The picker's `available` default. Its only default-taking host is EventNew, which renders every
  // required capture panel; LogMany passes BATCH_EVENT_TYPES explicitly. A future panel-LESS host
  // must pass its own creatableEventTypes list rather than take this default.
  'components/forms/EventTypePicker.jsx': { role: 'creation', note: 'default `available` for the panel-bearing host' },
}

// Files calling creatableEventTypes — every creation surface that cannot collect everything.
const CREATION_SURFACES = {
  'lib/eventTypes.js':      { note: 'defines it' },
  'pages/ProjectDetail.jsx': { caps: 'capturePanels:false, plantScoped:true  — mini-logger has a planting picker' },
  'pages/CaptureFlow.jsx':   { caps: 'capturePanels:false, plantScoped:true (event) / !flag (location)' },
}

const diff = (found, frozen) => ({
  missing: [...Object.keys(frozen)].filter((f) => !found.has(f)).sort(),
  unexpected: [...found].filter((f) => !(f in frozen)).sort(),
})

describe('V4-PICKERGATE-001 — event-type surface freeze', () => {
  it('the set of files naming SELECTABLE_EVENT_TYPES is exactly the frozen set', () => {
    // A new file here is a new surface. If it is a creation picker it must appear in
    // CREATION_SURFACES too (asserted below) — that is the pairing that catches the sixth site.
    expect(diff(scan().selectable, SELECTABLE_CONSUMERS)).toEqual({ missing: [], unexpected: [] })
  })

  it('the set of files calling creatableEventTypes is exactly the frozen set', () => {
    // `missing` is the regression direction: a surface that DROPS its call goes back to offering
    // types it cannot submit. The per-surface render tests catch that behaviourally; this catches
    // it by name, in one line, without a DOM.
    expect(diff(scan().creatable, CREATION_SURFACES)).toEqual({ missing: [], unexpected: [] })
  })

  it('every frozen creation surface actually calls the gate', () => {
    const { creatable } = scan()
    for (const f of Object.keys(CREATION_SURFACES)) expect(creatable.has(f)).toBe(true)
  })

  it('no file is BOTH a read filter and a creation surface', () => {
    // The two roles want opposite lists. A file doing both would have to be split before either
    // claim could be true of it — and FeedPage acquiring a creatableEventTypes call is precisely
    // the "narrowed the read filter" mistake, arriving by a different door.
    const { creatable } = scan()
    for (const [f, { role }] of Object.entries(SELECTABLE_CONSUMERS)) {
      if (role === 'read') expect(creatable.has(f), `${f} is a read filter and must not gate`).toBe(false)
    }
  })
})
