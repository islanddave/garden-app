// Lambda validator <-> client wire check parity for today_sections. V5-TODAYREDESIGN-001 S7.
//
// WHY TWO COPIES. The Lambda refuses a bad body at write time, WHOLE. The client checks each dirty entry before
// it goes on the wire (src/lib/todayV2/sectionsWire.js), so one entry the server would refuse never holds every
// good one back at every visit start. Neither side can serve the other: the Lambda cannot import from src/.
// Same house pattern as navcustom.parity.test.js.
//
// IF THIS FAILS, a copy diverged. An entry the client sends but the Lambda refuses is a section whose taps never
// leave the device (and, batched, take the others with them); one the Lambda takes but the client withholds is a
// tap that stays on this phone for no reason. Fix the divergence, or change the contract on BOTH sides in one
// release.
import { describe, it, expect } from 'vitest'
import {
  validatePrefsPatchBody, todaySectionKeyOk, TODAY_SECTION_KEYS, TODAY_SECTION_HH_RE, TODAY_SECTION_ACK_TIERS,
  TODAY_SECTION_ACK_REASONS, TODAY_SECTIONS_MAX_KEYS, TODAY_SECTIONS_MAX_CHARS, TODAY_SECTIONS_VERSION,
} from './validators.js'
import {
  wireOk, wireKeyOk, SECTION_KEYS, HH_KEY_RE, ACK_TIERS, ACK_REASONS, MAX_KEYS, MAX_CHARS, VERSION,
} from '../../src/lib/todayV2/sectionsWire.js'
import { TIER_RANK, CARE_REASONS, HEADSUP_REASONS } from '../../src/lib/todayV2/triggers.js'
import { householdKey } from '../../src/components/today/v2/HouseholdSection.jsx'

const serverAccepts = (today_sections) => validatePrefsPatchBody({ today_sections }) === null
const D = '2026-10-14'

describe('today_sections — one contract, two copies', () => {
  it('the constants agree', () => {
    expect(SECTION_KEYS).toEqual(TODAY_SECTION_KEYS)
    expect(HH_KEY_RE.source).toBe(TODAY_SECTION_HH_RE.source)
    expect(HH_KEY_RE.flags).toBe(TODAY_SECTION_HH_RE.flags)
    expect(ACK_TIERS).toEqual(TODAY_SECTION_ACK_TIERS)
    expect(ACK_REASONS).toEqual(TODAY_SECTION_ACK_REASONS)
    expect(MAX_KEYS).toBe(TODAY_SECTIONS_MAX_KEYS)
    expect(MAX_CHARS).toBe(TODAY_SECTIONS_MAX_CHARS)
    expect(VERSION).toBe(TODAY_SECTIONS_VERSION)
  })

  it('the ack vocabulary is what the trigger module records, so every ack a close can write is accepted', () => {
    expect(TODAY_SECTION_ACK_TIERS).toEqual(Object.keys(TIER_RANK))
    expect(TODAY_SECTION_ACK_REASONS).toEqual([...CARE_REASONS, ...HEADSUP_REASONS])
  })

  it('every household key the page can mint passes both', () => {
    for (const sub of ['user_2NNEqL2nrIRdJ194ndJqAHwEfxC', 'user_2abcdefgh', 'member_jen', 'u1', 'harness_user']) {
      const k = householdKey(sub)
      expect(todaySectionKeyOk(k), k).toBe(true)
      expect(wireKeyOk(k), k).toBe(true)
    }
  })

  it('both sides answer alike over one table of bodies', () => {
    const big = { v: 1 }
    for (let i = 0; i < 23; i++) big[`hh-${String(i).padStart(8, 'x')}`] = { open: false, at: D, ack: { t: 'hardfreeze', r: ['never', 'hot', 'small', 'window', 'deadline'] } }
    const tooMany = { v: 1 }
    for (let i = 0; i < 24; i++) tooMany[`hh-m${i}`] = { open: true, at: D }
    const cases = [
      { v: 1, harvest: { open: true, at: D } },
      { v: 1, glance: { open: false, at: D } },
      { v: 1, protect: { open: false, at: D, ack: { t: 'frost' } } },
      { v: 1, care: { open: false, at: D, ack: { r: ['never', 'small'] } } },
      { v: 1, headsup: { open: false, at: D, ack: { r: 'window' } } },
      { v: 1, 'hh-member_j': { open: true, at: D }, resting: { open: false, at: D } },
      big,
      tooMany,
      { v: 1 },
      { v: 2, care: { open: true, at: D } },
      { care: { open: true, at: D } },
      { v: 1, sidebar: { open: true, at: D } },
      { v: 1, 'hh-123456789': { open: true, at: D } },
      { v: 1, care: { open: true, at: D, ack: { r: 'small' } } },
      { v: 1, care: { open: false, at: D, ack: null } },
      { v: 1, care: { open: false, at: D, ack: {} } },
      { v: 1, care: { open: false, at: D, ack: { r: 'busy' } } },
      { v: 1, care: { open: false, at: D, ack: { r: [] } } },
      { v: 1, care: { open: false, at: D, ack: { r: ['small', 'small'] } } },
      { v: 1, care: { open: false, at: D, ack: { r: 'small', keys: ['x'] } } },
      { v: 1, protect: { open: false, at: D, ack: { t: 'freeze' } } },
      { v: 1, care: { open: 'true', at: D } },
      { v: 1, care: { open: true, at: '2026-10-1' } },
      { v: 1, care: { open: true, at: D, extra: 1 } },
      { v: 1, care: null },
      [],
      'x',
    ]
    for (const c of cases) {
      expect(wireOk(c), JSON.stringify(c).slice(0, 120)).toBe(serverAccepts(c))
    }
    // Anti-vacuity: the table holds both answers.
    expect(cases.filter(serverAccepts).length).toBeGreaterThanOrEqual(6)
    expect(cases.filter((c) => !serverAccepts(c)).length).toBeGreaterThanOrEqual(15)
  })
})
