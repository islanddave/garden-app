// BUG-HARVESTTIMEOUT-001 — the constant is only right relative to the server's own limit, so it is
// pinned against the manifest the deploy reads rather than against a number repeated here.
import { describe, it, expect } from 'vitest'
import { HARVEST_WRITE_TIMEOUT_MS } from '../lib/harvestWriteTimeout.js'
import { API_TIMEOUT_MS } from '../lib/api.js'
import expected from '../../scripts/lambda-config-expected.json'

describe('HARVEST_WRITE_TIMEOUT_MS', () => {
  it('is longer than the events Lambda is allowed to run', () => {
    expect(HARVEST_WRITE_TIMEOUT_MS).toBeGreaterThan(expected['garden-events'].timeout * 1000)
  })

  it('leaves the global default where it was', () => {
    expect(API_TIMEOUT_MS).toBe(15000)
  })
})
