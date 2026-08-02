// postLoginRoute.test.jsx — BD-003. Where a completed sign-in lands.
//
// Dave reported twice that signing in lands on Dashboard, and the obvious check said he was wrong:
// the route table has sent '/', '/login' (when authed) and '*' to /today since 2026-07-17 (9f03bc8,
// in prod from v3.78.0 — BEFORE the braindump was even taken). A session that stopped there would
// have closed this as already-fixed.
//
// The premise was correct and the cause was elsewhere: THREE literal '/dashboard' redirects in the
// Clerk sign-in path (AuthContext.signInWithGoogle's redirectUrlComplete, and both setActive calls
// in AuthCallback) were never moved with the route table. The route table decides where '/' goes;
// none of it runs when Clerk hands the browser an absolute post-auth URL.
//
// So these tests are deliberately SOURCE-level on the auth path rather than a render assertion:
// what failed was two subsystems disagreeing about one destination, and the only durable fix is
// that neither is allowed to name a route literally. No jest-dom (L-182).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { POST_LOGIN_ROUTE } from '../lib/constants.js'

// cwd-relative, matching the house pattern in HeroPhoto/PhotoHero tests (import.meta.url is not a
// file: URL under this vitest environment).
const read = (rel) => readFileSync(join(process.cwd(), rel), 'utf8')
const authContextSrc = read('src/context/AuthContext.jsx')
const authCallbackSrc = read('src/pages/AuthCallback.jsx')
const appSrc = read('src/App.jsx')

describe('BD-003 — a completed sign-in lands on Today, not Dashboard', () => {
  it('POST_LOGIN_ROUTE is /today', () => {
    expect(POST_LOGIN_ROUTE).toBe('/today')
  })

  // The class-closing assertion. Any NEW literal in the auth path reds here, which is the only
  // thing that would have caught the original drift.
  it('no file in the sign-in path names a landing route literally', () => {
    for (const [name, src] of [['AuthContext.jsx', authContextSrc], ['AuthCallback.jsx', authCallbackSrc]]) {
      expect(src, `${name} still hardcodes /dashboard`).not.toMatch(/['"`][^'"`]*\/dashboard/)
      expect(src, `${name} hardcodes /today instead of using POST_LOGIN_ROUTE`).not.toMatch(/['"`][^'"`]*\/today/)
    }
  })

  it('every redirect target in the auth path resolves through POST_LOGIN_ROUTE', () => {
    // OAuth kickoff: the absolute URL Clerk returns the browser to.
    expect(authContextSrc).toMatch(/redirectUrlComplete: `\$\{window\.location\.origin\}\$\{POST_LOGIN_ROUTE\}`/)
    // Callback, sign-IN branch.
    expect(authCallbackSrc).toMatch(/setActive\(\{ session, redirectUrl: decorateUrl\(POST_LOGIN_ROUTE\) \}\)/)
    // Callback, sign-UP branch — the one most likely to be forgotten, since a new account is the
    // path nobody re-walks after the first time.
    expect(authCallbackSrc).toMatch(/redirectUrl: POST_LOGIN_ROUTE/)
  })

  it('the route table agrees with the auth path — the two must not diverge again', () => {
    // This is the invariant that actually broke: both subsystems were individually defensible and
    // disagreed with each other. Pin them together, not separately.
    for (const path of ["'/'", "'/login'", "'*'"]) {
      const row = appSrc.split('\n').find((l) => l.includes(`path: ${path},`))
      expect(row, `route ${path} missing from the table`).toBeTruthy()
      expect(row, `route ${path} does not land on ${POST_LOGIN_ROUTE}`).toContain(`to="${POST_LOGIN_ROUTE}"`)
    }
  })
})
