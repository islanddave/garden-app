// The scripted N-harvest run (measurement B).
//
// READ THIS BEFORE QUOTING A TAP NUMBER. A tap count is only as honest as the journey it scripts,
// so the journey is spelled out here rather than buried in a helper. Every step below is one
// physical finger action on one real control in the mounted component. Nothing is assumed, nothing
// is skipped as "the user would already have done that" — except the two things the harness
// genuinely cannot reach, which are listed in README.md §Limits and are NOT counted here:
//   • the taps to open the log surface in the first place (bottom-nav +, then "Log one")
//   • any scroll the real page needs that the harness's geometry happens not to
//
// PER-HARVEST JOURNEY (harvest #1 differs from #2..N only in its first step):
//   1. harvest #1 → tap the "Harvested" event-type tile.
//      harvest #2..N, overlay surface → tap "Log another" on the confirmation card.
//      harvest #2..N, full-page surface → nothing; the form is already reset with the type kept.
//   2. tap the planting combobox (opens the listbox; V4-PICKERKB-002 opens it keyboard-less)
//   3. tap the planting row
//   4. quantity:  'chip'   → tap one quick-pick chip                       (1 tap, no keypad)
//                 'keypad' → tap the quantity field, then type the digits  (1 tap + k keypresses)
//   5. tap Save
//   final, overlay surface only → tap "Close" on the last confirmation card.
//
// The unit select is NOT tapped: it is sticky per-user (readLastHarvestUnit) and unchanged between
// same-crop harvests, so scripting a unit change every round would inflate the count.
import { tap, typeInto, settle, waitFor, byText, saveButton, qtyChip, qtyInput, plantingInput, plantingChip, resetCounters, readCounters, noteScroll, qa } from './harnessApi.js'

const HARVEST_TILE_TEXT = 'Harvested'

async function openPlantingList() {
  tap(plantingInput(), { focus: true })
  await settle(6)
  return waitFor(() => document.querySelector('[role="listbox"]'), { label: 'planting listbox' })
}

async function pickPlanting(listbox, optionIndex) {
  const opts = Array.from(listbox.querySelectorAll('[role="option"]'))
  if (!opts.length) throw new Error('no planting options rendered')
  const idx = Math.min(optionIndex, opts.length - 1)
  const opt = opts[idx]
  // Count a scroll gesture honestly if the target row is not already in the listbox's visible band.
  const lb = listbox.getBoundingClientRect()
  const or_ = opt.getBoundingClientRect()
  if (or_.top < lb.top || or_.bottom > lb.bottom) {
    opt.scrollIntoView({ block: 'nearest' })
    noteScroll()
    await settle(6)
  }
  tap(opt)
  await settle(8)
  await waitFor(() => plantingChip(), { label: 'planting chip' })
}

export async function runHarvestScript({ n = 5, surface = 'overlay', quantityMode = 'chip', optionIndex = 0, chipValue = '2', typedQuantity = '3' } = {}) {
  const steps = []
  const t0 = performance.now()
  resetCounters()
  const mark = (label) => steps.push({ label, ...readCounters() })

  for (let i = 0; i < n; i++) {
    if (i === 0) {
      const tile = byText(HARVEST_TILE_TEXT)
      if (!tile) throw new Error('event-type tile "Harvested" not found')
      tap(tile)
      await settle(10)
      await waitFor(() => qtyInput(), { label: 'harvest panel' })
      mark(`h${i + 1}:type`)
    } else if (surface === 'overlay') {
      const again = byText('Log another')
      if (!again) throw new Error('"Log another" not found — expected the overlay confirmation card')
      tap(again)
      await settle(10)
      await waitFor(() => plantingInput(), { label: 'form back after Log another' })
      mark(`h${i + 1}:logAnother`)
    }

    const listbox = await openPlantingList()
    mark(`h${i + 1}:openPicker`)
    await pickPlanting(listbox, optionIndex)
    mark(`h${i + 1}:pickPlanting`)

    if (quantityMode === 'chip') {
      tap(qtyChip(chipValue))
      await settle(6)
    } else {
      tap(qtyInput(), { focus: true })
      await settle(6)
      typeInto(qtyInput(), typedQuantity)
      await settle(6)
    }
    mark(`h${i + 1}:quantity`)

    tap(saveButton())
    if (surface === 'overlay') {
      await waitFor(() => byText('Log another'), { label: 'confirmation card', timeout: 8000 })
    } else {
      await waitFor(() => qtyInput() && qtyInput().value === '' && !plantingChip(), { label: 'form reset after save', timeout: 8000 })
    }
    await settle(10)
    mark(`h${i + 1}:save`)
  }

  if (surface === 'overlay') {
    const close = byText('Close')
    if (close) { tap(close); await settle(6); mark('close') }
  }

  const c = readCounters()
  return {
    n, surface, quantityMode, optionIndex,
    taps: c.pointerdown,
    keypresses: c.keydown,
    scrollGestures: c.scroll,
    perHarvest: +(c.pointerdown / n).toFixed(2),
    elapsedMs: Math.round(performance.now() - t0),
    steps,
  }
}
