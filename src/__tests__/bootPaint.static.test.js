// V4-PERFTHEMEA-001 — static guard on the two index.html changes.
//
// WHY A FILE-READING TEST: vitest runs jsdom with no `environmentOptions.html`, so index.html is
// never loaded into the test document — a DOM query would return null and prove nothing. Same
// house pattern as viewportMeta.static.test.js / noBareViewUrlImg.static.
//
// WHAT IT CATCHES: silent removal of the pre-React boot paint or of the Clerk preconnect by a
// merge, a re-skin, or an html-transform plugin. Both are single-site changes with no other
// observer in CI, and both are pure-performance — the app still WORKS without them, which is
// exactly why nothing else would ever notice they had gone.
//
// WHAT IT DOES NOT CATCH: whether the browser honours preconnect (device pass), and whether Vite's
// %VITE_*% HTML env replacement actually fires into dist/index.html. The second is asserted by
// bootPaint.build.test.js when a build artifact is present.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

// The body of the single inline <script> in index.html (the preconnect bootstrap).
function script() {
  const m = html.match(/<script>([\s\S]*?)<\/script>/)
  return m ? m[1] : ''
}

// The markup between the two ids, in document order — null if either id is missing.
function between(source) {
  const a = source.indexOf('id="root"')
  const b = source.indexOf('id="boot-splash"')
  if (a === -1 || b === -1) return null
  return source.slice(Math.min(a, b), Math.max(a, b))
}

describe('index.html pre-React boot paint (V4-PERFTHEMEA-001)', () => {
  it('renders a #boot-splash element in the markup, as a SIBLING of #root not a child', () => {
    // Outside #root matters: createRoot() owns #root's children and would wipe a splash placed
    // inside it on React's first commit — i.e. at the exact moment the app still has nothing to
    // show, re-opening the gap this closes.
    expect(between(html)).not.toBeNull()
    // #root must be CLOSED before the splash opens. If the splash were nested, there would be no
    // </div> between the two ids.
    expect(between(html)).toContain('</div>')
  })

  it('SELF-TEST: the sibling matcher actually flags a splash nested inside #root', () => {
    const nested = '<div id="root"><div id="boot-splash" aria-hidden="true">x</div></div>'
    expect(between(nested)).not.toBeNull()
    expect(between(nested)).not.toContain('</div>')
  })

  it('paints the app cream (#f8f5f0 — P.cream) so the handoff to SplashScreen is cream→cream', () => {
    // A white boot screen handing over to a cream splash is a visible flash; matching P.cream is
    // what makes React's takeover invisible.
    expect(html).toMatch(/#boot-splash\s*\{[^}]*background:\s*#f8f5f0/i)
  })

  it('covers the viewport with position:fixed;inset:0 rather than flowing in the document', () => {
    expect(html).toMatch(/#boot-splash\s*\{[^}]*position:\s*fixed/i)
    expect(html).toMatch(/#boot-splash\s*\{[^}]*inset:\s*0/i)
  })

  it('hides the boot paint from assistive tech — it carries no information', () => {
    expect(html).toMatch(/id="boot-splash"[^>]*aria-hidden="true"/)
  })
})

describe('index.html Clerk preconnect (V4-PERFTHEMEA-001)', () => {
  it('derives the Clerk FAPI host from the publishable key rather than hardcoding one', () => {
    // MEASURED: on prod the Clerk origin was not DNS/TCP/TLS-connected until t=823ms, because
    // nothing references it until the 402 kB entry bundle has downloaded and evaluated. The whole
    // handshake sits on the critical path to isLoaded.
    // Hardcoding clerk.garden.futureishere.net would be a CONFIG-CANONICITY violation: dev and
    // staging point at different Clerk instances (VITE_CLERK_PUBLISHABLE_KEY / STAGING_CLERK_KEY),
    // and a preconnect to prod's FAPI from staging warms a socket nothing will ever use.
    expect(html).toContain('%VITE_CLERK_PUBLISHABLE_KEY%')
    expect(html).not.toMatch(/clerk\.garden\.futureishere\.net/)
  })

  it('appends rel="preconnect" WITHOUT crossorigin — the credentialed socket pool', () => {
    // Asserted against the SCRIPT BODY, not the whole document: an earlier version of this matched
    // anywhere in the file and was tripped by the word "crossorigin" appearing in a nearby HTML
    // comment. A prose mention is not a code path.
    expect(script()).toMatch(/rel\s*=\s*'preconnect'/)
    // Chrome keys its socket pool on credentials mode. Both consumers of this origin are
    // credentialed — clerk.browser.js is a plain <script> (cookies sent) and Clerk's /v1/* calls
    // use credentials:'include'. `crossorigin` would warm the ANONYMOUS pool instead and buy
    // exactly nothing while looking like it worked.
    expect(script()).not.toMatch(/crossorigin/i)
  })

  it('SELF-TEST: the crossorigin matcher actually flags a script that sets it', () => {
    const bad = "var l=document.createElement('link');l.rel='preconnect';l.crossOrigin='anonymous'"
    expect(bad).toMatch(/rel\s*=\s*'preconnect'/)
    expect(bad).toMatch(/crossorigin/i)
  })

  it('is wrapped so a malformed key can never break boot', () => {
    // The key is decoded with atob() at parse time in <head>. A throw here would abort the inline
    // script before #root exists. preconnect is an optimisation; boot is not negotiable.
    const m = html.match(/<script>([\s\S]*?)<\/script>/)
    expect(m).not.toBeNull()
    expect(m[1]).toContain('try')
    expect(m[1]).toContain('catch')
  })

  it('SELF-TEST: the preconnect matcher actually flags markup that lost the tag', () => {
    // Without this, a matcher that silently stops matching would make the assertions above
    // vacuously true. Mandatory per the static-test house pattern.
    const stripped = html.replace(/<script>[\s\S]*?<\/script>/, '')
    expect(stripped).not.toContain('%VITE_CLERK_PUBLISHABLE_KEY%')
    expect(html).toContain('%VITE_CLERK_PUBLISHABLE_KEY%')
  })
})
