// BUG-PLANTINGWAVELABELDAYEARLY-001 — the planting picker printed a sown date a day early.
//
// THE WIRE. plants.sown_at is a DATE. GET /api/plants?view=picker selects it raw, the driver turns a
// DATE into local midnight in the Lambda's zone (UTC) and JSON.stringify sends "2026-04-10T00:00:00.000Z"
// (the mechanism is established in putUpDateEcho.tz.test.js); other callers hand the label a bare
// "2026-04-10". Either way it is a calendar day with no instant behind it, and reading it through
// `new Date()` lands on the evening before everywhere west of Greenwich.
//
// THE PHONE is in America/New_York. This file switches the process zone itself rather than trusting
// the runner's: CI runs the suite once in UTC, where the defect cannot show.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { plantingWaveLabel } from '../components/forms/PlantingSelect.jsx'
import { plantingOptionLabel } from '../pages/PutUp.jsx'

const PHONE_TZ = 'America/New_York'
const ORIGINAL_TZ = process.env.TZ
const setZone = (tz) => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz }

beforeEach(() => setZone(PHONE_TZ))
afterEach(() => setZone(ORIGINAL_TZ))

const zuke = (sown_at) => ({ name: 'Dark Green Zucchini', succession_order: 2, sown_at })

describe('the zone this proof depends on is really in force', () => {
  // INSTRUMENT CHECK. If the runtime ignored the TZ change, the cases below would pass for the wrong reason.
  it('the phone zone reads UTC midnight as the evening before', () => {
    expect(new Date('2026-04-10T00:00:00.000Z').getDate()).toBe(9)
  })
})

describe('plantingWaveLabel prints the sown day that is stored (run in ET)', () => {
  it('a bare date prints its own day', () => {
    expect(plantingWaveLabel(zuke('2026-04-10'))).toBe('Dark Green Zucchini — wave 2, sown Apr 10')
  })

  it('the DATE column as the Lambda serialises it (a UTC-midnight instant) prints its own day', () => {
    expect(plantingWaveLabel(zuke('2026-04-10T00:00:00.000Z'))).toBe('Dark Green Zucchini — wave 2, sown Apr 10')
    expect(plantingWaveLabel(zuke('2026-04-10T00:00:00Z'))).toBe('Dark Green Zucchini — wave 2, sown Apr 10')
  })

  it('the first of a month does not fall back into the month before', () => {
    expect(plantingWaveLabel(zuke('2026-05-01'))).toBe('Dark Green Zucchini — wave 2, sown May 1')
    expect(plantingWaveLabel(zuke('2026-01-01T00:00:00.000Z'))).toBe('Dark Green Zucchini — wave 2, sown Jan 1')
  })

  it('PutUp re-exports the same function, so its provenance line is covered too', () => {
    expect(plantingOptionLabel(zuke('2026-04-10'))).toBe('Dark Green Zucchini — wave 2, sown Apr 10')
  })

  // A value with a real time of day IS an instant, and it still renders in the viewer's zone:
  // 02:30 UTC on Apr 10 is 22:30 on Apr 9 in New York.
  it('a real timestamp still renders in local time', () => {
    expect(plantingWaveLabel(zuke('2026-04-10T02:30:00.000Z'))).toBe('Dark Green Zucchini — wave 2, sown Apr 9')
    expect(plantingWaveLabel(zuke('2026-04-10T16:00:00.000Z'))).toBe('Dark Green Zucchini — wave 2, sown Apr 10')
  })

  it('an unreadable or absent date leaves the sown clause off', () => {
    expect(plantingWaveLabel(zuke('not a date'))).toBe('Dark Green Zucchini — wave 2')
    expect(plantingWaveLabel(zuke(null))).toBe('Dark Green Zucchini — wave 2')
  })
})
