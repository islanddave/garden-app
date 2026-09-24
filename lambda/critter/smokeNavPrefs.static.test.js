// V5-NAVCUSTOM-001 — static guard on the staging smoke's block M (tests/smoke/run-smoke.sh), the
// write-then-read-back of more_pins and bar_layout through the critter Lambda.
//
// WHY A FILE-READING TEST. Block M runs only inside deploy-staging.yml, against the staging Lambda;
// nothing in the unit or integration suites executes run-smoke.sh. The way it rots silently is that its
// hand-written request bodies drift from what this Lambda accepts (a tab key renamed, a movable set
// narrowed, the pin-id pattern tightened): the smoke then reds on staging at the next promote instead of
// here. So every body block M and cleanup() send is parsed out of the script and put through this
// Lambda's own validatePrefsPatchBody. Same idiom as src/__tests__/stagingSmokeDeleteGuard.static.test.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validatePrefsPatchBody, NAV_TAB_KEYS, MORE_PIN_ID_RE } from './validators.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SMOKE = readFileSync(resolve(HERE, '../../tests/smoke/run-smoke.sh'), 'utf8')

const blockStart = SMOKE.indexOf('# ── M) Per-person nav prefs')
const blockEnd = SMOKE.indexOf('# ── Shared-state tally')
const BLOCK = SMOKE.slice(blockStart, blockEnd)
const CLEANUP = SMOKE.slice(SMOKE.indexOf('cleanup() {'), SMOKE.indexOf('trap cleanup INT TERM EXIT'))

const shellJson = (name) => {
  const m = BLOCK.match(new RegExp(`^\\s*${name}='([^']*)'$`, 'm'))
  expect(m, `${name}='…' in block M`).not.toBeNull()
  return JSON.parse(m[1])
}

describe('smoke block M — the bodies it sends are ones this Lambda accepts', () => {
  it('SELF-TEST: block M and cleanup() were found, block M after Phase 2 and gated on the critter URL', () => {
    expect(blockStart).toBeGreaterThan(SMOKE.indexOf('# ── Phase 2: Authenticated CRUD'))
    expect(blockEnd).toBeGreaterThan(blockStart)
    expect(BLOCK).toContain('"${STAGING_API_CRITTERS%/}/api/notifications/prefs"')
    expect(BLOCK).toMatch(/^if \[\[ -n "\$CLERK_JWT" && -n "\$\{CLERK_SESSION_ID:-\}" && -n "\$\{STAGING_API_CRITTERS:-\}"/m)
    expect(CLEANUP).toContain('NAVP_DIRTY')
  })

  it('both test layouts and the restore layout pass the validator, and the two test layouts differ', () => {
    // Mutation: hide ＋ or Today in either test layout, drop a tab from an order, or make B equal A (then
    // a leftover A from a dead run makes the read-back pass without the write having happened).
    const a = shellJson('NAVP_LAYOUT_A')
    const b = shellJson('NAVP_LAYOUT_B')
    const restore = shellJson('NAVP_DEFAULT_LAYOUT')
    for (const layout of [a, b, restore]) expect(validatePrefsPatchBody({ bar_layout: layout })).toBeNull()
    expect(a).not.toEqual(b)
    // The restore is the SHIPPED bar, which every reader treats exactly as NULL.
    expect(restore).toEqual({ order: NAV_TAB_KEYS, hidden: [] })
  })

  it('the pin list is seeds, photos and a run-unique smoke id the pattern accepts', () => {
    expect(BLOCK).toContain('NAVP_PIN_ID="smoke-$(echo "$TEST_RUN_ID" | tr \'[:upper:]\' \'[:lower:]\' | tr -cd \'a-z0-9\' | cut -c1-8)"')
    expect(BLOCK).toContain(`NAVP_PINS=$(jq -c -n --arg id "$NAVP_PIN_ID" '["seeds", "photos", $id]')`)
    // Every id that derivation can produce: "smoke-" plus 0..8 of [a-z0-9].
    for (const id of ['smoke-', 'smoke-3f2a9b1c', 'smoke-ci172712']) {
      expect(MORE_PIN_ID_RE.test(id)).toBe(true)
      expect(validatePrefsPatchBody({ more_pins: ['seeds', 'photos', id] })).toBeNull()
    }
  })

  it('the restore sends [] for the pins, never null — null would leave them stored (COALESCE)', () => {
    // Mutation: restore with "more_pins": null. The PATCH would 200 and the pins would stay.
    expect(BLOCK).toContain('navp_patch "{\\"more_pins\\": [], \\"bar_layout\\": $NAVP_DEFAULT_LAYOUT}"')
    expect(BLOCK).not.toMatch(/"more_pins\\?"?: null/)
  })

  it('cleanup()\'s best-effort restore body is the same restore, and the validator accepts it', () => {
    const m = CLEANUP.match(/"\$NAVP_URL" -d '([^']*)'/)
    expect(m).not.toBeNull()
    const body = JSON.parse(m[1])
    expect(body).toEqual({ more_pins: [], bar_layout: { order: NAV_TAB_KEYS, hidden: [] } })
    expect(validatePrefsPatchBody(body)).toBeNull()
  })
})
