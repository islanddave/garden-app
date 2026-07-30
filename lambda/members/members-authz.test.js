// members-authz.test.js — 0A.5 Phase-1 leak-lock for GET /api/members (household scope + email drop, 0A.6/v3.74).
// /api/members reads from the LIVE Clerk API, not Postgres — so this is a handler UNIT test with
// @clerk/backend + SecretsManager fully mocked (no DB). It deliberately does NOT use the integration
// _harness (whose Clerk mock omits createClerkClient). Runs in the unit suite (locally + CI Build&Unit).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { handler } from './index.js'

const OWNER = 'user_hh_owner', MATE = 'user_hh_mate', STRANGER = 'user_stranger_outside'

const h = vi.hoisted(() => ({
  state: { sub: 'user_hh_owner' },
  users: [
    { id: 'user_hh_owner',         firstName: 'Dave',    lastName: 'N', emailAddresses: [{ emailAddress: 'dave@example.com' }] },
    { id: 'user_hh_mate',          firstName: 'Jen',     lastName: 'N', emailAddresses: [{ emailAddress: 'jen@example.com' }] },
    { id: 'user_stranger_outside', firstName: 'Mallory', lastName: 'X', emailAddresses: [{ emailAddress: 'mallory@evil.com' }] },
  ],
}))
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  GetSecretValueCommand: class { constructor(a) { this.input = a } },
  SecretsManagerClient: class { send() { return Promise.resolve({ SecretString: JSON.stringify({ CLERK_SECRET_KEY: 'stub' }) }) } },
}))
vi.mock('@clerk/backend', () => ({
  verifyToken: () => Promise.resolve({ sub: h.state.sub }),
  createClerkClient: () => ({ users: { getUserList: () => Promise.resolve({ data: h.users, totalCount: h.users.length }) } }),
}))

const call = (sub) => {
  h.state.sub = sub
  return handler({ requestContext: { http: { method: 'GET' } }, rawPath: '/api/members', headers: { authorization: 'Bearer stub' } })
    .then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }))
}

// householdScope reads GARDEN_HOUSEHOLD_IDS at call time; make OWNER+MATE one household, STRANGER outside.
// Save/restore so this file does not pollute the shared worker env (household-mode.test.js depends on it).
let _hhEnv
beforeAll(() => { _hhEnv = process.env.GARDEN_HOUSEHOLD_IDS; process.env.GARDEN_HOUSEHOLD_IDS = `${OWNER},${MATE}` })
afterAll(() => { if (_hhEnv === undefined) delete process.env.GARDEN_HOUSEHOLD_IDS; else process.env.GARDEN_HOUSEHOLD_IDS = _hhEnv })

describe('LEAK-GATE /api/members — household scope + email drop (0A.6 / v3.74)', () => {
  it('member sees ONLY household, never a foreign user, and NO email field', async () => {
    const { status, body } = await call(OWNER)
    expect(status).toBe(200)
    const ids = body.members.map((m) => m.id).sort()
    expect(ids).toEqual([OWNER, MATE].sort())     // scoped to household
    expect(ids).not.toContain(STRANGER)           // foreign user never leaked (old bug: returned ALL users)
    for (const m of body.members) {
      expect(m).not.toHaveProperty('email')
      expect(m).not.toHaveProperty('emailAddresses')
      expect(Object.keys(m).sort()).toEqual(['display_name', 'id']) // exact shape — email gone
    }
  })

  it('non-member (stranger) sees ONLY themselves — fail-closed scope', async () => {
    const { body } = await call(STRANGER)
    expect(body.members.map((m) => m.id)).toEqual([STRANGER])
  })

  it('envelope shape = { schema_version, members[] }', async () => {
    const { body } = await call(OWNER)
    expect(body.schema_version).toBeDefined()
    expect(Array.isArray(body.members)).toBe(true)
  })
})
