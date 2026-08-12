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
  'components/ZoomableImage.jsx':      { registered: true },
  'components/SpaceAttachPicker.jsx':  { registered: true, busy: 'saving' },
  'components/FacebookShareSheet.jsx': { registered: true, busy: 'posting — non-idempotent' },
  'components/CritterFactsPopover.jsx':{ registered: true },
  'components/LoveMehPopover.jsx':     { registered: true },
  'components/VarietyPicker.jsx':      { registered: true, busy: 'creating' },
  'pages/Dashboard.jsx':               { registered: true },
  'pages/PhotoLibrary.jsx':            { registered: true, busy: 'tagging' },
}

// <Sheet render sites. App.jsx is OverlayHost (the route-overlay host), not a page-level sheet.
// V4-HARVESTVIEW-001 S4: HarvestTimeframeChips.jsx is a DELIBERATE addition — the season chip opens
// a grow-year sheet, and the chip row was extracted out of Harvests.jsx (which keeps its own crop /
// project picker sheets, so it stays listed). It renders the shared <Sheet>, which is the registered
// role="dialog" surface, so no new registry entry is owed — the dismiss behavior is Sheet's.
const SHEET_SITES = [
  'App.jsx',
  'components/BottomNav.jsx',
  'components/HarvestTimeframeChips.jsx',
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

  // BIDIRECTIONAL, and it has to be. The first cut only checked that registered:true surfaces DO
  // import the registry, so when Slice 2 registered all seven remaining dialogs the frozen list
  // still claimed 7 were pending and the suite stayed GREEN on a stale list — the freeze test
  // drifting is precisely the failure a freeze test exists to prevent.
  it('a surface marked NOT registered must genuinely not use the registry', () => {
    for (const [file, meta] of Object.entries(DIALOG_SURFACES)) {
      if (meta.registered) continue
      const src = readFileSync(join(SRC, file), 'utf8')
      expect(src, `${file} is marked unregistered but DOES use useDismissable — update the frozen list`)
        .not.toMatch(/useDismissable/)
    }
  })

  it('records how many modal surfaces remain UNARBITRATED — a countdown that must never rise', () => {
    const pending = Object.entries(DIALOG_SURFACES).filter(([, m]) => !m.registered).map(([f]) => f)
    // Slice 2 took this from 7 to 0: every role="dialog" surface in the app now resolves through
    // one registry, so Escape (and Back, where wired) closes exactly one surface — the topmost.
    // PhotoLibrary's PhotoModal — which had NO dialog contract at all and was therefore invisible
    // to this scan — was given one in the same push, so the scan now sees every modal in the app.
    expect(pending).toHaveLength(0)
  })

  // PHOTOMODAL_GAP — CLOSED. PhotoModal was a fixed full-viewport overlay with no role, no
  // aria-modal, no Escape and no focus restore: not a dialog by any machine-checkable definition,
  // which is exactly why it had to be tracked by hand instead of by this scan. Now that it declares
  // the contract, the scan sees it, and this assertion keeps it declared.
  it('PhotoModal declares the dialog contract (was the one modal this scan could not see)', () => {
    const src = codeOf(readFileSync(join(SRC, 'pages/PhotoLibrary.jsx'), 'utf8'))
    expect(src).toMatch(/role=["']dialog["']/)
    expect(src).toMatch(/aria-modal/)
  })
})
