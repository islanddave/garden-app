// Put-Up release F — every vocabulary the F client WRITES is bound to the Lambda's own list (V4
// "Registry checklist": KITCHEN_* constants + client mirrors + one parity test). A chip or a body that
// offered a value the CHECK refuses would be a 400 behind a friendly form.
import { describe, it, expect } from 'vitest'
import {
  KITCHEN_UNITS, KITCHEN_LINE_KINDS, KITCHEN_ACTS, KITCHEN_FORMS, KITCHEN_SALT_METHODS, KITCHEN_SALT_BASES, KITCHEN_VESSEL_COUNT_MAX,
} from '../../lambda/preservation/kitchenBatch.js'
import { LINE_PATCH_KEYS as LAMBDA_LINE_PATCH_KEYS, STAGE_PATCH_KEYS } from '../../lambda/preservation/kitchenLines.js'
import { QUICK_UNITS, LINE_PATCH_KEYS, lineBody, emptyDraft } from '../components/putup/lines.js'
import { VESSEL_PRESETS, ABOUT_UNITS } from '../components/putup/JarHeatRow.jsx'
import { TOP_UP_UNITS, CHECK_IN_ACTS } from '../components/putup/goingNow.js'
import { SALT_METHODS, SALT_BASES, KITCHEN_FORMS as CLIENT_FORMS } from '../components/putup/fermentMath.js'
import { editableKeys } from '../components/putup/StageEditSheet.jsx'

describe('the F client writes only what the Lambda accepts', () => {
  it('every unit a chip offers is in KITCHEN_UNITS', () => {
    for (const u of [...QUICK_UNITS, ...ABOUT_UNITS, ...TOP_UP_UNITS, ...VESSEL_PRESETS.map(v => v.unit).filter(Boolean)]) {
      expect(KITCHEN_UNITS).toContain(u)
    }
  })
  it('the acts, forms, salt methods and bases are the Lambda\'s', () => {
    expect(CHECK_IN_ACTS.map(a => a.value)).toEqual([...KITCHEN_ACTS])
    expect([...CLIENT_FORMS]).toEqual([...KITCHEN_FORMS])
    expect([...SALT_METHODS]).toEqual([...KITCHEN_SALT_METHODS])
    expect([...SALT_BASES].sort()).toEqual([...KITCHEN_SALT_BASES].sort())
  })
  it('every line kind the client can build is one the route writes', () => {
    const planting = { plant_id: 'p', label: 'x', recent_picks: [] }
    const jar = { preservation_log_id: 'j', label: 'y', stock_mode: 'counted' }
    const kinds = [
      lineBody({ ...emptyDraft('k'), label: 'typed' }).body.input_kind,
      lineBody({ ...emptyDraft('k'), source: { kind: 'planting', hit: planting, pickId: null } }).body.input_kind,
      lineBody({ ...emptyDraft('k'), source: { kind: 'planting', hit: planting, pickId: 'h' } }).body.input_kind,
      lineBody({ ...emptyDraft('k'), source: { kind: 'jar', hit: jar } }).body.input_kind,
    ]
    for (const k of kinds) expect(KITCHEN_LINE_KINDS).toContain(k)
  })
  it('the line sheet sends only the line PATCH allowlist, and the edit sheet only each kind\'s', () => {
    expect([...LINE_PATCH_KEYS].sort()).toEqual([...LAMBDA_LINE_PATCH_KEYS].sort())
    for (const kind of ['tended', 'moved', 'put_up', 'started', 'noted']) {
      for (const k of editableKeys({ stage_kind: kind })) expect(STAGE_PATCH_KEYS[kind]).toContain(k)
    }
  })
  it('the jar count stepper stops at the CHECK\'s ceiling', () => {
    expect(KITCHEN_VESSEL_COUNT_MAX).toBe(50)
  })
})
