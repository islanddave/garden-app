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
// V4-HARVEXPORT-001 S5: HarvestExportSheet.jsx is likewise deliberate — the Export affordance on the
// Harvests page opens a fly-up, and it nests HarvestTimeframeChips' grow-year sheet inside itself
// (Sheet's openStack + topmost-Escape arbitration are built for exactly that stacking).
// DD9 / W-EVTDEL: components/photo/EventDeleteConfirm.jsx is a DELIBERATE addition — the
// event-delete confirm has to hold an opt-in "Also delete the photo" checkbox, and window.confirm
// cannot, which is the entire reason it became a component. It renders the shared <Sheet>, which IS
// the registered role="dialog" surface, so no new DIALOG_SURFACES entry is owed — the dismiss
// behaviour is Sheet's, and the component deliberately adds no dialog chrome of its own.
// V4-PHOTOREASSIGN-001 / W-PHOTODEL: components/photo/PhotoDeleteConfirm.jsx is the same deliberate
// shape, one surface over — the STANDALONE photo delete needed a confirm that can disclose the
// cover-photo consequence and the recovery path, which window.confirm cannot hold. It composes the
// shared <Sheet> (so the dismiss behaviour is Sheet's, and no DIALOG_SURFACES entry is owed) and
// deliberately reuses EventDeleteConfirm's grammar rather than minting a second confirm dialect.
// Note PhotoLibrary.jsx stays in DIALOG_SURFACES for its own PhotoModal overlay, unrelated to this.
// V4-OVERWINTERCARE-001: components/planting/OverwinterPrompt.jsx is a DELIBERATE addition, and the
// same shape as TransplantDatePrompt.jsx directly below it — a chrome-less tappable row on the
// planting page that opens the shared <Sheet> to pick one of four overwintering regimes. It renders
// <Sheet armsBack>, so the registered role="dialog" surface is Sheet's and no DIALOG_SURFACES entry
// is owed; `busy={saving}` is passed so the write in flight blocks dismissal.
// V4-LOSSUI-001: components/EndStatusOffer.jsx is a DELIBERATE addition, the same shape as
// OverwinterPrompt above it. When a plant-reduction empties a planting the events Lambda returns a
// RANKED end-status offer, and the user must be able to pick one, decline, or walk away — a choice
// window.confirm cannot hold and a toast cannot either. It renders the shared <Sheet armsBack>, so
// the registered role="dialog" surface is Sheet's and no DIALOG_SURFACES entry is owed;
// `busy={applying}` blocks dismissal while the status PUT is in flight. armsBack is load-bearing
// rather than decorative here: declining is the DEFAULT outcome and Dave's device is Chrome on
// Android, where Back is the decline gesture he will actually reach for.
// V4-BATCHUNDO-001: components/BatchUndoConfirm.jsx is a DELIBERATE addition, the same shape as
// PhotoDeleteConfirm. The durable batch undo removes up to 157 event rows in one irreversible
// transaction, so it needs a confirm that can state the exact count and disclose that nothing
// restores it — neither fits in window.confirm. It renders the shared <Sheet armsBack>, so the
// registered role="dialog" surface is Sheet's and no DIALOG_SURFACES entry is owed; `busy` blocks
// dismissal while the DELETE is in flight. armsBack is load-bearing, not decorative: backing out is
// the outcome this sheet exists to make easy, and Back is that gesture on Chrome/Android.
// V4-OVERLAYSLICE3-001 (BD-043): pages/Garden.jsx is a DELIBERATE addition — slice 3, the last
// in-DOM inline form. V4-OVERLAY-001's own note recorded that "only slice 3 add-planting remains",
// and Dave re-raised it unprompted: Add Planting was a form sitting at the TOP OF THE GARDEN TAB,
// part of the underlying tab rather than a flyover over it. It wraps the very same PlantingEditor
// that pages/PlantingDetail.jsx already wraps for V4-EDITINPLACE-001, so this is one component
// reaching parity across its two hosts rather than a new modal dialect. It renders the shared
// <Sheet armsBack>, so the registered role="dialog" surface is Sheet's and no DIALOG_SURFACES entry
// is owed; `busy={editorBusy}` blocks dismissal while the POST/PUT is in flight, which is the
// V4-SHEETBUSY-001 lesson applied at mint time instead of after the fact.
const SHEET_SITES = [
  'App.jsx',
  'components/BatchUndoConfirm.jsx',
  'components/BottomNav.jsx',
  'components/EndStatusOffer.jsx',
  'components/HarvestExportSheet.jsx',
  'components/photo/EventDeleteConfirm.jsx',
  'components/photo/PhotoDeleteConfirm.jsx',
  'components/HarvestTimeframeChips.jsx',
  'components/planting/OverwinterPrompt.jsx',
  'components/planting/TransplantDatePrompt.jsx',
  'components/today/CareNeeded.jsx',
  'pages/AddSeeds.jsx',
  'pages/Garden.jsx',
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
