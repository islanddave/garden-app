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
import { WARM_PATHS } from '../lib/warmOrigins.js'

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

// The bodies of index.html's inline <script> blocks, in document order. [0] is the Clerk preconnect
// bootstrap, [1] the API preconnect bootstrap. Attribute-less `<script>` on purpose: the module
// script that loads main.jsx carries attributes and must never be picked up here.
function scripts() {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
}

// The body of the FIRST inline <script> — the Clerk preconnect bootstrap.
function script() {
  return scripts()[0] ?? ''
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

// ── V4-PERFTHEMEA-001 — API preconnect ──────────────────────────────────────────────────────────
//
// MEASURED: 21 API origins, one hostname each, all http/1.1 (no multiplexing), DNS 37-256ms +
// TCP 60-200ms + TLS 70-240ms per origin — and nothing opens any of them until the 1.4MB entry
// chunk has downloaded and evaluated. The four preconnects put that handshake beside the download
// instead of after it.
//
// THE ASSERTION THAT MATTERS is not "there are preconnects" but "they are EXACTLY the WARM_PATHS
// origins". Both halves are silent failures: a path added to WARM_PATHS and not here is a cold
// handshake nobody notices, and a host preconnected here that nothing warms holds an idle socket
// ~10s against the entry chunk on the same radio. So this derives the expected env-var set from
// warmOrigins.js's WARM_PATHS run through api.js's FUNCTION_URLS table — the same two sources the
// runtime uses — rather than restating a list a drifting edit could satisfy.
const API_SRC = readFileSync(resolve(process.cwd(), 'src/lib/api.js'), 'utf8')

// FUNCTION_URLS as {prefix: VITE_VAR_NAME}, IN SOURCE ORDER. Order is load-bearing: resolveUrl
// returns the first prefix that matches, so '/api/projects/inactive' must be seen before
// '/api/projects'. A Map preserves it; a plain object would too, but a Map says so.
function functionUrlEnvNames() {
  const block = API_SRC.match(/export const FUNCTION_URLS = \{([\s\S]*?)\n\}/)
  if (!block) throw new Error('FUNCTION_URLS table not found in src/lib/api.js')
  const out = new Map()
  for (const m of block[1].matchAll(/'([^']+)':\s*import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)) {
    out.set(m[1], m[2])
  }
  return out
}

// resolveUrl's prefix rule, applied to names instead of URLs.
function envNameFor(path, table) {
  for (const [prefix, name] of table) if (path.startsWith(prefix)) return name
  throw new Error(`no FUNCTION_URLS entry for ${path}`)
}

const PROBE_ORIGINS = {
  VITE_API_PLANTS: 'https://plants.example.aws',
  VITE_API_DAILY_PLAN_READ: 'https://dailyplan.example.aws',
  VITE_API_LOCATIONS: 'https://locations.example.aws',
  VITE_API_INVENTORY: 'https://inventory.example.aws',
}

// EXECUTE the API bootstrap against a fake document, substituting probe URLs the way Vite
// substitutes the real ones. Behavioural for the same reason the Clerk executor is: the links come
// out of a loop with a dedupe and a throwing-URL skip, none of which source-text counting can see.
function apiLinks(subs = PROBE_ORIGINS, body = scripts()[1] ?? '') {
  const links = []
  const doc = { createElement: () => ({}), head: { appendChild: (el) => links.push(el) } }
  let src = body
  for (const [name, value] of Object.entries(subs)) src = src.split(`%${name}%`).join(value)
  // eslint-disable-next-line no-new-func
  new Function('document', src)(doc)
  return links
}

describe('index.html API preconnect (V4-PERFTHEMEA-001)', () => {
  it('preconnects EXACTLY the WARM_PATHS origins — same set, no more, no fewer', () => {
    const table = functionUrlEnvNames()
    const expected = new Set(WARM_PATHS.map((p) => envNameFor(p, table)))
    const found = new Set(
      [...(scripts()[1] ?? '').matchAll(/%(VITE_[A-Z0-9_]+)%/g)].map((m) => m[1]),
    )
    expect([...found].sort()).toEqual([...expected].sort())
  })

  it('SELF-TEST: the WARM_PATHS→env-var derivation resolves real names, not undefined', () => {
    // If functionUrlEnvNames() ever stopped matching, both sides above would be empty sets and the
    // equality would pass vacuously.
    const table = functionUrlEnvNames()
    expect(table.size).toBeGreaterThan(15)
    expect(WARM_PATHS.length).toBe(4)
    for (const p of WARM_PATHS) expect(envNameFor(p, table)).toMatch(/^VITE_API_/)
  })

  it('emits one anonymous-pool preconnect per origin', () => {
    const links = apiLinks()
    expect(links).toHaveLength(4)
    expect(links.every((l) => l.rel === 'preconnect')).toBe(true)
    // ANONYMOUS, not credentialed: every API request is credentials:'omit' (warmOrigins.js) or a
    // cross-origin default that sends nothing (api.js), both of which use Chrome's privacy-mode
    // socket pool. A plain preconnect warms the other pool and buys nothing — the mistake
    // V4-PERFCLERK-001 found on the Clerk side.
    expect(links.every((l) => l.crossOrigin === 'anonymous')).toBe(true)
    expect(links.map((l) => l.href).sort()).toEqual(Object.values(PROBE_ORIGINS).sort())
  })

  it('emits ORIGINS, not full Function URLs with a path', () => {
    const links = apiLinks({ ...PROBE_ORIGINS, VITE_API_PLANTS: 'https://plants.example.aws/api/plants' })
    expect(links.map((l) => l.href)).toContain('https://plants.example.aws')
  })

  it('dedupes by origin, the way warmApiOrigins does', () => {
    // Two prefixes can legitimately resolve to one Function URL; that is one socket, not two.
    const links = apiLinks({ ...PROBE_ORIGINS, VITE_API_LOCATIONS: PROBE_ORIGINS.VITE_API_PLANTS })
    expect(links).toHaveLength(3)
  })

  it('skips an unset var (Vite leaves the literal %VITE_X%) instead of emitting a broken link', () => {
    // A staging/dev build missing one var must lose THAT origin, not the rest, and must never
    // append <link href="%VITE_API_PLANTS%">.
    const links = apiLinks({ ...PROBE_ORIGINS, VITE_API_PLANTS: '%VITE_API_PLANTS%' })
    expect(links).toHaveLength(3)
    expect(links.every((l) => l.href.startsWith('https://'))).toBe(true)
  })

  it('SELF-TEST: the executor actually flags a bootstrap that emits nothing', () => {
    expect(apiLinks(PROBE_ORIGINS, 'void 0')).toHaveLength(0)
  })

  it('derives the hosts from %VITE_*% rather than hardcoding a prod Function URL', () => {
    const body = scripts()[1] ?? ''
    expect(body).toMatch(/%VITE_API_[A-Z0-9_]+%/)
    expect(body).not.toMatch(/lambda-url|amazonaws\.com|futureishere\.net/)
  })

  it('is wrapped so a malformed URL can never break boot', () => {
    const body = scripts()[1] ?? ''
    expect(body).toContain('try')
    expect(body).toContain('catch')
  })
})
