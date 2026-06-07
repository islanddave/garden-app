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
// THREE-WAY PARITY (added 2026-06-07, brave-intelligent-hawking / DRG-ENGINE-002 GATE-0):
// There are THREE byte-identical copies, not two: src/lib (client), lambda/critter (this dir),
// and lambda/events. The PRODUCTION critter-award write path (lambda/events/critterAward.js)
// imports lambda/events/critterSpecies.js — the copy that was previously UNGUARDED. A drift in
// the award-path copy would mis-resolve species_id on real awards with no test backstop and no
// DB FK (critter identity is a code constant pool). This test now asserts all THREE copies are
// identical so any drift in the award-path copy breaks CI. (Anchor for the future DRG entity
// registry's critter_species reference table: the registry materializes this pool to Neon and
// FKs to it; until then this 3-way guard is the only integrity check on the award-path pool.)
//
// If this test fails → a copy diverged → either fix the divergence or update the byte-identical
// contract intentionally across ALL THREE copies.

import { describe, it, expect } from 'vitest'
import * as client from '../../src/lib/critterSpecies.js'
import * as lambdaCp from './critterSpecies.js'
import * as lambdaEvents from '../events/critterSpecies.js'

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

// THREE-WAY: assert the lambda/events copy (the PRODUCTION award write-path import) is identical
// to the client. This is the previously-unguarded copy; lambda/events/critterAward.js depends on it.
describe('critterSpecies — award-path (lambda/events) ↔ client byte-identical parity', () => {
  it('SPECIES_POOL is identical (events copy)', () => {
    expect(lambdaEvents.SPECIES_POOL.length).toBe(client.SPECIES_POOL.length)
    for (let i = 0; i < client.SPECIES_POOL.length; i++) {
      expect(lambdaEvents.SPECIES_POOL[i]).toEqual(client.SPECIES_POOL[i])
    }
  })

  it('BASELINE_RESIDENTS + EARNED_POOL identical (events copy)', () => {
    expect(lambdaEvents.BASELINE_RESIDENTS).toEqual(client.BASELINE_RESIDENTS)
    expect(lambdaEvents.EARNED_POOL).toEqual(client.EARNED_POOL)
  })

  it('BY_ID identical (events copy)', () => {
    expect(lambdaEvents.BY_ID).toEqual(client.BY_ID)
  })

  it('SMOKE_SENTINEL_SPECIES_ID identical (events copy)', () => {
    expect(lambdaEvents.SMOKE_SENTINEL_SPECIES_ID).toBe(client.SMOKE_SENTINEL_SPECIES_ID)
  })

  it('pickSpecies output identical for 100 sampled (seed, prefs) tuples (events copy)', () => {
    let mismatches = 0
    for (let i = 0; i < 100; i++) {
      const seed = `parity-seed-${i}-${(i * 7919) % 65521}`
      const prefs = makePrefs(seed)
      const cClient = client.pickSpecies(seed, prefs)
      const cEvents = lambdaEvents.pickSpecies(seed, prefs)
      if (cClient !== cEvents) mismatches++
    }
    expect(mismatches).toBe(0)
  })

  it('pickCopyVariant output identical for 100 sampled (seed, poolSize) tuples (events copy)', () => {
    let mismatches = 0
    for (let i = 0; i < 100; i++) {
      const seed = `copy-parity-${i}-${(i * 4099) % 65521}`
      const poolSize = 5 + (i % 8)
      const cClient = client.pickCopyVariant(seed, poolSize)
      const cEvents = lambdaEvents.pickCopyVariant(seed, poolSize)
      if (cClient !== cEvents) mismatches++
    }
    expect(mismatches).toBe(0)
  })
})
