// Proves that an edit changed comments and nothing else. It refuses whatever it cannot prove.
//
//   node scripts/check-comment-only.mjs OLD NEW            compare two files
//   node scripts/check-comment-only.mjs --git REV PATH...  each PATH at REV against the working tree
//   node scripts/check-comment-only.mjs --report PATH...   per-file comment-hygiene counts (never refuses)
//   node scripts/check-comment-only.mjs --readers PATH     tests/scripts that read PATH as text
//
// Exit 0 only when every file is proven comment-only-changed; 1 on any refusal; 2 on usage errors or a
// missing tool. Per type:
//   JS/JSX/TS/TSX  @babel/parser ASTs with locations, comments and raw spellings removed. String, template
//                  and regex contents are code: a `--` inside a sql`` template is a code change.
//   YAML           parsed equality; each `run:` body goes through the shell comparator with ${{ }} masked.
//   shell          `shfmt --minify` output equality.
// A diff that adds, removes, moves or edits a directive comment (shebang, eslint-, @ts-, shellcheck...) is
// refused whatever the code says, because a directive changes behaviour without being code.
// Unknown types and unparseable files are refused; a missing shfmt aborts the run.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, extname, relative, resolve } from 'node:path'
import { parse } from '@babel/parser'
import yaml from 'js-yaml'

const PINNED_SHFMT = '3.14.1'
const JS_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'])
const YAML_EXT = new Set(['.yml', '.yaml'])
const SH_EXT = new Set(['.sh', '.bash'])

class Abort extends Error {}

// Comment text that is an instruction to a tool rather than prose. Anchored at the start of the comment
// body so ordinary prose that merely mentions a tool name stays editable. The /* global */ forms apply
// only to block comments (a `// global state ...` line is prose).
const DIRECTIVE_ANY =
  /^[\s*!#]*(?:eslint(?:[-\s]|$)|@ts-|@vite-|@vitest-|istanbul|v8 ignore|c8 ignore|shellcheck|noqa|pragma|@jsx|prettier-ignore|yamllint|@__PURE__|#__PURE__|@flow|@license|@preserve)/i
const DIRECTIVE_BLOCK = /^[\s*!]*(?:globals?\s|exported\b)/

const isDirective = (text, block) => DIRECTIVE_ANY.test(text) || (block && DIRECTIVE_BLOCK.test(text))

// ---------------------------------------------------------------------------------------------------
// Directive signatures. Each directive is keyed by its text plus the code it governs (the code on its own
// line when trailing, else the next line that has code), so deleting, editing or moving one all differ.

function directiveSignatures(codeLines, comments, text) {
  const sigs = []
  const firstLine = text.split('\n', 1)[0]
  if (firstLine.startsWith('#!')) sigs.push(`shebang@@${firstLine.trimEnd()}`)
  for (const c of comments) {
    if (!isDirective(c.text, c.block)) continue
    let ctx = codeLines[c.line].trim()
    if (!ctx) {
      for (let i = c.endLine + 1; i < codeLines.length; i++) {
        if (codeLines[i].trim()) {
          ctx = codeLines[i].trim()
          break
        }
      }
    }
    sigs.push(`${c.text.trim()}@@${ctx}`)
  }
  return sigs
}

// `#` comments for shell and YAML (and Python in report mode). Approximate: tracks quotes per line only.
// Good enough for directives and counts; code equality is proven by the real parsers, not by this.
function hashComments(text) {
  const comments = []
  const codeLines = []
  const lines = text.split('\n')
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    let q = ''
    let at = -1
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (q) {
        if (ch === '\\' && q === '"') i++
        else if (ch === q) q = ''
      } else if (ch === '"' || ch === "'") q = ch
      else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
        at = i
        break
      }
    }
    if (at >= 0) {
      comments.push({ text: line.slice(at + 1), line: li, endLine: li, block: false })
      codeLines.push(line.slice(0, at))
    } else codeLines.push(line)
  }
  return { comments, codeLines }
}

// ---------------------------------------------------------------------------------------------------
// JS / TS

const JS_CONFIGS = (ext) => {
  const configs = [['jsx', 'typescript']]
  // `<T>expr` casts only parse without the jsx plugin; .tsx and plain JS never need them.
  if (['.ts', '.mts', '.cts'].includes(ext)) configs.push(['typescript'])
  return configs
}

function parseJs(text, plugins) {
  const ast = parse(text, {
    sourceType: 'unambiguous',
    plugins,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    errorRecovery: false,
  })
  const lines = text.split('\n')
  const codeLines = lines.slice()
  const comments = []
  // Blank each comment out of codeLines (keeping newlines) so directives can find the code they govern.
  const offsets = []
  let off = 0
  for (const l of lines) {
    offsets.push(off)
    off += l.length + 1
  }
  const lineOf = (pos) => {
    let lo = 0
    let hi = offsets.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (offsets[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  for (const c of ast.comments || []) {
    const line = lineOf(c.start)
    const endLine = lineOf(Math.max(c.start, c.end - 1))
    comments.push({ text: c.value, line, endLine, block: c.type === 'CommentBlock' })
    for (let l = line; l <= endLine; l++) {
      const from = l === line ? c.start - offsets[l] : 0
      const to = l === endLine ? c.end - offsets[l] : lines[l].length
      codeLines[l] = codeLines[l].slice(0, from) + ' '.repeat(Math.max(0, to - from)) + codeLines[l].slice(to)
    }
  }
  return { ast, comments, codeLines }
}

const NOISE_KEYS = new Set([
  'start', 'end', 'loc', 'range', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'errors',
])

// React's JSX text cleaning (the same rule @babel/types' cleanJSXElementLiteralChild applies).
function cleanJsxText(value) {
  const lines = value.split(/\r\n|\n|\r/)
  let lastNonEmpty = 0
  for (let i = 0; i < lines.length; i++) if (/[^ \t]/.test(lines[i])) lastNonEmpty = i
  let str = ''
  for (let i = 0; i < lines.length; i++) {
    let t = lines[i].replace(/\t/g, ' ')
    if (i !== 0) t = t.replace(/^ +/, '')
    if (i !== lines.length - 1) t = t.replace(/ +$/, '')
    if (t) {
      if (i !== lastNonEmpty) t += ' '
      str += t
    }
  }
  return str
}

function normChildren(children) {
  const out = []
  for (const child of children) {
    if (child.type === 'JSXText') {
      const s = cleanJsxText(child.value)
      if (!s) continue
      const prev = out[out.length - 1]
      if (prev && prev.type === 'JSXText') prev.value += s
      else out.push({ type: 'JSXText', value: s })
    } else if (child.type === 'JSXExpressionContainer' && child.expression.type === 'JSXEmptyExpression') {
      continue
    } else out.push(strip(child))
  }
  return out
}

function strip(node) {
  if (Array.isArray(node)) return node.map(strip)
  if (node === null || typeof node !== 'object') return node
  const out = {}
  for (const [k, v] of Object.entries(node)) {
    if (NOISE_KEYS.has(k)) continue
    if (k === 'extra') {
      // Keep semantic flags (parenthesized); drop spellings and positions.
      const extra = {}
      for (const [ek, ev] of Object.entries(v)) {
        if (ek === 'raw' || ek === 'parenStart' || ek === 'trailingComma') continue
        extra[ek] = ev
      }
      if (Object.keys(extra).length) out.extra = extra
      continue
    }
    if (k === 'children' && (node.type === 'JSXElement' || node.type === 'JSXFragment')) {
      out.children = normChildren(v)
      continue
    }
    out[k] = strip(v)
  }
  return out
}

function firstDiff(a, b, path = '$') {
  if (a === b) return null
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return `${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array/object mismatch`
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length || i >= b.length) return `${path}[${i}]: ${i >= a.length ? 'added' : 'removed'} node`
      const d = firstDiff(a[i], b[i], `${path}[${i}]`)
      if (d) return d
    }
    return null
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in a) || !(k in b)) return `${path}.${k}: ${k in a ? 'removed' : 'added'}`
    const d = firstDiff(a[k], b[k], `${path}.${k}`)
    if (d) return d
  }
  return null
}

function compareJs(oldText, newText, ext) {
  let lastErr = null
  for (const plugins of JS_CONFIGS(ext)) {
    let o
    let n
    try {
      o = parseJs(oldText, plugins)
      n = parseJs(newText, plugins)
    } catch (e) {
      lastErr = e
      continue
    }
    const so = directiveSignatures(o.codeLines, o.comments, oldText)
    const sn = directiveSignatures(n.codeLines, n.comments, newText)
    if (JSON.stringify(so) !== JSON.stringify(sn)) return refuse(`directive comment changed: ${sigDiff(so, sn)}`)
    const ao = strip(o.ast.program)
    const an = strip(n.ast.program)
    const d = firstDiff(ao, an)
    if (d) return refuse(`code changed at ${d}`)
    return { ok: true }
  }
  return refuse(`cannot parse: ${lastErr ? lastErr.message : 'unknown error'}`)
}

// ---------------------------------------------------------------------------------------------------
// Shell

let shfmtChecked = false
function requireShfmt() {
  if (shfmtChecked) return
  const r = spawnSync('shfmt', ['--version'], { encoding: 'utf8' })
  if (r.error || r.status !== 0) {
    throw new Abort(`shfmt not found on PATH: shell and YAML run: comparison needs shfmt ${PINNED_SHFMT} (brew install shfmt)`)
  }
  const v = r.stdout.trim()
  if (v !== PINNED_SHFMT) process.stderr.write(`warning: shfmt ${v} found, comparator pinned to ${PINNED_SHFMT}\n`)
  shfmtChecked = true
}

function shfmtMinify(text) {
  requireShfmt()
  const r = spawnSync('shfmt', ['-ln=bash', '--minify'], { input: text, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) return { error: (r.stderr || 'shfmt failed').trim().split('\n')[0] }
  return { out: r.stdout }
}

function compareShell(oldText, newText) {
  const o = hashComments(oldText)
  const n = hashComments(newText)
  const so = directiveSignatures(o.codeLines, o.comments, oldText)
  const sn = directiveSignatures(n.codeLines, n.comments, newText)
  if (JSON.stringify(so) !== JSON.stringify(sn)) return refuse(`directive comment changed: ${sigDiff(so, sn)}`)
  const mo = shfmtMinify(oldText)
  const mn = shfmtMinify(newText)
  if (mo.error) return refuse(`cannot parse old shell: ${mo.error}`)
  if (mn.error) return refuse(`cannot parse new shell: ${mn.error}`)
  if (mo.out !== mn.out) return refuse(`code changed (shfmt --minify output differs)`)
  return { ok: true }
}

// ---------------------------------------------------------------------------------------------------
// YAML

// Each ${{ }} becomes a word keyed by its content, so an edited expression still differs while one that
// lives only in a removed comment line vanishes harmlessly.
function maskExpressions(s) {
  return s.replace(/\$\{\{([\s\S]*?)\}\}/g, (_m, inner) => {
    let h = 0
    for (const ch of inner.trim()) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    return `GHAEXPR${h.toString(16)}X${inner.trim().length}`
  })
}

const SHELLISH = /^(?:bash|sh)(?:\s|$)/

function yamlDiff(a, b, path) {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime() ? null : `${path}: date changed`
  }
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return a === b ? null : `${path}: value changed`
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: shape changed`
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}: list length changed`
    for (let i = 0; i < a.length; i++) {
      const d = yamlDiff(a[i], b[i], `${path}[${i}]`)
      if (d) return d
    }
    return null
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (JSON.stringify(ka) !== JSON.stringify(kb)) return `${path}: keys changed`
  for (const k of ka) {
    if (k === 'run' && typeof a.run === 'string' && typeof b.run === 'string') {
      const shell = a.shell === undefined ? 'bash' : String(a.shell)
      if (!SHELLISH.test(shell) || shell !== String(b.shell === undefined ? 'bash' : b.shell)) {
        // Not a shell body (python, pwsh, ...): no comparator for it, so it must be identical.
        if (a.run !== b.run) return `${path}.run: non-shell body changed`
        continue
      }
      const r = compareShell(maskExpressions(a.run), maskExpressions(b.run))
      if (!r.ok) return `${path}.run: ${r.reason}`
      continue
    }
    const d = yamlDiff(a[k], b[k], `${path}.${k}`)
    if (d) return d
  }
  return null
}

function compareYaml(oldText, newText) {
  let o
  let n
  try {
    o = yaml.loadAll(oldText)
    n = yaml.loadAll(newText)
  } catch (e) {
    return refuse(`cannot parse YAML: ${e.message.split('\n')[0]}`)
  }
  const co = hashComments(oldText)
  const cn = hashComments(newText)
  const so = directiveSignatures(co.codeLines, co.comments, oldText)
  const sn = directiveSignatures(cn.codeLines, cn.comments, newText)
  if (JSON.stringify(so) !== JSON.stringify(sn)) return refuse(`directive comment changed: ${sigDiff(so, sn)}`)
  const d = yamlDiff(o, n, '$')
  return d ? refuse(`code changed at ${d}`) : { ok: true }
}

// ---------------------------------------------------------------------------------------------------

function refuse(reason) {
  return { ok: false, reason }
}

function sigDiff(a, b) {
  const sa = new Set(a)
  const sb = new Set(b)
  const removed = a.find((s) => !sb.has(s))
  const added = b.find((s) => !sa.has(s))
  if (removed !== undefined) return `removed or moved "${removed}"`
  if (added !== undefined) return `added or moved "${added}"`
  return 'directive order changed'
}

export function compareFile(path, oldText, newText) {
  const ext = extname(path).toLowerCase()
  if (JS_EXT.has(ext)) return compareJs(oldText, newText, ext)
  if (YAML_EXT.has(ext)) return compareYaml(oldText, newText)
  if (SH_EXT.has(ext)) return compareShell(oldText, newText)
  return refuse(`unknown file type "${ext || basename(path)}" (fail closed)`)
}

// ---------------------------------------------------------------------------------------------------
// Report mode

const DATED = /20\d\d-\d\d-\d\d/
const TICKET = /[A-Z][A-Z0-9]+-[A-Z0-9]+-\d{3}/
const HISTORY = /\b(?:previously|used to|corrected)\b/i

function commentLines(path, text) {
  const ext = extname(path).toLowerCase()
  const out = [] // { text, block } where block groups consecutive comment lines
  if (JS_EXT.has(ext)) {
    let parsed = null
    for (const plugins of JS_CONFIGS(ext)) {
      try {
        parsed = parseJs(text, plugins)
        break
      } catch {
        /* try next config */
      }
    }
    if (!parsed) return null
    let group = -1
    let lastEnd = -2
    for (const c of parsed.comments) {
      const lines = c.text.split('\n')
      const ownLine = parsed.codeLines[c.line].trim() === ''
      if (!(ownLine && c.line === lastEnd + 1)) group++
      lines.forEach((l) => out.push({ text: l, group }))
      lastEnd = ownLine ? c.endLine : -2
    }
    return out
  }
  if (YAML_EXT.has(ext) || SH_EXT.has(ext) || ext === '.py') {
    const { comments, codeLines } = hashComments(text)
    let group = -1
    let lastEnd = -2
    for (const c of comments) {
      const ownLine = codeLines[c.line].trim() === ''
      if (!(ownLine && c.line === lastEnd + 1)) group++
      out.push({ text: c.text, group })
      lastEnd = ownLine ? c.line : -2
    }
    return out
  }
  return null
}

function reportFile(path) {
  const lines = commentLines(path, readFileSync(path, 'utf8'))
  if (!lines) return null
  const r = { comment: lines.length, dated: 0, ticket: 0, history: 0, flagged: 0, longBlocks: 0 }
  const size = new Map()
  for (const l of lines) {
    const d = DATED.test(l.text)
    const t = TICKET.test(l.text)
    const h = HISTORY.test(l.text)
    if (d) r.dated++
    if (t) r.ticket++
    if (h) r.history++
    if (d || t || h) r.flagged++
    size.set(l.group, (size.get(l.group) || 0) + 1)
  }
  for (const n of size.values()) if (n > 3) r.longBlocks++
  return r
}

function runReport(paths) {
  const total = { comment: 0, dated: 0, ticket: 0, history: 0, flagged: 0, longBlocks: 0 }
  console.log(['file', 'comment_lines', 'dated', 'ticket', 'history', 'flagged_lines', 'blocks_over_3'].join('\t'))
  for (const p of paths) {
    const r = reportFile(p)
    if (!r) {
      console.log(`${p}\t(skipped: unknown or unparseable type)`)
      continue
    }
    for (const k of Object.keys(total)) total[k] += r[k]
    console.log([p, r.comment, r.dated, r.ticket, r.history, r.flagged, r.longBlocks].join('\t'))
  }
  console.log(['TOTAL', total.comment, total.dated, total.ticket, total.history, total.flagged, total.longBlocks].join('\t'))
  return 0
}

// ---------------------------------------------------------------------------------------------------
// Reader index

const READ_MARK = /readFileSync|readFile\b|readFileAsync|read_text|read_bytes|\?raw|\bopen\(|\bcat\b|\bgrep\b|\brg\b|\bsed\b/
const READER_CANDIDATE =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|^scripts\/|^tests\/|^\.github\/|(?:^|\/)__tests__\/|(?:^|\/)test_[^/]*\.py$|_test\.py$|\.py$|\.sh$|\.mjs$)/
const NEAR = 8

function runReaders(target) {
  const base = basename(target)
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const self = relative(realpathSync(root), realpathSync(target))
  const files = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter((f) => f && f !== self && READER_CANDIDATE.test(f))
  const near = []
  const weak = []
  for (const f of files) {
    let text
    try {
      text = readFileSync(resolve(root, f), 'utf8')
    } catch {
      continue
    }
    if (!text.includes(base)) continue
    const lines = text.split('\n')
    let isNear = false
    for (let i = 0; i < lines.length && !isNear; i++) {
      if (!lines[i].includes(base)) continue
      for (let j = Math.max(0, i - NEAR); j <= Math.min(lines.length - 1, i + NEAR); j++) {
        if (READ_MARK.test(lines[j])) {
          isNear = true
          break
        }
      }
    }
    if (isNear) near.push(f)
    else if (READ_MARK.test(text)) weak.push(f)
  }
  for (const f of near) console.log(`near\t${f}`)
  for (const f of weak) console.log(`file\t${f}`)
  console.error(`${near.length} near, ${weak.length} file-level readers of ${base} (near = read call within ${NEAR} lines of the name; file = same file names it and reads something)`)
  return 0
}

// ---------------------------------------------------------------------------------------------------
// CLI

function runPairs(pairs) {
  let bad = 0
  for (const { label, path, oldText, newText } of pairs) {
    let r
    if (oldText === null || newText === null) r = refuse(oldText === null ? 'file absent in old version (added)' : 'file absent in new version (deleted)')
    else r = compareFile(path, oldText, newText)
    console.log(r.ok ? `OK      ${label}` : `REFUSE  ${label}: ${r.reason}`)
    if (!r.ok) bad++
  }
  console.log(`${pairs.length - bad} proven comment-only, ${bad} refused`)
  return bad ? 1 : 0
}

function main(argv) {
  const usage = 'usage: check-comment-only.mjs OLD NEW | --git REV PATH... | --report PATH... | --readers PATH'
  if (argv[0] === '--report') return argv.length > 1 ? runReport(argv.slice(1)) : (console.error(usage), 2)
  if (argv[0] === '--readers') return argv.length === 2 ? runReaders(argv[1]) : (console.error(usage), 2)
  if (argv[0] === '--git') {
    if (argv.length < 3) return console.error(usage), 2
    const rev = argv[1]
    const pairs = argv.slice(2).map((p) => {
      const rel = relative(process.cwd(), resolve(p))
      let oldText = null
      try {
        oldText = execFileSync('git', ['show', `${rev}:./${rel}`], {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      } catch {
        /* absent at rev */
      }
      let newText = null
      try {
        newText = readFileSync(p, 'utf8')
      } catch {
        /* deleted in working tree */
      }
      return { label: p, path: p, oldText, newText }
    })
    return runPairs(pairs)
  }
  if (argv.length === 2 && !argv[0].startsWith('--')) {
    if (extname(argv[0]).toLowerCase() !== extname(argv[1]).toLowerCase()) {
      console.error('OLD and NEW must have the same extension')
      return 2
    }
    const read = (p) => readFileSync(p, 'utf8')
    return runPairs([{ label: argv[1], path: argv[1], oldText: read(argv[0]), newText: read(argv[1]) }])
  }
  console.error(usage)
  return 2
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    if (e instanceof Abort) {
      console.error(`ABORT: ${e.message}`)
      process.exitCode = 2
    } else throw e
  }
}
