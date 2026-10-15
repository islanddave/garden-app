// V5-TODAYREDESIGN-001 S7 — static guard on the staging smoke's block M5 (tests/smoke/run-smoke.sh), the
// write → read-back of today_sections through the critter Lambda (L-108).
//
// WHY A FILE-READING TEST. M5 runs only inside deploy-staging.yml, against the staging Lambda; nothing in the
// unit or integration suites executes run-smoke.sh, and this lane did not run it (no database, no staging). It rots
// silently when its bodies drift from what this Lambda accepts — then it reds on staging at the next promote
// instead of here. Same idiom as smokeNavPrefs.static.test.js: the bodies M5 sends are put through this Lambda's
// own validatePrefsPatchBody. M5 builds them with jq at run time, so each template is asserted as TEXT and the body
// it produces is reconstructed here and validated.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validatePrefsPatchBody } from './validators.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SMOKE = readFileSync(resolve(HERE, '../../tests/smoke/run-smoke.sh'), 'utf8')

const mStart = SMOKE.indexOf('# ── M) Per-person nav prefs')
const blockStart = SMOKE.indexOf('# M5) today_sections')
const blockEnd = SMOKE.indexOf('# ── Shared-state tally')
const BLOCK = SMOKE.slice(blockStart, blockEnd)
const CLEANUP = SMOKE.slice(SMOKE.indexOf('cleanup() {'), SMOKE.indexOf('trap cleanup INT TERM EXIT'))
const D = '2026-10-14'

describe('smoke block M5 — today_sections, the bodies it sends are ones this Lambda accepts', () => {
  it('SELF-TEST: M5 sits inside block M (its URL, helpers and critter gate) and cleanup() knows it', () => {
    expect(mStart).toBeGreaterThan(0)
    expect(blockStart).toBeGreaterThan(SMOKE.indexOf('# M4) garden_group_by'))
    expect(blockEnd).toBeGreaterThan(blockStart)
    // Still inside M's `if`: the block ends at M's own `else` WARN, before the tally.
    expect(BLOCK).toContain('echo "⚠️  WARN [write:prefs-nav] STAGING_API_CRITTERS unset/placeholder or no JWT')
    expect(BLOCK).toContain('navp_patch')
    expect(BLOCK).toContain('"$NAVP_URL"')
    expect(SMOKE).toMatch(/^TSEC_DIRTY=false$/m)
    expect(SMOKE).toMatch(/^TSEC_RESTORE=""$/m)
    expect(CLEANUP).toContain('"$TSEC_DIRTY" == "true"')
    expect(CLEANUP).toContain('"$NAVP_URL" -d "$TSEC_RESTORE"')
  })

  it('the round-trip bodies are today_sections ALONE, in the shapes the validator takes', () => {
    // The jq templates, as text: each write names today_sections and nothing else.
    expect(BLOCK).toContain(`'{today_sections: {v: 1, harvest: $e}}'`)
    expect(BLOCK).toContain(`'{today_sections: {v: 1, protect: $e}}'`)
    expect(BLOCK).toContain(`'{open: $o, at: $at}'`)
    expect(BLOCK).toContain(`'{open: false, at: $at, ack: {t: $t}}'`)
    expect(BLOCK).toContain('TSEC_AT=$(date -u +%F)')
    // What they produce, for every value the block can pick.
    for (const open of [true, false]) {
      expect(validatePrefsPatchBody({ today_sections: { v: 1, harvest: { open, at: D } } })).toBeNull()
    }
    expect(BLOCK).toMatch(/TSEC_TIER=hardfreeze; else TSEC_TIER=frost; fi/)
    for (const t of ['frost', 'hardfreeze']) {
      expect(validatePrefsPatchBody({ today_sections: { v: 1, protect: { open: false, at: D, ack: { t } } } })).toBeNull()
    }
  })

  it('the restore puts back what the first GET held, or a plain close — and the validator takes both', () => {
    expect(BLOCK).toContain(`'{today_sections: {v: 1, harvest: ($h // {open: false, at: $at}), protect: ($p // {open: false, at: $at})}}'`)
    // Built before the first write, so cleanup() has it if the run dies between.
    expect(BLOCK.indexOf('TSEC_RESTORE=$(')).toBeLessThan(BLOCK.indexOf('# M5a)'))
    expect(BLOCK.indexOf('TSEC_DIRTY=true')).toBeLessThan(BLOCK.indexOf('# M5a)'))
    const plain = { open: false, at: D }
    expect(validatePrefsPatchBody({ today_sections: { v: 1, harvest: plain, protect: plain } })).toBeNull()
    expect(validatePrefsPatchBody({ today_sections: { v: 1, harvest: { open: true, at: '2026-10-01' }, protect: { open: false, at: D, ack: { t: 'chill' } } } })).toBeNull()
  })

  it('M5d\'s two refusals are refused by this Lambda, for the reasons the block names', () => {
    const bad = JSON.parse(BLOCK.match(/^\s*TSEC_BAD_KEY='([^']*)'$/m)[1])
    expect(validatePrefsPatchBody(bad)).toEqual({ status: 400, error: 'today_sections has unknown section key: sidebar' })
    expect(BLOCK).toContain(`'{today_sections: {v: 1, harvest: $e}, critter_visit: $cv}'`)
    expect(validatePrefsPatchBody({ today_sections: { v: 1, harvest: { open: true, at: D } }, critter_visit: 'in_app_only' }))
      .toEqual({ status: 400, error: 'today_sections must be sent alone (also present: critter_visit)' })
  })

  it('the column-absent path asserts the 409 the S7 Lambda gives, with a probe the validator accepts', () => {
    expect(BLOCK).toContain('[[ "$TSEC_HTTP" == "200" && "$TSEC_HAS" == "false" ]]')
    expect(BLOCK).toContain('[[ "$TSEC_CODE" == "409" ]]')
    expect(BLOCK).toContain(`'{today_sections: {v: 1, glance: {open: false, at: $at}}}'`)
    expect(validatePrefsPatchBody({ today_sections: { v: 1, glance: { open: false, at: D } } })).toBeNull()
  })
})
