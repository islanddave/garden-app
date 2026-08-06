// V4-BACKNAV-001 — freeze the SET of modal surfaces (decision V200 §8).
//
// WHY A STATIC SOURCE SCAN AND NOT A RUNTIME TEST. A runtime registry test cannot catch this class:
// a new modal that forgets to register produces NOTHING to enumerate, so there is no failing
// assertion to write. The absence is the bug. Only a filesystem scan of the source can see it.
//
// WHY AN EXACT-SET DIFF AND NOT A COUNT. App.routes.test.jsx pins a route COUNT, and its own header
// records how that bit: the count silently doubled as a feature-flag pin until it had to be split.
// A count also tells you THAT something drifted but not WHICH. This reports {missing, unexpected},
// following the formsPrimitivesFreeze / noBareViewUrlImg.static idiom.
//
// This is the test that would have caught the gap the whole back-nav crucible tripped over: both
// the spec AND the brief hand-listed the modal surfaces, and both were wrong — in opposite
// directions, three times over. Do not hand-maintain this list from memory; run the scan.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Same resolution as noBareViewUrlImg.static.test.js — vitest runs with cwd at the package root.
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

// Comment lines must be excluded first: this codebase documents heavily, and several files
// (including the registry's own source) DISCUSS role="dialog" in prose. Scanning raw text flags
// every file that merely MENTIONS a modal — a false positive that trains people to pad the frozen
// list, which is exactly how a freeze test stops meaning anything.
//
// Done LINE-WISE, not with a /* */ regex: a block-comment stripper silently swallowed real code
// here (an unbalanced pair inside App.jsx ate the OverlayHost <Sheet> render site), which is the
// worse failure — a scanner that under-reports makes the freeze test pass while blind.
const isCommentLine = (line) => {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')
}
const codeOf = (src) => src.split('\n').filter((l) => !isCommentLine(l)).join('\n')

// Every file declaring a modal surface: a role="dialog" element, or a <Sheet render site.
function scan() {
  const dialogs = new Set()
  const sheets = new Set()
  for (const f of walk(SRC)) {
    const src = codeOf(readFileSync(f, 'utf8'))
    if (/role=["']dialog["']/.test(src)) dialogs.add(rel(f))
    if (/<Sheet[\s>]/.test(src)) sheets.add(rel(f))
  }
  return { dialogs, sheets }
}

// ── The frozen sets. Adding a surface here is a DELIBERATE act that should come with either a
//    registry call (useDismissable) or an explicit reason it is exempt. ────────────────────────

// role="dialog" surfaces. `registered: true` = joins the shared DismissRegistry today.
const DIALOG_SURFACES = {
  'components/forms/Sheet.jsx':        { registered: true },
  'components/Lightbox.jsx':           { registered: true },
  // Not yet registered — Slice 2. Each still binds (or lacks) its own Escape handler, so Back and
  // Escape are not yet arbitrated for these. Listed so the gap is COUNTED rather than forgotten.
  'components/ZoomableImage.jsx':      { registered: false, note: 'own embedded lightbox; own Escape' },
  'components/SpaceAttachPicker.jsx':  { registered: false, note: 'suppresses Escape while saving (a third "blocking" state)' },
  'components/FacebookShareSheet.jsx': { registered: false, note: 'closable=!posting; the one surface with a non-idempotent in-flight action' },
  'components/CritterFactsPopover.jsx':{ registered: false, note: 'ungated document keydown — double-fires with a Sheet' },
  'components/LoveMehPopover.jsx':     { registered: false },
  'components/VarietyPicker.jsx':      { registered: false, note: 'conflict modal; Escape steps BACK through create-stages rather than closing' },
  'pages/Dashboard.jsx':               { registered: false, note: 'StreakModal — z1000 and NO Escape handler at all' },
}

// <Sheet render sites. App.jsx is OverlayHost (the route-overlay host), not a page-level sheet.
const SHEET_SITES = [
  'App.jsx',
  'components/BottomNav.jsx',
  'components/planting/TransplantDatePrompt.jsx',
  'components/today/CareNeeded.jsx',
  'pages/AddSeeds.jsx',
  'pages/Harvests.jsx',
  'pages/PlantingDetail.jsx',
  'pages/SowNow.jsx',
]

function diff(found, frozen) {
  const f = new Set(found), z = new Set(frozen)
  return {
    missing: [...z].filter(x => !f.has(x)).sort(),      // frozen but no longer in source
    unexpected: [...f].filter(x => !z.has(x)).sort(),   // in source but not frozen — the real catch
  }
}

describe('modal surface freeze', () => {
  it('SELF-TEST: the scanners match real source (else every assertion below is vacuous)', () => {
    const { dialogs, sheets } = scan()
    expect(dialogs.has('components/forms/Sheet.jsx')).toBe(true)
    expect(sheets.has('components/BottomNav.jsx')).toBe(true)
    // And they must be able to MISS something: a file with neither marker is not in either set.
    expect(dialogs.has('lib/dismissLayers.js')).toBe(false)
  })

  it('the set of role="dialog" surfaces is unchanged', () => {
    const { dialogs } = scan()
    expect(diff(dialogs, Object.keys(DIALOG_SURFACES))).toEqual({ missing: [], unexpected: [] })
  })

  it('the set of <Sheet> render sites is unchanged', () => {
    const { sheets } = scan()
    expect(diff(sheets, SHEET_SITES)).toEqual({ missing: [], unexpected: [] })
  })

  // A new modal that skips the registry is the exact regression this file exists to prevent. When
  // this fails, the fix is to call useDismissable in the new surface — not to add it to the frozen
  // list with registered:false, unless there is a stated reason it cannot join.
  it('every surface claiming registration actually imports the registry', () => {
    for (const [file, meta] of Object.entries(DIALOG_SURFACES)) {
      if (!meta.registered) continue
      const src = readFileSync(join(SRC, file), 'utf8')
      expect(src, `${file} is marked registered but does not use useDismissable`)
        .toMatch(/useDismissable/)
    }
  })

  it('records how many modal surfaces remain UNARBITRATED (the Slice 2 backlog)', () => {
    const pending = Object.entries(DIALOG_SURFACES).filter(([, m]) => !m.registered).map(([f]) => f)
    // Not an aspiration — a countdown. Lower this number as Slice 2 lands; it must never rise
    // without a new frozen entry explaining why.
    expect(pending).toHaveLength(7)
  })
})
