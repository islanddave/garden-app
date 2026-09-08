// /api/app-config — V5-ADMINCENTER-001. The global config route on the critter Lambda.
//
// WHAT THIS FILE IS ACTUALLY GUARDING, in descending order of how much it matters:
//
//   1. THE ADMIN GATE, which is a privilege boundary and not a nicety. Every other route on this
//      Lambda is per-user: the write binds created_by to the caller's own token id, so it is
//      self-scoped by construction and an ungated route is harmless. public.app_config is keyed by
//      `key` alone — a self-scoped write to a SHARED row is not self-scoped, and either household
//      member could otherwise rewrite the installation's nav. RLS cannot substitute: app_config's
//      policies admit any authenticated caller (`current_user_id() IS NOT NULL`) and this Lambda
//      connects as a role that bypasses them anyway. ADMIN_CLERK_SUBS appeared ZERO times under
//      lambda/critter/ before this row, against a live positive control in lambda/facebook-share/ —
//      the absence was real, and BUG-ADMINCENTERNOGATE-001 is what this closes.
//
//   2. FAIL-CLOSED, which is the half that is easy to get backwards. An unset or empty
//      ADMIN_CLERK_SUBS must admit NOBODY, never everybody. ADMIN_CLERK_SUBS is per-function Lambda
//      runtime config and has never been set on this function, so on the first deploy the gate
//      refuses Dave too. That is the safe failure and it will look like a bug; these tests pin the
//      direction so a future "fix" cannot quietly invert it.
//
//   3. NO ROW = SHIPPED DEFAULT. app_config has zero rows in prod, so absence is the natural state
//      and the read must degrade to today's nav rather than to an empty bar.
//
// TIER. The gate and the validators are PURE and are executed here — a source-text search for
// "isAdmin" would pass on a file that names it in a comment. What cannot be executed is the handler:
// importing lambda/critter/index.js is impossible in this suite, whose Lambda runtime deps are
// deliberately not installed (retired-post-route.test.js:19-21 records the same limitation). So the
// CALL SITE gets a static assertion instead — a pure gate that the route never invokes is not a
// gate, and this file asserts the invocation exists, precedes body parsing, and is not commented
// out. The complementary runtime guard is src/__tests__/clientRouteLambdaContract.test.js, which
// reds if a client ever names a path no Lambda declares.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isAdmin, adminRefusal, validateAppConfigPatchBody, projectAppConfig,
  APP_CONFIG_KEYS, NAV_TAB_KEYS,
} from './validators.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_SRC = readFileSync(resolve(HERE, 'index.js'), 'utf8')

const DAVE = 'user_2dave'
const JEN = 'user_2jen'

describe('admin gate — ADMIN_CLERK_SUBS, fail-closed (BUG-ADMINCENTERNOGATE-001)', () => {
  it('admits a sub that is on the allowlist', () => {
    expect(isAdmin(DAVE, { ADMIN_CLERK_SUBS: DAVE })).toBe(true)
    expect(isAdmin(DAVE, { ADMIN_CLERK_SUBS: `${JEN},${DAVE}` })).toBe(true)
    // Whitespace around a comma is a configuration reality, not a typo to punish.
    expect(isAdmin(DAVE, { ADMIN_CLERK_SUBS: ` ${JEN} , ${DAVE} ` })).toBe(true)
  })

  it('REFUSES a signed-in non-admin — the case the whole row turns on', () => {
    // Jen is a real, fully authenticated user. She is not a rounding error and she is not an admin.
    expect(isAdmin(JEN, { ADMIN_CLERK_SUBS: DAVE })).toBe(false)
    expect(adminRefusal(JEN, { ADMIN_CLERK_SUBS: DAVE })).toEqual({ status: 403, error: 'Not authorized' })
  })

  it('admits NOBODY when the allowlist is unset, empty, or only separators', () => {
    // The inversion that matters: an unconfigured deploy must refuse everyone, not admit everyone.
    for (const env of [{}, { ADMIN_CLERK_SUBS: '' }, { ADMIN_CLERK_SUBS: '   ' }, { ADMIN_CLERK_SUBS: ',,,' }]) {
      expect(isAdmin(DAVE, env)).toBe(false)
      expect(adminRefusal(DAVE, env)).toEqual({ status: 403, error: 'Admin route not configured' })
    }
    // A missing env object entirely (never happens in the Lambda, but the gate must not throw).
    expect(isAdmin(DAVE, undefined)).toBe(false)
  })

  it('does not admit an empty, null or undefined userId against a configured allowlist', () => {
    // The V4-AUTHZRESIDUE-001 class: an absent JWT subject must be a no-match, never a live value.
    // `.filter(Boolean)` on the allowlist is what makes '' unmatchable even if it were somehow sent.
    for (const bad of ['', null, undefined]) {
      expect(isAdmin(bad, { ADMIN_CLERK_SUBS: `${DAVE},` })).toBe(false)
    }
  })

  it('matches the whole sub, not a prefix or a substring of one', () => {
    expect(isAdmin('user_2', { ADMIN_CLERK_SUBS: DAVE })).toBe(false)
    expect(isAdmin(`${DAVE}_extra`, { ADMIN_CLERK_SUBS: DAVE })).toBe(false)
  })

  it('reads the allowlist at CALL time, so a config change needs no cold start', () => {
    // Module-init caching is the third invariant the four existing implementations share. If the
    // subs were captured at import, the second call here would still see the first env.
    expect(isAdmin(DAVE, { ADMIN_CLERK_SUBS: '' })).toBe(false)
    expect(isAdmin(DAVE, { ADMIN_CLERK_SUBS: DAVE })).toBe(true)
  })
})

describe('the gate is actually WIRED — a pure helper nothing calls is not a gate', () => {
  // The PATCH branch's source, sliced out so the assertions below cannot be satisfied by the GET
  // branch or by this file's own header appearing in a grep of the repo.
  const patchStart = INDEX_SRC.indexOf("rawPath === '/api/app-config' && method === 'PATCH'")
  const patchEnd = INDEX_SRC.indexOf('route not found', patchStart)
  const patchBlock = INDEX_SRC.slice(patchStart, patchEnd)

  it('SELF-TEST: the slicer found a real PATCH branch', () => {
    // Without this, every assertion below passes vacuously the moment the markers stop matching.
    expect(patchStart).toBeGreaterThan(-1)
    expect(patchEnd).toBeGreaterThan(patchStart)
    expect(patchBlock).toContain('INSERT INTO public.app_config')
  })

  it('calls adminRefusal and returns its status, in executable code rather than a comment', () => {
    const call = patchBlock.match(/^\s*const refusal = adminRefusal\(userId, process\.env\)$/m)
    expect(call).not.toBeNull()
    expect(patchBlock).toMatch(/^\s*if \(refusal\) return resp\(refusal\.status, \{ error: refusal\.error \}\)$/m)
  })

  it('gates BEFORE the body is parsed — facebook-share/index.js:9 order', () => {
    // A non-admin must be turned away without their payload being read. Ordering is the assertion:
    // both lines existing in the wrong order is a real regression a presence check would miss.
    expect(patchBlock.indexOf('adminRefusal')).toBeGreaterThan(-1)
    expect(patchBlock.indexOf('JSON.parse')).toBeGreaterThan(-1)
    expect(patchBlock.indexOf('adminRefusal')).toBeLessThan(patchBlock.indexOf('JSON.parse'))
    // ...and before the SQL, which is the consequence that actually matters.
    expect(patchBlock.indexOf('adminRefusal')).toBeLessThan(patchBlock.indexOf('INSERT INTO'))
  })

  it('imports the gate from validators.js rather than redefining a local copy', () => {
    expect(INDEX_SRC).toMatch(/import \{[\s\S]*?adminRefusal[\s\S]*?\} from '\.\/validators\.js'/)
    // A second in-file definition would be the drift surface the four-Lambda idiom exists to avoid.
    expect(INDEX_SRC).not.toMatch(/function\s+(isAdmin|adminRefusal)\s*\(/)
  })

  it('leaves the GET ungated on purpose, and only the GET', () => {
    // Every client needs the nav order at boot, including the non-admin one — gating the read would
    // give Jen a different bar from Dave, which is the opposite of an installation-wide setting.
    const getStart = INDEX_SRC.indexOf("rawPath === '/api/app-config' && method === 'GET'")
    const getBlock = INDEX_SRC.slice(getStart, patchStart)
    expect(getStart).toBeGreaterThan(-1)
    expect(getBlock).toContain('projectAppConfig')
    expect(getBlock).not.toContain('adminRefusal')
  })

  it('does NOT reopen the wrong door — nav_tabs stays out of HAS_UPDATABLE', () => {
    // PATCH /api/notifications/prefs writes user_notification_prefs keyed by created_by. It cannot
    // implement a global setting at all, so adding the key there is wrong regardless of ordering.
    const validators = readFileSync(resolve(HERE, 'validators.js'), 'utf8')
    const allowlist = validators.match(/const HAS_UPDATABLE = \[([\s\S]*?)\]/)
    expect(allowlist).not.toBeNull()          // anti-vacuity: the array still exists to be checked
    expect(allowlist[1]).not.toContain('nav_tabs')
  })
})

describe('PATCH body validation — every malformed payload is refused, none is half-applied', () => {
  const ORDER = ['harvests', 'today', 'create', 'garden', 'put-up']

  it('accepts a permutation of the shipped tabs', () => {
    expect(validateAppConfigPatchBody({ nav_tabs: ORDER })).toBeNull()
    expect(validateAppConfigPatchBody({ nav_tabs: [...NAV_TAB_KEYS] })).toBeNull()
  })

  it('refuses a malformed payload — not an object, or not JSON-shaped at all', () => {
    for (const body of [null, undefined, 'nav_tabs', 42, []]) {
      expect(validateAppConfigPatchBody(body)).toEqual({ status: 400, error: 'body required' })
    }
  })

  it('refuses an unknown CONFIG key before any SQL could be built', () => {
    // V101 §3's point, generalised: the allowlist is the entire safety property. A key the route has
    // no column or handler for must 400, not reach the database.
    expect(validateAppConfigPatchBody({ nav_hats: ORDER })).toEqual({
      status: 400, error: 'unknown config key: nav_hats',
    })
    // Mixed valid + unknown is refused WHOLE, not partly applied.
    expect(validateAppConfigPatchBody({ nav_tabs: ORDER, feature_x: true })?.status).toBe(400)
  })

  it('refuses an empty body', () => {
    expect(validateAppConfigPatchBody({})).toEqual({ status: 400, error: 'no updatable fields present' })
  })

  it('refuses a nav_tabs value that is not an array — jsonb would accept any of these', () => {
    for (const v of [null, 'today', 7, { 0: 'today' }, true]) {
      expect(validateAppConfigPatchBody({ nav_tabs: v })).toEqual({
        status: 400, error: 'nav_tabs must be an array of tab keys',
      })
    }
  })

  it('refuses an unknown TAB key, including non-string entries', () => {
    for (const v of [['today', 'garden', 'create', 'harvests', 'moon'], ['today', 1, 'create', 'harvests', 'put-up'],
      ['today', null, 'create', 'harvests', 'put-up'], ['today', ['garden'], 'create', 'harvests', 'put-up']]) {
      expect(validateAppConfigPatchBody({ nav_tabs: v })?.error).toMatch(/^nav_tabs entries must be one of/)
    }
  })

  it('refuses a duplicate tab — two identical slots is a broken bar, not a configured one', () => {
    expect(validateAppConfigPatchBody({ nav_tabs: ['today', 'today', 'garden', 'create', 'harvests'] })).toEqual({
      status: 400, error: 'nav_tabs must not repeat a tab',
    })
  })

  it('refuses an empty array and any other arity — v1 is REORDER-ONLY', () => {
    // [] is a hide-everything attempt; a short list hides one tab; a long one cannot exist given the
    // vocabulary guard above but the arity check is what makes the rule a permutation rather than a
    // subset. Hiding removes the only door to a page — the defect class the reachability gate
    // catches, arriving another way — and the hide-vs-reorder question is still Dave's (design §7).
    expect(validateAppConfigPatchBody({ nav_tabs: [] })?.error).toMatch(/reorder-only/)
    expect(validateAppConfigPatchBody({ nav_tabs: ['today', 'garden'] })?.error).toMatch(/reorder-only/)
    expect(validateAppConfigPatchBody({ nav_tabs: NAV_TAB_KEYS.slice(0, 4) })?.error).toMatch(/reorder-only/)
  })
})

describe('GET projection — no row means the shipped default, never an empty bar', () => {
  it('reports every allowlisted key as null when app_config is empty', () => {
    // The live state: zero rows. This is the response the app boots against today, and null is what
    // resolveNavTabs turns into the shipped bar.
    expect(projectAppConfig([])).toEqual({ nav_tabs: null })
    for (const k of APP_CONFIG_KEYS) expect(projectAppConfig([])).toHaveProperty(k, null)
  })

  it('survives a driver returning something that is not an array', () => {
    // Total over its input for the same reason the client resolver is: a read that throws would take
    // the boot read down, and a failed nav config must degrade to today's nav.
    for (const rows of [null, undefined, {}, 'rows']) {
      expect(projectAppConfig(rows)).toEqual({ nav_tabs: null })
    }
  })

  it('returns a stored value when the row exists', () => {
    const order = ['harvests', 'today', 'create', 'garden', 'put-up']
    expect(projectAppConfig([{ key: 'nav_tabs', value: order }])).toEqual({ nav_tabs: order })
  })

  it('ignores a row whose key is not on the allowlist', () => {
    // Defence in depth against a hand-written row: the query already filters, but the projection
    // must not widen the response surface if that filter is ever loosened.
    expect(projectAppConfig([{ key: 'something_else', value: 'x' }])).toEqual({ nav_tabs: null })
  })

  it('normalises a NULL-valued row to null rather than leaking undefined', () => {
    expect(projectAppConfig([{ key: 'nav_tabs', value: null }])).toEqual({ nav_tabs: null })
  })
})
