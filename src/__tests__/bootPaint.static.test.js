// V4-PERFTHEMEA-001 — static guard on the two index.html changes.
//
// WHY A FILE-READING TEST: vitest runs jsdom with no `environmentOptions.html`, so index.html is
// never loaded into the test document — a DOM query would return null and prove nothing. Same
// house pattern as viewportMeta.static.test.js / noBareViewUrlImg.static.
// The preconnect block goes one step further and EXECUTES the extracted inline script against a
// fake document (appendedLinks below): since V4-PERFCLERK-001 the two links are emitted from a
// loop, and any source-text count of them would read one.
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

// V4-PERFCLERK-001: EXECUTE the inline <head> script against a fake document and return the link
// elements it appended, substituting a probe publishable key the way Vite substitutes the real one
// at build time. Behavioural, not source-text, and that distinction is load-bearing here: the two
// preconnects come out of a `for` loop, so counting `appendChild` occurrences in the source would
// report one and a regression to a single link would stay green.
const PROBE_HOST = 'probe.clerk.example.com'
const PROBE_KEY = `pk_test_${Buffer.from(`${PROBE_HOST}$`).toString('base64')}`

function appendedLinks(body = script(), key = PROBE_KEY) {
  const links = []
  const doc = { createElement: () => ({}), head: { appendChild: (el) => links.push(el) } }
  // eslint-disable-next-line no-new-func
  new Function('document', body.replace('%VITE_CLERK_PUBLISHABLE_KEY%', key))(doc)
  return links
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

  it('appends TWO preconnects to the one host, one per socket pool (V4-PERFCLERK-001)', () => {
    // Chrome keys its socket pool on credentials mode, so ONE link warms exactly one pool.
    // @clerk/react 6.12.7 injects BOTH clerk.browser.js and @clerk/ui with crossOrigin:'anonymous'
    // (verified in node_modules/@clerk/react/dist/ClerkProvider-*.mjs and in the decompressed prod
    // bundle), so the original credentialed-only preconnect warmed a socket neither script download
    // could use — the t=823ms handshake it was written to eliminate was still being paid.
    // The plain link is NOT redundant and must not be "tidied" away: the later /v1/environment +
    // /v1/client calls really do use credentials:'include'. Dropping either half re-opens a
    // handshake measured at TCP+TLS ≈ 112ms wired, plausibly 300–600ms on Android cellular.
    const links = appendedLinks()
    expect(links).toHaveLength(2)
    expect(links.every((l) => l.rel === 'preconnect')).toBe(true)
    expect(links.every((l) => l.href === `https://${PROBE_HOST}`)).toBe(true)
    // Exactly one of each pool. Two crossorigin links, or two plain ones, is the silent regression.
    expect(links.filter((l) => l.crossOrigin === 'anonymous')).toHaveLength(1)
    expect(links.filter((l) => l.crossOrigin === undefined)).toHaveLength(1)
  })

  it('SELF-TEST: the executor actually flags a script that appends only the credentialed link', () => {
    // Without this, every assertion above is vacuously true the moment the extractor stops matching.
    const single = "var l=document.createElement('link');l.rel='preconnect';document.head.appendChild(l)"
    const links = appendedLinks(single)
    expect(links).toHaveLength(1)
    expect(links.filter((l) => l.crossOrigin === 'anonymous')).toHaveLength(0)
  })

  it('derives the SAME host for both links from the key, and appends nothing for a bad key', () => {
    expect(appendedLinks(script(), 'not-a-clerk-key')).toHaveLength(0)
    expect(appendedLinks(script(), `pk_live_${Buffer.from('no-tld$').toString('base64')}`)).toHaveLength(0)
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
