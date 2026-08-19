// BUG-HARVWATCHROUTE-001 guard — pin every client API path to a Lambda that declares it.
//
// WHY THIS EXISTS. The harvest watch band shipped fetching '/api/events/harvest-watch'. src/lib/api.js
// routes '/api/events' to the events Lambda, which declares no such route; the band's fetch rejection
// is swallowed by design, so the Today section rendered nothing — and 33 tests passed, because the
// component and its test each declared the SAME private route string. Two copies that agree with each
// other and with nothing else. A coordinated edit passes in either direction, so the suite carried zero
// information about whether the feature worked.
//
// WHAT THIS DOES. Enumerates every '/api/...' path in production client source, resolves each one
// through the REAL exported prefix table in src/lib/api.js (by calling resolveUrl with probe base URLs
// — so first-match ordering is executed, not re-implemented), and asserts the Lambda it lands on
// declares a route that matches. It is not a source-text assertion: routes are extracted into a table
// and MATCHED by running the Lambda's own regexes and comparing its own literals.
//
// THE RULE THAT CATCHES THE BUG. A client path whose segments are all literal must match a Lambda
// LITERAL route. It is deliberately not allowed to be absorbed by a parameter pattern — that is the
// whole defect: '/api/events/harvest-watch' matches events' by-id regex /^\/api\/events\/([^/]+)$/,
// and 'harvest-watch' is not an event id. A client path with an interpolated segment (rendered ':p')
// must match a Lambda PATTERN, executed against a probe token.
//
// PARSING. Route literals are read from a real JS AST (acorn + acorn-jsx), never by regex over raw
// source. A first draft of this extractor used a regex comment-stripper and silently ate lines 429-590
// of lambda/photos/index.js — a comment containing "image/*" opened a block comment that closed 160
// lines later — losing four real routes. A parser cannot make that mistake. acorn/acorn-jsx are
// transitive (vite, eslint) rather than direct dependencies: if either disappears this file throws on
// import, which is loud, not silently green.
//
// REACH — read this before trusting a green run. Stated as limits, not hidden as exclusions:
//   * PATH ONLY, NOT METHOD. Lambdas check the verb separately from the path, so a GET-only route
//     called with POST (405) is NOT caught here.
//   * STATIC EXTRACTION. A path assembled at runtime from variables the parser cannot see is not
//     enumerated. Two accommodations are made, both listed in the report the failure prints:
//     a literal ending in '/' is treated as '<literal>/:p' (the "'/api/projects/public/' + slug"
//     concatenation shape), and a template expression glued to a non-'/' character is treated as a
//     query-string suffix and truncated there (the "`/api/tags${qs}`" shape).
//   * PATH-AGNOSTIC LAMBDAS. Seven Lambdas never read event.rawPath (achievements, favorites,
//     ux-events, app-events, daily-plan, xp-reconcile, photocdn-derivative): they serve whatever path
//     their Function URL receives, so any path routed to one is accepted. That is detected from the
//     source, not hardcoded, and it is reported so a Lambda that LOSES its routing is visible.
//   * OVER-COLLECTION. Every '/api/...' string in Lambda source counts as a declared literal, even one
//     in a log message. That direction risks a false PASS, never a false FAIL. In practice the only
//     such strings are the `event.rawPath ?? '/api/x'` defaults, which do name a served route.
//
// The matcher's ability to say NO is asserted in-file ("the matcher can reject"), so this cannot go
// green by matching everything.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname, relative, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as acorn from 'acorn'
import acornJsx from 'acorn-jsx'
import { resolveUrl, FUNCTION_URLS } from '../lib/api.js'

const Parser = acorn.Parser.extend(acornJsx())

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SRC = join(ROOT, 'src')
const LAMBDA = join(ROOT, 'lambda')

// Prefix -> the lambda/ directory that serves it. The KEYS are asserted below to be exactly the keys of
// the real FUNCTION_URLS (same set, same order), so a new prefix cannot be added to api.js without
// being routed here, and the values are asserted to be real directories.
const PREFIX_TO_LAMBDA = {
  '/api/projects/inactive': 'dashboard',
  '/api/projects': 'projects',
  '/api/plants': 'plants',
  '/api/locations': 'locations',
  '/api/notifications': 'events',
  '/api/events': 'events',
  '/api/favorites': 'favorites',
  '/api/photos': 'photos',
  '/api/dashboard': 'dashboard',
  '/api/search': 'dashboard',
  '/api/inventory-items': 'inventory-items',
  '/api/varieties': 'varieties',
  '/api/achievements': 'achievements',
  '/api/ux-events': 'ux-events',
  '/api/shared-state': 'shared-state',
  '/api/findings': 'findings',
  '/api/daily-plan': 'daily-plan-read',
  '/api/members': 'members',
  '/api/tags': 'tags',
  '/api/entity-tags': 'tags',
  '/api/storage-locations': 'storage-location',
  '/api/preservation': 'preservation',
  '/api/harvests': 'harvests',
  '/api/share/facebook': 'facebook-share',
}

// Clients that bypass api.js and hold their own base URL: src/lib/critterClient.js and
// src/lib/notificationPrefsClient.js read VITE_API_CRITTERS, src/lib/sharedStateClient.js reads
// VITE_API_SHARED_STATE, src/lib/uxEvents.js reads VITE_API_UX_EVENTS. Their paths are still checked —
// against the Lambda named here. Including them EXTENDS reach; without this map (and with the
// unmapped-base failure below) they would be the guard's blind spot. Note /api/critters* is served by
// a Lambda that has NO entry in the api.js prefix table at all, so these paths are reachable only this
// way — an unmapped base is a hard failure, never a silent skip.
const ENV_TO_LAMBDA = {
  VITE_API_CRITTERS: 'critter',
  VITE_API_SHARED_STATE: 'shared-state',
  VITE_API_UX_EVENTS: 'ux-events',
}

// src/lib/api.js is the routing TABLE, not a caller: its '/api/...' strings are FUNCTION_URLS keys
// (prefixes, e.g. '/api/notifications') and the doc block above them, none of which is a request path.
// Every prefix that is ALSO a real request path (e.g. '/api/harvests') is contributed by its actual
// callers, so nothing is lost by skipping this one file. api.js issues no fetch of its own.
const NOT_A_CALLER = ['src/lib/api.js']

const PROBE = 'Z0PROBE0Z' // stands in for an interpolated segment when executing Lambda patterns

// ── source loading / parsing ──────────────────────────────────────────────────────────────────────

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walkFiles(p, out)
    else if (['.js', '.jsx'].includes(extname(entry))) out.push(p)
  }
  return out
}

const isTestFile = (p) => /(^|\/)(__tests__|__mocks__|test)\//.test(p) || /\.test\.[jt]sx?$/.test(p)

function parse(file) {
  const code = readFileSync(file, 'utf8')
  return Parser.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true })
}

function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) walkAst(n, visit); return }
  if (typeof node.type === 'string') visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'range') continue
    walkAst(node[key], visit)
  }
}

// ── path normalisation ────────────────────────────────────────────────────────────────────────────

function normalisePath(p) {
  let out = p.split('?')[0].split('#')[0]
  // A literal ending in '/' is never a real request path — it is a concatenation base
  // ("'/api/projects/public/' + slug"). Treat the missing tail as one interpolated segment.
  if (out.length > 1 && out.endsWith('/')) out = `${out}:p`
  return out
}

// ── client extraction ─────────────────────────────────────────────────────────────────────────────

// Identifiers in a module that hold a Lambda base URL: `const X = (import.meta.env.VITE_API_Y ?? '')...`
function baseIdentsIn(ast) {
  const found = new Map()
  walkAst(ast, (n) => {
    if (n.type !== 'VariableDeclarator' || n.id?.type !== 'Identifier') return
    let env = null
    walkAst(n.init, (m) => {
      if (m.type === 'MemberExpression' && m.property?.type === 'Identifier' &&
          /^VITE_API_/.test(m.property.name)) env = m.property.name
    })
    if (env) found.set(n.id.name, env)
  })
  return found
}

// Rebuild a template literal into a path shape. Returns null when it is not an API path.
// `base` is set when the template opens with a module-local base-URL identifier.
function fromTemplate(node, baseIdents) {
  const quasis = node.quasis.map((q) => q.value.cooked ?? q.value.raw)
  let base = null
  let start = 0
  if (quasis[0] === '' && node.expressions.length) {
    const first = node.expressions[0]
    if (first.type === 'Identifier' && baseIdents.has(first.name)) {
      base = baseIdents.get(first.name)
      start = 1
    }
  }
  let out = quasis[start]
  let truncated = false
  for (let i = start; i < node.expressions.length; i++) {
    const after = quasis[i + 1] ?? ''
    const glued = !out.endsWith('/') || !(after === '' || after.startsWith('/'))
    if (glued) {
      // A query-string suffix or a non-segment interpolation: everything from here is unknowable.
      truncated = true
      break
    }
    out += `:p${after}`
  }
  if (!out.startsWith('/api/')) return null
  return { path: out, base, truncated }
}

function collectClientPaths() {
  // Keyed by base + path, not path alone: the same path reached through the prefix table and through a
  // module-local base URL are two separate contracts and both get checked.
  const found = new Map() // `${base ?? 'TABLE'} ${path}` -> { path, base, files:Set, truncated }
  const files = walkFiles(SRC)
    .filter((f) => !isTestFile(f))
    .filter((f) => !NOT_A_CALLER.includes(relative(ROOT, f)))
  for (const file of files) {
    const ast = parse(file)
    const baseIdents = baseIdentsIn(ast)
    const rel = relative(ROOT, file)
    const add = (rawPath, base, truncated) => {
      const path = normalisePath(rawPath)
      if (!path.startsWith('/api/')) return
      const key = `${base ?? 'TABLE'} ${path}`
      if (!found.has(key)) found.set(key, { path, base: base ?? null, files: new Set(), truncated: false })
      const rec = found.get(key)
      rec.files.add(rel)
      if (truncated) rec.truncated = true
    }
    walkAst(ast, (n) => {
      if (n.type === 'Literal' && typeof n.value === 'string' && n.value.startsWith('/api/')) {
        add(n.value, null, false)
      } else if (n.type === 'TemplateLiteral') {
        const t = fromTemplate(n, baseIdents)
        if (t) add(t.path, t.base, t.truncated)
      }
    })
  }
  return found
}

// ── lambda extraction ─────────────────────────────────────────────────────────────────────────────

function collectLambdaRoutes() {
  const table = {}
  for (const dir of readdirSync(LAMBDA)) {
    const abs = join(LAMBDA, dir)
    if (!statSync(abs).isDirectory()) continue
    const literals = new Set()
    const patterns = []
    let readsPath = false
    for (const file of walkFiles(abs).filter((f) => !isTestFile(f))) {
      const ast = parse(file)
      walkAst(ast, (n) => {
        if (n.type === 'Identifier' && n.name === 'rawPath') readsPath = true
        if (n.type === 'Literal' && n.regex && n.regex.pattern.includes('\\/api\\/')) {
          patterns.push({ re: new RegExp(n.regex.pattern, n.regex.flags), src: `/${n.regex.pattern}/`, file })
        } else if (n.type === 'Literal' && typeof n.value === 'string' && n.value.startsWith('/api/')) {
          literals.add(normalisePath(n.value).replace(/\/:p$/, '/'))
        }
      })
    }
    table[dir] = { literals, patterns, pathAgnostic: !readsPath }
  }
  return table
}

// ── the matcher ───────────────────────────────────────────────────────────────────────────────────

// Does Lambda `dir` declare a route serving client path `path`? Returns a reason string, or null.
function matchRoute(lambda, path) {
  if (!lambda) return 'no such Lambda directory'
  if (lambda.pathAgnostic) return null // serves every path its Function URL receives
  const dynamic = path.includes(':p')
  if (!dynamic) {
    if (lambda.literals.has(path)) return null
    return `no literal route declared for ${path} (declared: ${[...lambda.literals].sort().join(', ') || 'none'})`
  }
  const probe = path.replace(/:p/g, PROBE)
  for (const p of lambda.patterns) if (p.re.test(probe)) return null
  if (lambda.literals.has(probe)) return null
  return `no route pattern matches ${path} (probe ${probe}; patterns: ${lambda.patterns.map((p) => p.src).join(', ') || 'none'})`
}

// Which Lambda serves this client path? Executes the REAL resolveUrl against a probe table so the
// prefix table's first-match ordering is exercised rather than re-implemented.
const PROBE_URLS = Object.fromEntries(Object.keys(FUNCTION_URLS).map((k) => [k, `\x00${k}\x00`]))
function lambdaFor(path, base) {
  if (base) {
    if (!ENV_TO_LAMBDA[base]) return { error: `client base ${base} is not mapped to a Lambda` }
    return { dir: ENV_TO_LAMBDA[base], via: base }
  }
  let resolved
  try { resolved = resolveUrl(path.replace(/:p/g, PROBE), PROBE_URLS) } catch (e) { return { error: e.message } }
  const prefix = resolved.split('\x00')[1]
  const dir = PREFIX_TO_LAMBDA[prefix]
  if (!dir) return { error: `prefix ${prefix} has no Lambda mapping` }
  return { dir, via: prefix }
}

// ── the suite ─────────────────────────────────────────────────────────────────────────────────────

const CLIENT = collectClientPaths()
const LAMBDAS = collectLambdaRoutes()

describe('client route -> serving Lambda contract (BUG-HARVWATCHROUTE-001)', () => {
  // Anti-vacuity floors. An extractor that silently finds nothing must not pass: every per-path
  // assertion below would vanish and the file would report success while checking zero contracts.
  it('the extractors found a plausible amount of work to do', () => {
    expect(CLIENT.size).toBeGreaterThan(45)
    expect(Object.keys(LAMBDAS).length).toBeGreaterThan(20)
    const routed = Object.values(LAMBDAS).filter((l) => l.literals.size || l.patterns.length)
    expect(routed.length).toBeGreaterThan(15)
    // The photos Lambda is the one whose routes a regex comment-stripper silently ate. Pin that the
    // parser sees them, so this file cannot regress to the shape that produced a false green.
    expect(LAMBDAS.photos.literals.has('/api/photos/relay-upload')).toBe(true)
    expect(LAMBDAS.photos.literals.has('/api/photos/upload-url')).toBe(true)
  })

  it('the matcher can reject: a path no Lambda serves is reported unmatched', () => {
    // Both halves of the real defect, plus a bare invention. If any of these came back null the
    // per-path assertions below would be meaningless.
    expect(matchRoute(LAMBDAS.events, '/api/events/harvest-watch')).toMatch(/no literal route/)
    expect(matchRoute(LAMBDAS.events, '/api/events/harvest-watch/dismiss')).toMatch(/no (literal|route)/)
    expect(matchRoute(LAMBDAS.harvests, '/api/harvests/not-a-route')).toMatch(/no literal route/)
    expect(matchRoute(LAMBDAS.plants, '/api/plants/:p/not-a-route')).toMatch(/no route pattern/)
    // ...and can still accept the real ones, so it is not rejecting everything.
    expect(matchRoute(LAMBDAS.harvests, '/api/harvests/watch')).toBeNull()
    expect(matchRoute(LAMBDAS.plants, '/api/plants/:p/archive')).toBeNull()
  })

  it('PREFIX_TO_LAMBDA covers exactly the real api.js prefix table, in order', () => {
    expect(Object.keys(PREFIX_TO_LAMBDA)).toEqual(Object.keys(FUNCTION_URLS))
  })

  it('every mapped Lambda directory exists', () => {
    for (const dir of new Set([...Object.values(PREFIX_TO_LAMBDA), ...Object.values(ENV_TO_LAMBDA)])) {
      expect(existsSync(join(LAMBDA, dir)), `lambda/${dir}`).toBe(true)
    }
  })

  it('every client API path resolves to a Lambda (none falls off the prefix table)', () => {
    const bad = []
    for (const rec of CLIENT.values()) {
      const t = lambdaFor(rec.path, rec.base)
      if (t.error) bad.push(`${rec.path} <- ${[...rec.files].join(', ')}: ${t.error}`)
    }
    expect(bad).toEqual([])
  })

  const cases = [...CLIENT].sort(([a], [b]) => a.localeCompare(b))
  it.each(cases)('%s is declared by the Lambda that serves it', (_key, rec) => {
    const target = lambdaFor(rec.path, rec.base)
    expect(target.error).toBeUndefined()
    const reason = matchRoute(LAMBDAS[target.dir], rec.path)
    expect(
      reason,
      `${rec.path}\n  called from: ${[...rec.files].join(', ')}\n  routed via ${target.via} to lambda/${target.dir}\n  ${reason}`,
    ).toBeNull()
  })

  // Path-agnostic Lambdas are accepted wholesale, so pin WHICH ones they are. If a Lambda that used to
  // route by rawPath stops doing so, every path aimed at it would start passing for free — this test
  // reds instead. If a genuinely new single-route Lambda is added, add it here on purpose.
  it('the set of path-agnostic Lambdas is exactly the expected one', () => {
    const agnostic = Object.entries(LAMBDAS).filter(([, l]) => l.pathAgnostic).map(([d]) => d).sort()
    expect(agnostic).toEqual([
      'achievements', 'app-events', 'daily-plan', 'favorites',
      'photocdn-derivative', 'ux-events', 'xp-reconcile',
    ])
  })
})
