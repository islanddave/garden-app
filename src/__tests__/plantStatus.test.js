// Lane D / Phase B+C slice 1 (§3.1 EVENT_ICONS fold + §3.2 PLANT_STATUS_MAP).
// Guards: plant-status registry completeness + humanizer + the gold-fallthrough
// fix; plus EVENT_TYPE_META emoji-completeness (the canonical icon source the
// 4 page EVENT_ICONS copies were folded into).
import { describe, it, expect } from 'vitest'
import { PLANT_STATUSES, PLANT_STATUS_MAP, statusLabel, PROJECT_STATUS_MAP } from '../lib/constants.js'
import { getStatusColors, STATUS_COLORS } from '../lib/status.js'
import { EVENT_TYPE_META, EVENT_TYPES } from '../lib/eventTypes.js'

describe('§3.2 plant-status registry', () => {
  it('every PLANT_STATUS has a label + emoji', () => {
    for (const s of PLANT_STATUSES) {
      expect(PLANT_STATUS_MAP[s]).toBeDefined()
      expect(PLANT_STATUS_MAP[s].label).toBeTruthy()
      expect(PLANT_STATUS_MAP[s].emoji).toBeTruthy()
    }
  })
  it('statusLabel humanizes plant + project statuses and passes through unknown un-snaked', () => {
    expect(statusLabel('seedling')).toBe('Seedling')
    expect(statusLabel('planning')).toBe(PROJECT_STATUS_MAP.planning.label)
    expect(statusLabel('some_unknown_status')).toBe('some_unknown_status')
  })
  it('early/dormant/failed plant statuses no longer fall through to planning gold', () => {
    const gold = STATUS_COLORS.planning
    for (const s of ['seed', 'seedling', 'vegetative', 'dormant', 'failed']) {
      expect(STATUS_COLORS[s]).toBeDefined()
      expect(getStatusColors(s)).not.toBe(gold)
    }
  })
})

describe('§3.1 EVENT_ICONS fold', () => {
  it('EVENT_TYPE_META supplies an emoji for every EVENT_TYPE (the canonical icon source)', () => {
    for (const t of EVENT_TYPES) {
      expect(EVENT_TYPE_META[t]).toBeDefined()
      expect(EVENT_TYPE_META[t].emoji).toBeTruthy()
    }
  })
})
