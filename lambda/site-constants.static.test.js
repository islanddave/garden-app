// Site constants: the places where one garden's facts (its latitude, its frost dates, its town, its fitted
// calibration) are compiled into the code (V5-SITECONSTANTS-001, multi-space Phase 1 step 1.4).
//
// WHY THIS EXISTS. A second Space will not live at 42.5 N with a mid-October first frost. Each of these
// declarations becomes a per-Space read later; until then the list below is every one of them, pinned by file and
// name, so a new one cannot slip in unnoticed and a removed one cannot leave the list claiming more than is true.
// Both directions red:
//   * a site-constant declaration that is not on the list (e.g. `const SITE_LNG = …`) — NEW, put it in a per-Space
//     read instead, or add it here with the reviewer looking;
//   * a list entry whose declaration is gone (e.g. `SITE_LAT` removed) — STALE, delete the entry.
// What counts as a site constant (name pattern, content pattern, JSON keys) is SITE_NAME / SITE_TEXT /
// SITE_JSON_KEY in scripts/repo-constants-scan.mjs. Non-test `lambda/**` and `src/**` only.
//
// The nil UUID (all zeros) is the old "no Space" placeholder that step 1.9 folds away; its count in non-test
// lambda/, src/ and scripts/ is 0 and stays 0.
//
// Regenerate the list: `node scripts/repo-constants-scan.mjs site`.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSiteConstants, scanNilUuid, siteConstantsInJs, walk, parseJs, eachNode, isTestPath, ROOT } from '../scripts/repo-constants-scan.mjs'

// Recon §1.4 at 51a97146, plus SITE_FACTOR (src/lib/maturityCalibration.js: time-to-harvest fitted "at this
// site"), which the recon's list did not name and the pattern finds.
const SITE_CONSTANTS = [
  ['lambda/daily-plan/overwinter.js', 'SITE_LAT'],
  ['lambda/harvests/watch.js', 'DERIVED_FROST_WINDOW_DAYS'],
  ['lambda/harvests/watch.js', 'DERIVED_OBSERVED_FIRST_FALL_FROST_MMDD'],
  ['src/data/storageDeadlines.json', 'measured_basis'],
  ['src/lib/helperPrompt.js', 'PREAMBLE'],
  ['src/lib/maturityCalibration.js', 'SITE_FACTOR'],
  ['src/lib/sowEngine.js', 'FROST_ANCHORS'],
  ['src/lib/sowEngine.js', 'OBSERVED_FIRST_FALL_FROST'],
]

const key = ([file, identifier]) => `${file} ${identifier}`

describe('site constants (1.4)', () => {
  const found = scanSiteConstants().map(({ file, identifier }) => key([file, identifier]))
  const pinned = SITE_CONSTANTS.map(key)

  it('walked the trees it claims to (anti-vacuity)', () => {
    expect(walk(['lambda', 'src']).length).toBeGreaterThan(1000)
    expect(found.length).toBeGreaterThan(0)
  })

  it('no site constant outside the pinned list (NEW: read it per Space, or add it here in review)', () => {
    expect(found.filter((k) => !pinned.includes(k))).toEqual([])
  })

  it('no pinned entry without its declaration (STALE: delete the entry)', () => {
    expect(pinned.filter((k) => !found.includes(k))).toEqual([])
  })

  it('the nil UUID appears in no non-test file under lambda/, src/, scripts/ (baseline 0)', () => {
    expect(scanNilUuid()).toEqual({})
  })

  // QA MINOR / RIA MINOR: the three scanners read tracked files, as CI's clean checkout does, so an untracked scratch
  // file or a gitignored dump never reds locally. A tree that is not a work tree (the planted fixtures) is walked.
  it('walk reads tracked files in a git work tree, every file in a plain tree', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'walk-')))
    try {
      mkdirSync(join(root, 'lambda/x'), { recursive: true })
      for (const f of ['tracked.js', 'untracked.js', 'ignored.js']) writeFileSync(join(root, 'lambda/x', f), 'const A = 1\n')
      expect(walk(['lambda'], { root })).toEqual(['lambda/x/ignored.js', 'lambda/x/tracked.js', 'lambda/x/untracked.js'])
      writeFileSync(join(root, '.gitignore'), 'ignored.js\n')
      execFileSync('git', ['init', '-q'], { cwd: root })
      execFileSync('git', ['add', 'lambda/x/tracked.js'], { cwd: root })
      expect(walk(['lambda'], { root })).toEqual(['lambda/x/tracked.js'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // The detector itself, so a green run above cannot be a blind one.
  it('the detector finds a declaration and ignores a comment', () => {
    expect(siteConstantsInJs('const SITE_LNG = -72.6;')).toEqual(['SITE_LNG'])
    expect(siteConstantsInJs('export const HOME_LAT = 42.5')).toEqual(['HOME_LAT'])
    expect(siteConstantsInJs("const INTRO = `We garden in South Deerfield`")).toEqual(['INTRO'])
    expect(siteConstantsInJs('// const SITE_LNG = -72.6\nconst LATER = 1')).toEqual([])
  })
})

// SEC-21: the Clerk allow-list lives only in lambda/request-context.js and its byte copies (one per handler dir). A
// second list could drift from it, and a verifyToken( call without the list lets Clerk accept a token minted for any
// origin. Read from the AST, so a commented-out list is not a list. lambda/_test-stubs is test support, not shipped.
const ORIGIN = /https?:\/\/(?:[\w-]+\.)*(?:futureishere\.net|dg6mmjhepoyt9\.cloudfront\.net)/
const KIT_FILE = /^lambda\/(?:[^/]+\/)?request-context\.js$/
const keyName = (p) => (p.computed ? null : p.key.type === 'Identifier' ? p.key.name : p.key.value)
const isAllowListRef = (n) => n?.type === 'Identifier' && n.name === 'AUTHORIZED_PARTIES'

// Every origin literal and every authorizedParties array in the code.
function allowListsInJs(code) {
  const ast = parseJs(code)
  if (!ast) return null
  const found = []
  eachNode(ast, (n) => {
    if (n.type === 'Literal' && typeof n.value === 'string' && ORIGIN.test(n.value)) found.push(`origin ${n.value}`)
    else if (n.type === 'TemplateElement' && ORIGIN.test(n.value.raw)) found.push(`origin ${n.value.raw}`)
    else if (n.type === 'Property' && keyName(n) === 'authorizedParties' && n.value.type === 'ArrayExpression') found.push('authorizedParties array')
  })
  return found
}

// The verifyToken( calls, and every way one of them, or any authorizedParties value, is not the kit's constant.
function signInProblemsInJs(code, { kit }) {
  const ast = parseJs(code)
  if (!ast) return null
  let calls = 0
  let usesList = false
  let imported = false
  const problems = []
  eachNode(ast, (n) => {
    if (n.type === 'Property' && keyName(n) === 'authorizedParties' && !isAllowListRef(n.value)) problems.push(`authorizedParties: ${n.value.type}`)
    if (isAllowListRef(n)) usesList = true
    if (n.type === 'VariableDeclarator' && isAllowListRef(n.id) && !kit) problems.push('declares its own AUTHORIZED_PARTIES')
    if (n.type === 'ImportDeclaration' && n.source.value === './request-context.js'
      && n.specifiers.some((s) => s.imported?.name === 'AUTHORIZED_PARTIES' && s.local.name === 'AUTHORIZED_PARTIES')) imported = true
    const callee = n.type === 'CallExpression' ? n.callee : null
    if (callee && (callee.name === 'verifyToken' || callee.property?.name === 'verifyToken')) {
      calls += 1
      const opts = n.arguments[1]
      const ok = opts?.type === 'ObjectExpression' && opts.properties.some((p) => p.type === 'Property' && keyName(p) === 'authorizedParties' && isAllowListRef(p.value))
      if (!ok) problems.push('verifyToken( without authorizedParties: AUTHORIZED_PARTIES')
    }
  })
  if (usesList && !kit && !imported) problems.push('AUTHORIZED_PARTIES not imported from ./request-context.js')
  return { calls, problems }
}

describe('SEC-21: one Clerk allow-list (lambda/request-context.js)', () => {
  const files = walk(['lambda']).filter((rel) => /\.[cm]?jsx?$/.test(rel) && !isTestPath(rel) && !rel.startsWith('lambda/_test-stubs/'))
  const code = (rel) => readFileSync(join(ROOT, rel), 'utf8')
  const parsed = (rel, v) => {
    if (v === null) throw new Error(`${rel}: acorn could not parse it`)
    return v
  }

  it('SEC-21: no handler defines its own allow-list literal', () => {
    const holders = files.filter((rel) => parsed(rel, allowListsInJs(code(rel))).length > 0)
    expect(holders).toContain('lambda/request-context.js')
    expect(holders).toEqual(files.filter((rel) => KIT_FILE.test(rel)))
  })

  it('SEC-21: every verifyToken( call and every authorizedParties value is the kit\'s AUTHORIZED_PARTIES, imported from ./request-context.js', () => {
    const problems = {}
    const callers = []
    for (const rel of files) {
      const r = parsed(rel, signInProblemsInJs(code(rel), { kit: KIT_FILE.test(rel) }))
      if (r.calls) callers.push(rel)
      if (r.problems.length) problems[rel] = r.problems
    }
    expect(callers).toContain('lambda/request-context.js')
    expect(callers.length).toBeGreaterThanOrEqual(24)
    expect(problems).toEqual({})
  })

  // The detectors themselves, so a green run above cannot be a blind one.
  it('SEC-21: the detectors find a planted list or a bare verifyToken( and ignore a commented one', () => {
    expect(allowListsInJs("verifyToken(t, { authorizedParties: ['https://x'] })")).toEqual(['authorizedParties array'])
    expect(allowListsInJs("const ORIGINS = ['https://garden.futureishere.net']")).toEqual(['origin https://garden.futureishere.net'])
    expect(allowListsInJs("// authorizedParties: ['https://staging.garden.futureishere.net']\nconst a = 1")).toEqual([])
    expect(signInProblemsInJs('verifyToken(token, { secretKey })', { kit: false }).problems)
      .toEqual(['verifyToken( without authorizedParties: AUTHORIZED_PARTIES'])
    expect(signInProblemsInJs("import { AUTHORIZED_PARTIES } from './request-context.js'\nawait verifyToken(t, { secretKey: k, authorizedParties: AUTHORIZED_PARTIES })", { kit: false }))
      .toEqual({ calls: 1, problems: [] })
    expect(signInProblemsInJs('const AUTHORIZED_PARTIES = x\nverifyToken(t, { authorizedParties: AUTHORIZED_PARTIES })', { kit: false }).problems)
      .toEqual(['declares its own AUTHORIZED_PARTIES', 'AUTHORIZED_PARTIES not imported from ./request-context.js'])
  })
})

// C4: a handler that refetched garden-app/secrets on a timer keeps that timer through the kit, so a rotated Neon or
// Clerk secret never strands a warm container.
const SECRETS_TTL = [
  ['lambda/photos/index.js', 5 * 60 * 1000],
  ['lambda/facebook-share/index.js', 5 * 60 * 1000],
]

// The secretsTtlMs value of every requestContext( call, folded from number literals, `*` and module constants.
function kitSecretsTtlInJs(code) {
  const ast = parseJs(code)
  if (!ast) return null
  const consts = new Map()
  const ttls = []
  eachNode(ast, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init) consts.set(n.id.name, n.init)
    if (n.type === 'CallExpression' && n.callee.name === 'requestContext') {
      const opts = n.arguments[1]
      const p = opts?.type === 'ObjectExpression' ? opts.properties.find((q) => q.type === 'Property' && keyName(q) === 'secretsTtlMs') : undefined
      ttls.push(p ? p.value : null)
    }
  })
  const value = (e) => {
    if (e?.type === 'Literal' && typeof e.value === 'number') return e.value
    if (e?.type === 'BinaryExpression' && e.operator === '*') return value(e.left) * value(e.right)
    if (e?.type === 'Identifier' && consts.has(e.name)) return value(consts.get(e.name))
    return undefined
  }
  return ttls.map(value)
}

describe('C4: a timed secrets refresh survives the sign-in kit', () => {
  it.each(SECRETS_TTL)('C4: %s passes the kit secretsTtlMs of %d ms', (rel, ms) => {
    expect(kitSecretsTtlInJs(readFileSync(join(ROOT, rel), 'utf8'))).toEqual([ms])
  })

  it('C4: the detector folds a named product and a literal, and reports a missing option', () => {
    expect(kitSecretsTtlInJs('const T = 5 * 60 * 1000\nawait requestContext(event, { resp, secretsTtlMs: T })')).toEqual([300000])
    expect(kitSecretsTtlInJs('await requestContext(event, { resp, secretsTtlMs: 300000 })')).toEqual([300000])
    expect(kitSecretsTtlInJs('await requestContext(event, { resp })')).toEqual([undefined])
  })
})
