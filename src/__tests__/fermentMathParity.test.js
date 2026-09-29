// Put-Up release F — the client mirrors in src/components/putup/fermentMath.js bound to the Lambda's own
// modules (lambda/preservation/kitchenBatch.js's F constants and saltMath.js, lane L2b). The app has
// shipped one bug where two hand-maintained copies of one vocabulary disagreed; this is the binding.
//
// ⚠ UNTIL L2b's MODULES ARE ON THIS BRANCH the comparing arms are SKIPPED — reported as skipped by the
// runner, never passed. The presence arm below says which state the branch is in, so a merge that
// brings the modules in turns every comparing arm on with no edit here. The golden-table pins in
// fermentMath.test.js hold meanwhile: both lanes pin the same literals independently.
import { describe, it, expect } from 'vitest'
import * as client from '../components/putup/fermentMath.js'

const kb = Object.values(import.meta.glob('../../lambda/preservation/kitchenBatch.js', { eager: true }))[0] ?? {}
const salt = Object.values(import.meta.glob('../../lambda/preservation/saltMath.js', { eager: true }))[0] ?? null
const HAVE_F = !!kb.MASS_G && !!salt

describe('the F lambda modules on this branch', () => {
  it(`are ${HAVE_F ? 'present — the parity arms below run' : 'NOT present yet (L2b unmerged) — the parity arms below are skipped'}`, () => {
    expect(typeof kb.parseKitchenRoute).toBe('function')     // green control: the glob does reach the Lambda
    expect(HAVE_F).toBe(!!kb.MASS_G && !!salt)
  })
})

describe.skipIf(!HAVE_F)('fermentMath mirrors the Lambda', () => {
  it('the unit tables and vocabularies are the same', () => {
    expect(client.MASS_G).toEqual(kb.MASS_G)
    expect(client.WATER_G).toEqual(kb.WATER_G)
    expect([...client.KITCHEN_UNITS]).toEqual([...kb.KITCHEN_UNITS])
    expect([...client.KITCHEN_FORMS]).toEqual([...kb.KITCHEN_FORMS])
    expect([...client.SALT_METHODS]).toEqual([...kb.KITCHEN_SALT_METHODS])
    expect([...client.SALT_BASES].sort()).toEqual([...kb.KITCHEN_SALT_BASES].sort())
    expect([...client.ACTS]).toEqual([...kb.KITCHEN_ACTS])
  })

  it('the salt base agrees on every base over a mixed batch', () => {
    const lines = [
      { label: 'jalapeño', qty: '170', qty_unit: 'g' }, { label: 'Water', qty: '1', qty_unit: 'qt', role: 'water' },
      { label: 'vinegar', qty: '30', qty_unit: 'ml' }, { label: 'reaper', qty: '0.5', qty_unit: 'oz' },
      { label: 'Salt', qty: '15', qty_unit: 'g', role: 'salt' }, { label: 'sitting', qty: '9', qty_unit: 'g', put_up_stage_id: 'x' },
    ]
    for (const base of ['produce', 'water', 'all']) expect(client.saltBase(lines, base)).toEqual(salt.saltBase(lines, base))
    expect(client.oneDecimal(15.68)).toBe(salt.oneDecimal(15.68))
    expect(client.saltGrams(3.5, 448)).toBe(salt.saltGrams(3.5, 448))
    expect(client.actualPct(13.5, 448)).toBe(salt.actualPct(13.5, 448))
  })
})
