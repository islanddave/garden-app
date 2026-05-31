// Lambda-side ↔ client-side pickSpecies parity assertion.
// Canonical spec: revision §3.29 (bottom): "Lambda currently does NOT compute species_id
// (accepts client value); parity test is the safety net" — for the future tamper-detection.
//
// Strategy: byte-identical copy in lambda/critter/critterSpecies.js (mirrors the
// lambda/household.js byte-identical pattern per L-089). This test asserts:
//   (1) pickSpecies output equality for 100 sampled (seed, prefs) tuples
//   (2) pickCopyVariant output equality for 100 sampled (seed, poolSize) tuples
//   (3) SPECIES_POOL byte-equality (sprite filenames, weights, tiers)
//   (4) BASELINE_RESIDENTS + EARNED_POOL identity
//   (5) BY_ID identity
//
// If this test fails → client and Lambda diverged → either fix the divergence or
// update the byte-identical contract intentionally.

import { describe, it, expect } from 'vitest'
import * as client from '../../src/lib/critterSpecies.js'
import * as lambdaCp from './critterSpecies.js'

function makePrefs(seed) {
  // Deterministic varied prefs object from seed.
  const prefs = {}
  for (let i = 3; i <= 8; i++) {
    const h = (seed.charCodeAt(0) * 31 + i * 17) % 7
    if (h === 0) prefs[i] = 0.5
    else if (h === 1) prefs[i] = 2.0
    // else leave default (no entry = weight 1.0)
  }
  return prefs
}

describe('critterSpecies — client ↔ Lambda byte-identical parity', () => {
  it('SPECIES_POOL is identical', () => {
    expect(lambdaCp.SPECIES_POOL.length).toBe(client.SPECIES_POOL.length)
    for (let i = 0; i < client.SPECIES_POOL.length; i++) {
      expect(lambdaCp.SPECIES_POOL[i]).toEqual(client.SPECIES_POOL[i])
    }
  })

  it('BASELINE_RESIDENTS + EARNED_POOL identical', () => {
    expect(lambdaCp.BASELINE_RESIDENTS).toEqual(client.BASELINE_RESIDENTS)
    expect(lambdaCp.EARNED_POOL).toEqual(client.EARNED_POOL)
  })

  it('BY_ID identical', () => {
    expect(lambdaCp.BY_ID).toEqual(client.BY_ID)
  })

  it('SMOKE_SENTINEL_SPECIES_ID identical', () => {
    expect(lambdaCp.SMOKE_SENTINEL_SPECIES_ID).toBe(client.SMOKE_SENTINEL_SPECIES_ID)
  })

  it('pickSpecies output identical for 100 sampled (seed, prefs) tuples', () => {
    let mismatches = 0
    for (let i = 0; i < 100; i++) {
      const seed = `parity-seed-${i}-${(i * 7919) % 65521}`
      const prefs = makePrefs(seed)
      const cClient = client.pickSpecies(seed, prefs)
      const cLambda = lambdaCp.pickSpecies(seed, prefs)
      if (cClient !== cLambda) mismatches++
    }
    expect(mismatches).toBe(0)
  })

  it('pickCopyVariant output identical for 100 sampled (seed, poolSize) tuples', () => {
    let mismatches = 0
    for (let i = 0; i < 100; i++) {
      const seed = `copy-parity-${i}-${(i * 4099) % 65521}`
      const poolSize = 5 + (i % 8) // pool sizes 5..12
      const cClient = client.pickCopyVariant(seed, poolSize)
      const cLambda = lambdaCp.pickCopyVariant(seed, poolSize)
      if (cClient !== cLambda) mismatches++
    }
    expect(mismatches).toBe(0)
  })

  it('pickSpecies deterministic (same inputs → same output) on both sides', () => {
    const seed = 'determinism-check-seed'
    const prefs = { 3: 2.0, 6: 0.5 }
    const r1 = client.pickSpecies(seed, prefs)
    const r2 = client.pickSpecies(seed, prefs)
    const r3 = lambdaCp.pickSpecies(seed, prefs)
    expect(r1).toBe(r2)
    expect(r1).toBe(r3)
  })
})
