// V4-READYTRAYIMPRESSION-001 — the client half of the weigh-in tray's impression beacon.
//
// buildReadyImpressions is where the two claims that make this data worth having are constructed:
// WHAT WAS ON THE SCREEN (region, from selectTrayChips' actual output rather than a re-derived cap)
// and WHO PUT IT THERE (source: the readiness model vs the recency fallback — recon §7c's blocking
// prerequisite). Both are asserted against the REAL selectTrayChips below, not a stand-in, because
// a region label derived from a second copy of the collapse rule is the exact class of bug the
// server-side watch mirror has to carry a lockstep test for.
//
// sendReadyImpressions' contract is one line long and outranks everything else: it cannot reject.

import { describe, it, expect, vi } from 'vitest'
import { buildReadyImpressions, sendReadyImpressions, READY_IMPRESSIONS_PATH, READY_MODEL_VERSION } from '../lib/readyImpressions.js'
import { selectTrayChips, HARVEST_TRAY_COLLAPSED_MAX } from '../lib/harvestTray.js'

const readyChip = (i) => ({
  plant_id: `p${i}`, project_id: 'proj-1', name: `Planting ${i}`, source: 'ready',
  overdue_ratio: 2 - i / 100, days_since_last_harvest: 8, repeat_interval_days: 4,
})
const recentChip = (i) => ({ plant_id: `r${i}`, project_id: 'proj-1', name: `Recent ${i}`, source: 'recent' })

describe('buildReadyImpressions — what was shown, and who surfaced it', () => {
  it('labels the collapsed chips tray and the rest tray_tail, slots 1-based WITHIN each region', () => {
    const chips = Array.from({ length: 14 }, (_, i) => readyChip(i + 1))
    const visible = selectTrayChips({ chips }).map((c) => c.plant_id)
    const rows = buildReadyImpressions(chips, visible)

    expect(visible).toHaveLength(HARVEST_TRAY_COLLAPSED_MAX)
    expect(rows).toHaveLength(14)
    expect(rows.filter((r) => r.region === 'tray').map((r) => r.slot)).toEqual([1, 2, 3, 4, 5, 6])
    expect(rows.filter((r) => r.region === 'tray_tail').map((r) => r.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // Rank order is preserved end to end — the tray order IS the model's ranking.
    expect(rows.map((r) => r.plant_id)).toEqual(chips.map((c) => c.plant_id))
  })

  it('a tray under the collapse cap is entirely region=tray', () => {
    const chips = [readyChip(1), readyChip(2), recentChip(1)]
    const rows = buildReadyImpressions(chips, selectTrayChips({ chips }).map((c) => c.plant_id))
    expect(rows.map((r) => r.region)).toEqual(['tray', 'tray', 'tray'])
    expect(rows.map((r) => r.slot)).toEqual([1, 2, 3])
  })

  // RECON §7c, the prerequisite. MUTATION TARGET: drop the source flag from the merge in
  // EventNew.jsx and every row here becomes 'recent' — a precision claim about the readiness model
  // would then be computed over a population the model never selected.
  it('carries provenance and freezes the model claim on ready rows only', () => {
    const rows = buildReadyImpressions([readyChip(1), recentChip(1)], ['p1', 'r1'])
    expect(rows[0]).toEqual({
      plant_id: 'p1', slot: 1, region: 'tray', source: 'ready',
      overdue_ratio: 1.99, days_since_last_harvest: 8, repeat_interval_days: 4,
    })
    expect(rows[1]).toEqual({
      plant_id: 'r1', slot: 2, region: 'tray', source: 'recent',
      overdue_ratio: null, days_since_last_harvest: null, repeat_interval_days: null,
    })
  })

  it('drops a ready row whose rank coordinate did not survive rather than relabelling it recent', () => {
    const rows = buildReadyImpressions([{ ...readyChip(1), overdue_ratio: undefined }, recentChip(1)], ['p1', 'r1'])
    expect(rows.map((r) => r.plant_id)).toEqual(['r1'])
  })

  it('dedupes a repeated plant_id — one card is one row, however often it appears in the merge', () => {
    const rows = buildReadyImpressions([readyChip(1), readyChip(1), readyChip(2)], ['p1', 'p2'])
    expect(rows.map((r) => r.plant_id)).toEqual(['p1', 'p2'])
  })

  it('treats an absent visible set as "nothing was on screen" rather than "everything was"', () => {
    const rows = buildReadyImpressions([readyChip(1), readyChip(2)], undefined)
    expect(rows.map((r) => r.region)).toEqual(['tray_tail', 'tray_tail'])
  })

  it.each([[null], [undefined], [[]], [[{}, { plant_id: '' }]]])('survives junk chips %s', (chips) => {
    expect(buildReadyImpressions(chips, [])).toEqual([])
  })
})

describe('sendReadyImpressions — a beacon that cannot reach the weigh-in', () => {
  it('posts the built rows with the model version, keepalive, to the routed path', async () => {
    const apiFetch = vi.fn(() => Promise.resolve({ accepted: 2 }))
    await sendReadyImpressions(apiFetch, [readyChip(1), recentChip(1)], ['p1'])

    expect(apiFetch).toHaveBeenCalledTimes(1)
    const [path, opts] = apiFetch.mock.calls[0]
    expect(path).toBe(READY_IMPRESSIONS_PATH)
    expect(opts.method).toBe('POST')
    // keepalive so a beacon issued as the tray settles survives the user tapping away mid-request —
    // the weigh-in flow is exactly where that happens.
    expect(opts.keepalive).toBe(true)
    const body = JSON.parse(opts.body)
    expect(body.model_version).toBe(READY_MODEL_VERSION)
    expect(body.impressions.map((r) => [r.plant_id, r.region])).toEqual([['p1', 'tray'], ['r1', 'tray_tail']])
  })

  // THE CONTRACT. MUTATION TARGET: remove the try/catch -> an unhandled rejection escapes into the
  // effect that renders the tray.
  it.each([
    ['a rejecting transport', () => Promise.reject(new Error('500'))],
    ['a synchronously throwing transport', () => { throw new Error('boom') }],
    ['no transport at all', undefined],
  ])('never rejects: %s', async (_label, apiFetch) => {
    await expect(sendReadyImpressions(apiFetch, [readyChip(1)], ['p1'])).resolves.toBeUndefined()
  })

  it('sends nothing at all when there is nothing to record', async () => {
    const apiFetch = vi.fn(() => Promise.resolve(null))
    await sendReadyImpressions(apiFetch, [], [])
    await sendReadyImpressions(apiFetch, null, null)
    expect(apiFetch).not.toHaveBeenCalled()
  })
})
