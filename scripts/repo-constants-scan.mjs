#!/usr/bin/env node
// Repo-constant scanners behind three static tests (V5-SITECONSTANTS-001, multi-space Phase 1 steps 1.4, 1.13,
// 1.14). The tests hold the allowlists; this module only finds things, so a test and the printer below can never
// disagree about what was found.
//
//   lambda/site-constants.static.test.js        1.4  site constants (pinned file+identifier) and the nil UUID
//   lambda/public-repo-literals.static.test.js  1.13 no MAC address / precise lat-lng in the new public dirs
//   lambda/dave-constants.static.test.js        1.14 the Dave-constant ratchet (per-file counts, shrinking only)
//
// REGENERATING AN ALLOWLIST. After a rebase or a removal, print what the tree holds now:
//
//   node scripts/repo-constants-scan.mjs            # both inventories, paste-ready
//   node scripts/repo-constants-scan.mjs site       # 1.4 only
//   node scripts/repo-constants-scan.mjs dave       # 1.14 only
//   node scripts/repo-constants-scan.mjs public tests/harness …   # 1.13 counts over the dirs given
//
// and paste the block over the test's list. The 1.14 list may only shrink: if the printout has a file or a count
// the current list does not, that is new Dave-specific code, not a list to update. The printer cannot know a
// `reason`; carry any `reason` field over by hand.
//
// WHAT "NON-TEST" MEANS here (isTestPath): a *.test.* / *.spec.* file, anything under __tests__/, __mocks__/,
// __fixtures__/ or fixtures/, and Python test_*.py / *_test.py / conftest.py. Walks read tracked files only
// (`git ls-files`, see walk) and skip node_modules, .git, dist, coverage and Python caches.
//
// HOW JS IS READ. .js/.jsx/.mjs/.cjs files are parsed with acorn + acorn-jsx (transitive dependencies, as in
// lambda/lambda-source-parses.test.js and src/__tests__/clientRouteLambdaContract.test.js) and only string
// literals, template text, JSX text and identifiers are looked at, so a comment never counts. A file acorn cannot
// parse, and every other text file (.sh, .py, .sql, .ts, .json, ...), falls back to the TEXT RULE: whole-line
// comments (`#` for sh/py, `//` and `/* */` lines for ts, `--` for sql) are dropped, then the line is matched.
// The text rule's reader shapes are listed at READER_TEXT below.
import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, relative, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as acorn from 'acorn'
import acornJsx from 'acorn-jsx'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const Parser = acorn.Parser.extend(acornJsx())

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '__pycache__', '.pytest_cache', '.venv', 'venv'])
const JS_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs'])
const TEXT_EXT = new Set([...JS_EXT, '.ts', '.tsx', '.json', '.sh', '.bash', '.py', '.sql', '.yml', '.yaml', '.txt',
  '.html', '.css', '.csv', '.toml', '.ini', '.env', '.md'])

// The UUIDs are built, not written, so this file holds neither literal it hunts for.
const UUID_BODY = '00000000-0000-0000-0000-00000000000'
export const SENTINEL_UUID = `${UUID_BODY}1`
export const NIL_UUID = `${UUID_BODY}0`

export function isTestPath(rel) {
  const base = rel.split('/').pop()
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true
  if (/^test_.*\.py$|_test\.py$|^conftest\.py$/.test(base)) return true
  return /(^|\/)(__tests__|__mocks__|__fixtures__|fixtures)\//.test(rel)
}

// The top of the git work tree `root` is, or null when root is not one (a planted fixture tree under tmpdir).
function gitTop(root) {
  try {
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return realpathSync(top) === realpathSync(root) ? top : null
  } catch {
    return null
  }
}

// Every file under each root (repo-relative, forward slashes). A missing root yields nothing, not an error.
// In a git work tree this is the TRACKED files (`git ls-files`, as scripts/test_check_lambda_config.py reads), so an
// untracked scratch file or a gitignored recorder dump (tests/harness/_todaymeasure/out/raw) reds neither locally
// nor differently from CI's clean checkout. A root that is not the top of a work tree (the planted fixture trees the
// tests build under tmpdir) is walked on the filesystem.
export function walk(roots, { root = ROOT, textOnly = true } = {}) {
  if (gitTop(root)) {
    const listed = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', ...roots], { encoding: 'utf8', maxBuffer: 64 << 20 })
    return listed.split('\0').filter((rel) => rel
      && !rel.split('/').some((seg) => SKIP_DIRS.has(seg))
      && (!textOnly || TEXT_EXT.has(extname(rel)))
      && existsSync(join(root, rel))).sort()
  }
  const out = []
  const visit = (abs) => {
    for (const entry of readdirSync(abs)) {
      if (SKIP_DIRS.has(entry)) continue
      const p = join(abs, entry)
      const st = statSync(p)
      if (st.isDirectory()) visit(p)
      else if (!textOnly || TEXT_EXT.has(extname(entry))) out.push(relative(root, p).split('\\').join('/'))
    }
  }
  for (const r of roots) {
    const abs = join(root, r)
    if (!existsSync(abs)) continue
    if (statSync(abs).isDirectory()) visit(abs)
    else out.push(relative(root, abs).split('\\').join('/'))
  }
  return out.sort()
}

export function parseJs(code) {
  try {
    return Parser.parse(code, {
      ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowHashBang: true,
      allowAwaitOutsideFunction: true, allowImportExportEverywhere: true,
    })
  } catch {
    return null
  }
}

// Depth-first over every ESTree node (acorn-walk does not know the JSX node types).
export function eachNode(node, fn, parent = null) {
  if (!node || typeof node.type !== 'string') return
  fn(node, parent)
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue
    const v = node[key]
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') eachNode(c, fn, node) }
    else if (v && typeof v.type === 'string') eachNode(v, fn, node)
  }
}

// The text of every string the program carries: string literals, template chunks, JSX text.
function stringsOf(ast) {
  const out = []
  eachNode(ast, (n) => {
    if (n.type === 'Literal' && typeof n.value === 'string') out.push(n.value)
    else if (n.type === 'TemplateElement') out.push(n.value.raw)
    else if (n.type === 'JSXText') out.push(n.value)
  })
  return out
}

const countIn = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0)

// Text rule: drop whole-line comments for the file's language.
export function codeLines(rel, text) {
  const ext = extname(rel)
  const hash = ['.sh', '.bash', '.py', '.yml', '.yaml', '.toml', '.ini', '.env'].includes(ext) || !ext
  const slash = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext)
  let inBlock = false
  return text.split('\n').filter((line) => {
    const t = line.trim()
    if (slash) {
      if (inBlock) { if (t.includes('*/')) inBlock = false; return false }
      if (t.startsWith('/*')) { inBlock = !t.includes('*/'); return false }
      if (t.startsWith('//') || t.startsWith('*')) return false
    }
    if (hash && t.startsWith('#') && !t.startsWith('#!')) return false
    if (ext === '.sql' && t.startsWith('--')) return false
    return true
  })
}

// ---------------------------------------------------------------- 1.4 site constants

// A declaration is a SITE CONSTANT when its name says so, or its initialiser names the site.
// Name: SITE_*, *_LAT / *_LNG / *_LON / *_LATITUDE / *_LONGITUDE (or exactly those), FIRST_FALL_FROST /
// LAST_SPRING_FROST anywhere, FROST_ANCHORS, *FROST_WINDOW*. Content: a string in the initialiser naming the town
// or the hardiness zone. JSON: a key named site_*, lat/lng/lon (or *_lat ...), or measured_basis.
export const SITE_NAME = /^SITE_|(^|_)(LAT|LNG|LON|LATITUDE|LONGITUDE)$|FIRST_FALL_FROST|LAST_SPRING_FROST|^FROST_ANCHORS$|FROST_WINDOW/
export const SITE_TEXT = /South Deerfield|Zone 6a/i
export const SITE_JSON_KEY = /^site_|(^|_)(lat|lng|lon|latitude|longitude)$|^measured_basis$/

export function siteConstantsInJs(code) {
  const ast = parseJs(code)
  if (!ast) return null
  const found = new Set()
  eachNode(ast, (n) => {
    if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier') return
    const name = n.id.name
    if (SITE_NAME.test(name)) { found.add(name); return }
    if (n.init && stringsOf(n.init).some((s) => SITE_TEXT.test(s))) found.add(name)
  })
  return [...found]
}

export function siteKeysInJson(text) {
  const found = new Set()
  const visit = (v) => {
    if (Array.isArray(v)) v.forEach(visit)
    else if (v && typeof v === 'object') for (const [k, c] of Object.entries(v)) { if (SITE_JSON_KEY.test(k)) found.add(k); visit(c) }
  }
  visit(JSON.parse(text))
  return [...found]
}

// [{ file, identifier }] over non-test lambda/** and src/**, sorted.
export function scanSiteConstants({ root = ROOT } = {}) {
  const out = []
  for (const rel of walk(['lambda', 'src'], { root })) {
    if (isTestPath(rel)) continue
    const ext = extname(rel)
    if (!JS_EXT.has(ext) && ext !== '.json') continue
    const text = readFileSync(join(root, rel), 'utf8')
    let names
    if (ext === '.json') names = siteKeysInJson(text)
    else {
      names = siteConstantsInJs(text)
      if (names === null) throw new Error(`${rel}: acorn could not parse it (lambda-source-parses / the build should say why)`)
    }
    for (const identifier of names) out.push({ file: rel, identifier })
  }
  return out.sort((a, b) => (a.file + a.identifier).localeCompare(b.file + b.identifier))
}

// { rel: count } of the nil UUID, text count (comments included), non-test lambda/src/scripts.
export function scanNilUuid({ root = ROOT } = {}) {
  const out = {}
  for (const rel of walk(['lambda', 'src', 'scripts'], { root })) {
    if (isTestPath(rel)) continue
    const n = countIn(readFileSync(join(root, rel), 'utf8'), NIL_UUID)
    if (n) out[rel] = n
  }
  return out
}

// ---------------------------------------------------------------- 1.13 public-repo literals

// MAC: six hex pairs joined by ':' or '-' (one separator throughout), or the dotted xxxx.xxxx.xxxx form.
export const MAC = /(?<![0-9A-Fa-f:-])[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:-])|(?<![\w.])[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}(?![\w.])/g
// Lat/lng: a decimal with 4+ fractional digits and magnitude 1..180 (a tolerance like 0.0001 is not a place).
// Not after `<digit>:`, so the seconds of a timestamp (`05:22:01.245082`) are not a coordinate.
const DECIMAL4 = /(?<![\w.]|\d:)-?\d{1,3}\.\d{4,}(?![\w.])/g

// sha256 (hex) of a finding's literal: how a list of known findings names one without repeating it. It keeps the
// literal out of the list and out of a failure message; it is NOT secrecy (a 4-decimal coordinate or a MAC under a
// known vendor prefix can be brute-forced from its hash), and need not be: a pinned literal is already in the
// scanned file.
export const literalHash = (s) => createHash('sha256').update(s).digest('hex')

// [{ file, line, kind: 'mac' | 'latlng', literal, hash }] for one file's text.
export function publicLiteralFindings(rel, text) {
  const out = []
  const hit = (i, kind, literal) => out.push({ file: rel, line: i + 1, kind, literal, hash: literalHash(literal) })
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(MAC)) hit(i, 'mac', m[0])
    for (const m of line.matchAll(DECIMAL4)) {
      const v = Math.abs(Number(m[0]))
      if (v >= 1 && v <= 180) hit(i, 'latlng', m[0])
    }
  })
  return out
}

export function scanPublicLiterals(dirs, { root = ROOT } = {}) {
  const files = walk(dirs, { root })
  const findings = files.flatMap((rel) => publicLiteralFindings(rel, readFileSync(join(root, rel), 'utf8')))
  return { files, findings }
}

// { rel: { mac: [hash…], latlng: [hash…] } }, each list distinct and sorted: the shape a known-findings list pins.
export function pinPublicFindings(findings) {
  const out = {}
  for (const { file, kind, hash } of findings) {
    out[file] ??= {}
    out[file][kind] ??= []
    if (!out[file][kind].includes(hash)) out[file][kind].push(hash)
  }
  for (const kinds of Object.values(out)) for (const list of Object.values(kinds)) list.sort()
  return out
}

// ---------------------------------------------------------------- 1.14 Dave constants

// Kinds counted per file. `literal` = the sentinel UUID inside a string; `SENTINEL_WORKSPACE` = the identifier;
// the two env names count READERS only (see isEnvLike / READER_TEXT), never a mention.
export const ENV_READ_NAMES = ['GARDEN_HOUSEHOLD_IDS', 'OWNER_FALLBACK_SUB']
export const KINDS = ['literal', 'SENTINEL_WORKSPACE', ...ENV_READ_NAMES]

// `process.env`, an identifier `env` / `ENV` / `environ`, or any `<x>.env` / `<x>.Variables` (Lambda config maps).
function isEnvLike(n) {
  if (!n) return false
  if (n.type === 'Identifier') return /^(env|ENV|environ|environment)$/.test(n.name)
  if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') {
    return /^(env|Variables)$/.test(n.property.name)
  }
  return false
}
const propName = (m) => (m.computed
  ? (m.property.type === 'Literal' && typeof m.property.value === 'string' ? m.property.value : null)
  : m.property.name)

function daveCountsInJs(code) {
  const ast = parseJs(code)
  if (!ast) return null
  const c = Object.fromEntries(KINDS.map((k) => [k, 0]))
  for (const s of stringsOf(ast)) c.literal += countIn(s, SENTINEL_UUID)
  eachNode(ast, (n) => {
    if (n.type === 'Identifier' && n.name === 'SENTINEL_WORKSPACE') c['SENTINEL_WORKSPACE']++
    if (n.type === 'MemberExpression' && isEnvLike(n.object) && ENV_READ_NAMES.includes(propName(n))) c[propName(n)]++
    // const { GARDEN_HOUSEHOLD_IDS } = process.env
    if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern' && isEnvLike(n.init)) {
      for (const p of n.id.properties) {
        const k = p.type === 'Property' && (p.key.type === 'Identifier' ? p.key.name : p.key.value)
        if (ENV_READ_NAMES.includes(k)) c[k]++
      }
    }
    // 'X' in process.env
    if (n.type === 'BinaryExpression' && n.operator === 'in' && isEnvLike(n.right)
      && n.left.type === 'Literal' && ENV_READ_NAMES.includes(n.left.value)) c[n.left.value]++
  })
  return c
}

// Text-rule reader shapes: shell `$X` / `${X…}`; Python `os.environ['X']`, `environ.get('X'`, `os.getenv('X'`;
// and the JS shapes `process.env.X`, `env.X`, `env['X']` for files acorn does not read.
const READER_TEXT = (x) => new RegExp(
  `\\$\\{?${x}\\b|environ(?:\\.get\\(\\s*|\\[\\s*)['"]${x}['"]|getenv\\(\\s*['"]${x}['"]|\\benv(?:\\.${x}\\b|\\[\\s*['"]${x}['"])`, 'g')

function daveCountsInText(rel, text) {
  const c = Object.fromEntries(KINDS.map((k) => [k, 0]))
  for (const line of codeLines(rel, text)) {
    c.literal += countIn(line, SENTINEL_UUID)
    c['SENTINEL_WORKSPACE'] += (line.match(/\bSENTINEL_WORKSPACE\b/g) || []).length
    for (const x of ENV_READ_NAMES) c[x] += (line.match(READER_TEXT(x)) || []).length
  }
  return c
}

export function daveCounts(rel, text) {
  if (JS_EXT.has(extname(rel))) {
    const c = daveCountsInJs(text)
    if (c) return c
  }
  return daveCountsInText(rel, text)
}

// scripts/space-harness/** (step 1.12's harness) drives a whole Space on throwaway branches, so it may read the
// household env and name the sentinel workspace; it may NOT carry the sentinel literal (sheet §3R: read it from
// the DB), so `literal` is still counted there.
export const HARNESS_DIR = 'scripts/space-harness/'
export const HARNESS_EXEMPT_KINDS = ['SENTINEL_WORKSPACE', ...ENV_READ_NAMES]

// { rel: { kind: count } } over non-test lambda/src/scripts; zero kinds and zero files are left out.
export function scanDaveConstants({ root = ROOT } = {}) {
  const needles = [SENTINEL_UUID, 'SENTINEL_WORKSPACE', ...ENV_READ_NAMES]
  const out = {}
  for (const rel of walk(['lambda', 'src', 'scripts'], { root })) {
    if (isTestPath(rel) || extname(rel) === '.md') continue
    const text = readFileSync(join(root, rel), 'utf8')
    if (!needles.some((s) => text.includes(s))) continue
    const c = daveCounts(rel, text)
    if (rel.startsWith(HARNESS_DIR)) for (const k of HARNESS_EXEMPT_KINDS) c[k] = 0
    const kept = Object.fromEntries(Object.entries(c).filter(([, v]) => v > 0))
    if (Object.keys(kept).length) out[rel] = kept
  }
  return out
}

// ---------------------------------------------------------------- printer

function printSite() {
  console.log('// 1.4 SITE_CONSTANTS (lambda/site-constants.static.test.js)')
  for (const { file, identifier } of scanSiteConstants()) console.log(`  ['${file}', '${identifier}'],`)
  const nil = scanNilUuid()
  console.log(`// nil UUID in non-test lambda/src/scripts: ${Object.keys(nil).length ? JSON.stringify(nil) : 'none (baseline 0)'}`)
}

function printDave() {
  console.log('// 1.14 DAVE_CONSTANTS (lambda/dave-constants.static.test.js); carry `reason` fields over by hand')
  for (const [file, counts] of Object.entries(scanDaveConstants())) {
    const body = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ')
    console.log(`  '${file}': { ${body} },`)
  }
}

// The 1.13 directory list lives in its test; the printer takes it as arguments.
function printPublic(dirs) {
  console.log('// 1.13 KNOWN_AT_BASE sha256 pins (lambda/public-repo-literals.static.test.js); carry `reason` over by hand')
  for (const [file, kinds] of Object.entries(pinPublicFindings(scanPublicLiterals(dirs).findings))) {
    console.log(`  '${file}': {`)
    for (const [kind, hashes] of Object.entries(kinds)) {
      console.log(`    ${kind}: [\n${hashes.map((h) => `      '${h}',`).join('\n')}\n    ],`)
    }
    console.log('  },')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const what = process.argv[2]
  if (!what || what === 'site') printSite()
  if (!what || what === 'dave') printDave()
  if (what === 'public') printPublic(process.argv.slice(3))
}
