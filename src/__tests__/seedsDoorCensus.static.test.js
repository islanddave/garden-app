// V5-SEEDSTAB-001 — the Seeds door census. Every in-app door into seed work now targets /seeds
// through src/lib/seedsRoutes.js. The three URLs the Seeds page took over — /sow, /seeds/saved and
// /inventory/add-seeds — survive only as route DECLARATIONS in App.jsx (the two REPLACE redirects and
// the add-seeds page), for bookmarks and restored tabs. This sweep fails the day any live source file
// names one of them as a navigation target again.
//
// WHY A PARSER AND NOT A GREP. Before this change there were TWELVE such targets across seven files
// (at 1408ca04: Inventory.jsx x3, SavedSeeds.jsx x2, InventoryDetail.jsx, SowNow.jsx, BottomNav.jsx
// x3, CultivationLead.jsx, SaveSeedSheet.jsx), in four shapes: a JSX `to=`, an object `to:`, a
// `navigate(...)` call, and — the one a context grep misses — a return leg URL-ENCODED inside another
// URL (`return=%2Fseeds%2Fsaved`). A line regex cannot see an encoded return leg, and cannot tell a
// comment from code without tokenising JSX, where one apostrophe in display text opens a "string"
// that swallows the rest of the file. So this parses with @babel/parser (the a11yProhibitedAttr.test.js
// idiom) and inspects every string and template literal; comments are never literals.
//
// THE RULE. A literal is a TARGET when it names a legacy path — as its own path (`/sow`, `/sow?x=1`,
// `/sow/`, `/sow${qs}`) or as a decoded query-parameter value inside it — unless it is a route
// DECLARATION: the value of a `path:` property or a `path=` JSX attribute. Declarations are pinned
// too, to exactly App.jsx's three, so a second registration of an old URL fails here as well.
//
// NON-VACUITY. The scanner is unit-tested below against synthetic sources: each historical shape must
// be flagged and each near-miss must not. The sweep must also SEE App.jsx's three declarations, so a
// walk that read nothing, or a parser that stopped yielding literals, fails loudly instead of reading
// green. Measured when this file was written: over the seven files as they stood at 1408ca04 the
// scanner reports all 12 targets, and over src/ on this branch it reports 0.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parse } from '@babel/parser'

// vitest rewrites import.meta.url to a server-root URL, so resolve off the project root instead.
const SRC = resolve(process.cwd(), 'src')
const LEGACY = ['/sow', '/seeds/saved', '/inventory/add-seeds']

// A template literal's ${…} is read as HOLE. A dynamic tail after a legacy path is still a legacy
// target, so HOLE counts as a path boundary; `/sowing` does not end at one, so it is not /sow.
const HOLE = String.fromCharCode(0)
const BOUNDARY = new Set(['?', '#', '/', HOLE])

function namesLegacyPath(s) {
  return LEGACY.some((p) => s.startsWith(p) && (s.length === p.length || BOUNDARY.has(s[p.length])))
}

function decode(s) {
  try { return decodeURIComponent(s) } catch { return s }
}

// The query-parameter values a URL-shaped literal carries, which is where a return leg lives.
function queryValues(s) {
  const q = s.indexOf('?')
  const query = q >= 0 ? s.slice(q + 1) : (/^[^\s/?#=]+=/.test(s) ? s : null)
  if (query == null) return []
  return [...new URLSearchParams(query.split('#')[0]).values()]
}

function namesLegacyTarget(value) {
  return [value, decode(value), ...queryValues(value).flatMap((v) => [v, decode(v)])].some(namesLegacyPath)
}

const keyName = (k) => (k?.type === 'Identifier' ? k.name : k?.type === 'StringLiteral' ? k.value : null)
const calleeName = (c) =>
  c?.type === 'Identifier' ? c.name : c?.type === 'MemberExpression' ? keyName(c.property) ?? '…' : '…'

// The JSX attribute a literal is the value of, bare (`to="/x"`) or braced (`to={'/x'}`).
function jsxAttrOf(parent, grand) {
  if (parent?.type === 'JSXAttribute') return parent
  if (parent?.type === 'JSXExpressionContainer' && grand?.type === 'JSXAttribute') return grand
  return null
}

function isDeclaration(parent, field, grand) {
  if (parent?.type === 'ObjectProperty' && field === 'value') return keyName(parent.key) === 'path'
  return jsxAttrOf(parent, grand)?.name?.name === 'path'
}

// For the failure message only — the verdict never depends on it.
function contextOf(parent, field, grand) {
  const attr = jsxAttrOf(parent, grand)
  if (attr) return `${attr.name?.name}=`
  if (parent?.type === 'ObjectProperty') return field === 'key' ? 'object key' : `${keyName(parent.key)}:`
  if (parent?.type === 'CallExpression' || parent?.type === 'NewExpression') return `${calleeName(parent.callee)}(`
  if (parent?.type === 'VariableDeclarator') return `${parent.id?.name ?? '…'} =`
  return parent?.type ?? '?'
}

// Every string/template literal naming a legacy path, classified. Throws on a parse failure — a file
// the census cannot read must fail it, never be skipped.
function findLegacyLiterals(code) {
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx'] })
  const hits = []
  const visit = (node, parent, field, grand) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach((n) => visit(n, parent, field, grand)); return }
    if (typeof node.type !== 'string') return
    const value = node.type === 'StringLiteral' ? node.value
      : node.type === 'TemplateLiteral' ? node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(HOLE)
      : null
    if (value != null && namesLegacyTarget(value)) {
      hits.push({
        line: node.loc.start.line,
        value,
        kind: isDeclaration(parent, field, grand) ? 'declaration' : 'target',
        context: contextOf(parent, field, grand),
      })
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k.endsWith('Comments')) continue
      visit(node[k], node, k, parent)
    }
  }
  visit(ast.program, null, null, null)
  return hits
}

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === '__mocks__' || name === 'node_modules') continue
      sourceFiles(p, out)
    } else if (/\.jsx?$/.test(name) && !/\.(test|spec)\.jsx?$/.test(name)) out.push(p)
  }
  return out
}

const targetsIn = (code) => findLegacyLiterals(code).filter((h) => h.kind === 'target')

describe('the scanner — every door shape that shipped before V5-SEEDSTAB-001 is flagged', () => {
  it.each([
    ['a JSX to= on a Link', '<Link to="/sow">Sow now</Link>', 'to='],
    ['a navigate() call', "navigate('/seeds/saved')", 'navigate('],
    ['an object to: property', "const a = { to: '/inventory/add-seeds' }", 'to:'],
    ['a SheetRowLink row (BottomNav.jsx:459)', '<SheetRowLink to="/seeds/saved" onClick={closeMore} style={menuRowStyle}>Saved seeds</SheetRowLink>', 'to='],
    ['a multi-line JSX to= (CultivationLead.jsx:112)', '<Link\n  to="/sow"\n  data-testid="cultivation-lead"\n>Sow now</Link>', 'to='],
    ['a return leg encoded inside another URL (SavedSeeds.jsx:189)', "const ADD_PACKET_HREF = '/inventory/add?type=consumable&category=seeds&return=%2Fseeds%2Fsaved'", 'ADD_PACKET_HREF ='],
    ['a navigate() with a dynamic tail', 'navigate(`/sow?lot=${id}`)', 'navigate('],
    ['a braced JSX href', "<a href={'/sow'}>Sow</a>", 'href='],
    ['an object-form Navigate target', "<Navigate to={{ pathname: '/seeds/saved', search }} />", 'pathname:'],
    ['a trailing slash', '<Link to="/sow/">Sow</Link>', 'to='],
  ])('%s', (_, code, context) => {
    const hits = targetsIn(code)
    expect(hits).toHaveLength(1)
    expect(hits[0].context).toBe(context)
  })
})

describe('the scanner — near misses are NOT targets', () => {
  it.each([
    ['a route declaration (path:)', "const r = { path: '/sow', element: null }"],
    ['a JSX route declaration (path=)', '<Route path="/seeds/saved" element={null} />'],
    ['a line comment', '// /sow\nconst x = 1'],
    ['a commented-out door', "/* <Link to=\"/sow\"> and navigate('/seeds/saved') */ const x = 1"],
    ['a longer path that only starts with the letters', "const a = '/sowing'"],
    ['the Seeds page itself', "const b = '/seeds'"],
    ['the new Sow now door', '<Link to="/seeds?view=sow">Sow now</Link>'],
    ['the sow-candidates API read', "fetch('/api/inventory-items/sow-candidates')"],
    ['the redirect view prop', '<LegacySeedsRedirect view="sow" />'],
    ['display text naming the old URL, apostrophe and all', "<p>Moved from /sow — it's Seeds now</p>"],
    ['a return leg into the new page', "const H = '/inventory/add?type=consumable&category=seeds&return=%2Fseeds%3Fview%3Dsaved'"],
  ])('%s', (_, code) => {
    expect(targetsIn(code)).toEqual([])
  })

  // The two declaration cases above pass by CLASSIFICATION, not by blindness: the scanner must still
  // see the literal. Without this, a scanner that saw nothing at all would pass the whole list.
  it('sees a route declaration and classifies it, rather than missing it', () => {
    expect(findLegacyLiterals("const r = { path: '/sow', element: null }")).toEqual([
      { line: 1, value: '/sow', kind: 'declaration', context: 'path:' },
    ])
    expect(findLegacyLiterals('<Route path="/seeds/saved" element={null} />')).toMatchObject([
      { value: '/seeds/saved', kind: 'declaration' },
    ])
  })
})

describe('the census — no live source file targets a URL the Seeds page replaced', () => {
  let memo
  const sweep = () => {
    if (!memo) {
      const files = sourceFiles(SRC)
      const hits = files.flatMap((f) =>
        findLegacyLiterals(readFileSync(f, 'utf8')).map((h) => ({ ...h, file: relative(SRC, f) })))
      memo = { files, hits }
    }
    return memo
  }

  it('reads the whole source tree (sanity floor: a walk that read nothing must not pass)', () => {
    const { files } = sweep()
    expect(files.length).toBeGreaterThan(300)
    expect(files.map((f) => relative(SRC, f))).toContain('App.jsx')
  })

  it('finds ZERO navigation targets naming /sow, /seeds/saved or /inventory/add-seeds', () => {
    const targets = sweep().hits
      .filter((h) => h.kind === 'target')
      .map((h) => `${h.file}:${h.line}  ${h.context} ${JSON.stringify(h.value)}`)
    expect(targets, 'retarget these through src/lib/seedsRoutes.js (seedsHref / addPacketHref)').toEqual([])
  })

  it("sees exactly App.jsx's three route declarations — the two redirects and the add-seeds page", () => {
    const declarations = sweep().hits
      .filter((h) => h.kind === 'declaration')
      .map((h) => `${h.file} ${h.value}`)
      .sort()
    expect(declarations).toEqual(['App.jsx /inventory/add-seeds', 'App.jsx /seeds/saved', 'App.jsx /sow'])
  })
})
