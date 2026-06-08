import { describe, it, expect } from 'vitest'
import { buildTodayItems, todayBand, TODAY_RENDER_CAP } from '../lib/todayBand.js'

const iso = (ms) => new Date(Date.now() + ms).toISOString()
const daysAgo = (d) => iso(-d * 86400000)

describe('buildTodayItems', () => {
  it('returns [] for empty / null / array / partial payloads (never throws)', () => {
    expect(buildTodayItems(null)).toEqual([])
    expect(buildTodayItems({})).toEqual([])
    expect(buildTodayItems([])).toEqual([]) // array payload (test/error shape) is safe
    expect(buildTodayItems({ water_due: [], harvest_ready: [], heads_up: [] })).toEqual([])
  })

  it('maps each source to its reason-label + correct /log route', () => {
    const items = buildTodayItems({
      water_due: [{ project_id: 'w', project_name: 'Tomatoes', next_water_at: daysAgo(2), location_type: 'bed' }],
      heads_up: [
        { project_id: 'f', name: 'Squash', reason: 'flagged', severity: 3 },
        { project_id: 's', name: 'Kale', reason: 'stale', days_stale: 30 },
      ],
    })
    const byKind = Object.fromEntries(items.map(i => [i.kind, i]))
    expect(byKind.water.label).toBe('Needs water')
    expect(byKind.water.to).toBe('/log?project=w&event_type=watering')
    expect(byKind.flag.label).toBe('Needs a look')
    expect(byKind.flag.to).toBe('/log?project=f&event_type=observation')
    expect(byKind.stale.label).toBe('Not seen lately')
    expect(byKind.stale.to).toBe('/log?project=s&event_type=observation')
  })

  // V3-HARVEST-001: harvest-ready is no longer merged into the above-nav band.
  it('does NOT surface a harvest item even when harvest_ready is present (V3-HARVEST-001)', () => {
    const items = buildTodayItems({
      harvest_ready: [{ project_id: 'h', name: 'Beans', days_since_obs: 5 }],
    })
    expect(items).toEqual([])
    expect(items.some(i => i.kind === 'harvest')).toBe(false)
  })

  it('ranks watering > flagged > stale (harvest excluded per V3-HARVEST-001)', () => {
    const items = buildTodayItems({
      water_due: [{ project_id: 'w', project_name: 'W', next_water_at: daysAgo(1), location_type: 'bed' }],
      harvest_ready: [{ project_id: 'h', name: 'H', days_since_obs: 2 }],
      heads_up: [
        { project_id: 'f', name: 'F', reason: 'flagged', severity: 2 },
        { project_id: 's', name: 'S', reason: 'stale', days_stale: 40 },
      ],
    })
    expect(items.map(i => i.kind)).toEqual(['water', 'flag', 'stale'])
  })

  it('de-dups a project to its single most-urgent reason', () => {
    const items = buildTodayItems({
      water_due: [{ project_id: 'x', project_name: 'X', next_water_at: daysAgo(1), location_type: 'bed' }],
      heads_up: [{ project_id: 'x', name: 'X', reason: 'stale', days_stale: 5 }],
    })
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('water')
  })

  it('orders most-overdue watering first', () => {
    const items = buildTodayItems({
      water_due: [
        { project_id: 'a', project_name: 'A', next_water_at: daysAgo(1), location_type: 'bed' },
        { project_id: 'b', project_name: 'B', next_water_at: daysAgo(5), location_type: 'bed' },
      ],
    })
    expect(items.map(i => i.projectId)).toEqual(['b', 'a'])
  })

  it('skips rows without a project_id', () => {
    const items = buildTodayItems({ water_due: [{ project_name: 'no id', next_water_at: daysAgo(1) }] })
    expect(items).toEqual([])
  })

  it('falls back to row.name when project_name is absent', () => {
    const items = buildTodayItems({ heads_up: [{ project_id: 'h', name: 'Carrots', reason: 'stale', days_stale: 4 }] })
    expect(items[0].projectName).toBe('Carrots')
    expect(items[0].detail).toBe('4 days unseen')
  })
})

describe('todayBand cap', () => {
  it('renders at most TODAY_RENDER_CAP and reports the remainder', () => {
    const heads_up = Array.from({ length: 8 }, (_, i) => ({ project_id: 'p' + i, name: 'P' + i, reason: 'stale', days_stale: i + 1 }))
    const band = todayBand({ heads_up })
    expect(band.total).toBe(8)
    expect(band.visible).toHaveLength(TODAY_RENDER_CAP)
    expect(band.more).toBe(8 - TODAY_RENDER_CAP)
  })

  it('no overflow when at or under cap', () => {
    const band = todayBand({ heads_up: [{ project_id: 'a', name: 'A', reason: 'stale', days_stale: 1 }] })
    expect(band.visible).toHaveLength(1)
    expect(band.more).toBe(0)
  })
})
