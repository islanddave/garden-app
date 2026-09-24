// V5-NAVCUSTOM-001 — I6 (design §8: "an old client ignores the new prefs fields"), as a STATIC scan.
//
// WHY STATIC. PATCH /api/notifications/prefs merges column by column with COALESCE: a key a request
// does not carry is left alone. That is what keeps Dave's pins and bar safe from every OTHER save —
// an old bundle's, and this bundle's — but only while every writer sends a body it names key by key.
// A writer that spread a prefs object into its body (`{ ...prefs, garden_group_by }`) would carry a
// read copy of more_pins / bar_layout along with it and could write an older list back over a newer
// one. The first I6 test called ten hand-listed writers with fixed arguments, so none of them was ever
// HANDED a prefs object: the mutation it named could not happen without a signature change, a new
// writer was not covered at all, and a PATCH from another file was invisible (QA MINOR-4). This scan
// reads the source instead, and enumerates the writers itself.
//
// Three properties, each with the mutation that reds it (all run):
//   1. The prefs route is spelled in CODE in exactly one file, the client. Comments do not count (the
//      AST has none). KILLING MUTATION: a fetch/apiFetch of '/api/notifications/prefs' anywhere else.
//   2. Every exported save*/patch* writer is found automatically — cross-checked against the module's
//      real exports — and every body it sends is a FLAT object literal: named keys, no spread, and no
//      new-field key unless the writer is that field's own writer. KILLING MUTATIONS: spread a prefs
//      object into a body; add `export async function saveAll({ prefs })` that stringifies it.
//   3. Nothing in the client merges objects: no object spread, no Object.assign. KILLING MUTATION:
//      `JSON.stringify(Object.assign({}, prefs, { x }))`.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as acorn from 'acorn'
import acornJsx from 'acorn-jsx'

const Parser = acorn.Parser.extend(acornJsx())
const SRC = join(process.cwd(), 'src')
const CLIENT = 'lib/notificationPrefsClient.js'
const ROUTE = 'notifications/prefs'
// The fields this release added, and the one writer allowed to name each.
const NEW_FIELDS = { more_pins: 'saveMorePins', bar_layout: 'saveBarLayout', can_edit_bar: null }
// The one non-exported helper allowed to stringify a PARAMETER; its call sites are checked instead.
const SENDING_HELPERS = ['patchPrefsReported']

const parse = (code) => Parser.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true })

// Shipping source only: __tests__ and the few colocated *.test.js files may spell the route in a stub.
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(jsx?|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(full)
  }
  return out
}

function visit(node, fn, parent = null) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) visit(n, fn, parent); return }
  if (typeof node.type !== 'string') return
  fn(node, parent)
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue
    visit(node[key], fn, node)
  }
}

const isStringify = (n) => n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
  n.callee.object.name === 'JSON' && n.callee.property.name === 'stringify'
const isCallTo = (n, name) => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === name

// A FLAT body: an object literal whose every property is a plain, non-computed key — no spread.
// Returns the keys, or null when the literal is not flat.
function flatKeys(obj) {
  if (!obj || obj.type !== 'ObjectExpression') return null
  const keys = []
  for (const p of obj.properties) {
    if (p.type !== 'Property' || p.computed) return null
    keys.push(p.key.type === 'Identifier' ? p.key.name : String(p.key.value))
  }
  return keys
}

// The body a writer hands to JSON.stringify / patchPrefsReported, resolved to its keys. An identifier
// counts only if it is declared in the SAME function as a flat literal and afterwards only ever
// written through `name.key = …` (patchNotificationPrefs builds its body that way).
function bodyKeys(arg, fnNode) {
  if (arg.type === 'ObjectExpression') return flatKeys(arg)
  if (arg.type !== 'Identifier') return null
  let init = null
  const extra = []
  let unsafe = false
  visit(fnNode.body, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === arg.name) init = n.init
    if (n.type === 'AssignmentExpression') {
      const t = n.left
      if (t.type === 'Identifier' && t.name === arg.name) unsafe = true
      if (t.type === 'MemberExpression' && t.object.type === 'Identifier' && t.object.name === arg.name) {
        if (t.computed) unsafe = true
        else extra.push(t.property.name)
      }
    }
  })
  const keys = flatKeys(init)
  return keys && !unsafe ? [...keys, ...extra] : null
}

const clientSrc = readFileSync(join(SRC, CLIENT), 'utf8')
const clientAst = parse(clientSrc)

// Every exported writer, as declared: `export (async) function saveX` or `export const saveX = …`.
function exportedWriters() {
  const out = new Map()
  for (const node of clientAst.body) {
    if (node.type !== 'ExportNamedDeclaration' || !node.declaration) continue
    const d = node.declaration
    if (d.type === 'FunctionDeclaration' && /^(save|patch)/.test(d.id.name)) out.set(d.id.name, d)
    if (d.type === 'VariableDeclaration') {
      for (const v of d.declarations) {
        if (v.id.type === 'Identifier' && /^(save|patch)/.test(v.id.name)) out.set(v.id.name, v.init)
      }
    }
  }
  return out
}

describe('I6 — the prefs route has one writer module, and every body it sends is flat', () => {
  it('1. /api/notifications/prefs appears in CODE in exactly one file: the client', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(100)                   // the walk found the tree
    const spelling = new Set()
    for (const f of files) {
      const ast = parse(readFileSync(f, 'utf8'))
      visit(ast, (n) => {
        const text = n.type === 'Literal' && typeof n.value === 'string' ? n.value
          : n.type === 'TemplateElement' ? (n.value.cooked ?? n.value.raw) : null
        if (text && text.includes(ROUTE)) spelling.add(relative(SRC, f))
      })
    }
    expect([...spelling]).toEqual([CLIENT])
  })

  it('2. the writers are enumerated from the source AND match the module’s real exports', async () => {
    const found = [...exportedWriters().keys()].sort()
    const mod = await import('../lib/notificationPrefsClient.js')
    const real = Object.keys(mod).filter(k => /^(save|patch)/.test(k) && typeof mod[k] === 'function').sort()
    // A writer the scan cannot see is a writer it cannot vouch for.
    expect(found).toEqual(real)
    // Anti-vacuity: the known writers, by name.
    expect(found).toEqual(expect.arrayContaining([
      'saveMorePins', 'saveBarLayout', 'saveGardenGroupBy', 'saveTodaySkipped', 'saveWhatsNewSeen',
      'saveHandedness', 'patchNotificationPrefs',
    ]))
    expect(found.length).toBeGreaterThanOrEqual(12)
  })

  it('2. every body every writer sends is a flat literal, and only a field’s own writer names it', () => {
    const helperBodies = new Map()
    for (const [name, fn] of exportedWriters()) {
      const bodies = []
      visit(fn.body, (n) => {
        if (isStringify(n)) bodies.push(n.arguments[0])
        for (const h of SENDING_HELPERS) if (isCallTo(n, h)) bodies.push(n.arguments[1])
      })
      // Every writer sends SOMETHING the scan can read — a writer routed through an unknown helper
      // would otherwise pass by sending nothing visible.
      expect(bodies.length, `${name} sends no body this scan can read`).toBeGreaterThan(0)
      for (const b of bodies) {
        const keys = b ? bodyKeys(b, fn) : null
        expect(keys, `${name} sends a body that is not a flat object literal`).not.toBeNull()
        for (const k of keys) {
          if (Object.hasOwn(NEW_FIELDS, k)) {
            expect(NEW_FIELDS[k], `${name} names ${k}, which only ${NEW_FIELDS[k] ?? 'the server'} may`).toBe(name)
          }
        }
        helperBodies.set(name, keys)
      }
    }
    expect(helperBodies.get('saveMorePins')).toEqual(['more_pins'])
    expect(helperBodies.get('saveBarLayout')).toEqual(['bar_layout'])
  })

  it('2. the only function that stringifies a PARAMETER is the checked sending helper', () => {
    const offenders = []
    visit(clientAst, (n) => {
      if (!/Function/.test(n.type)) return
      const params = new Set(n.params.filter(p => p.type === 'Identifier').map(p => p.name))
      const name = n.id?.name ?? '(anonymous)'
      visit(n.body, (m) => {
        if (isStringify(m) && m.arguments[0]?.type === 'Identifier' && params.has(m.arguments[0].name) &&
          !SENDING_HELPERS.includes(name)) offenders.push(name)
      })
    })
    expect(offenders).toEqual([])
  })

  it('3. nothing in the client merges objects: no object spread, no Object.assign', () => {
    const merges = []
    visit(clientAst, (n) => {
      if (n.type === 'SpreadElement') merges.push(`spread @${n.start}`)
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
        n.callee.object.name === 'Object' && n.callee.property.name === 'assign') merges.push(`Object.assign @${n.start}`)
    })
    expect(merges).toEqual([])
  })

  // The scanners must be able to fail, or every assertion above is vacuous.
  it('SELF-TEST: the scanners flag a spread body, a merged body and a non-flat identifier', () => {
    const fn = parse('function w(prefs){ const b = {}; b[k] = 1; return JSON.stringify(b) }').body[0]
    expect(bodyKeys(parse('({ ...prefs, a: 1 })').body[0].expression, fn)).toBeNull()
    expect(bodyKeys(fn.body.body.at(-1).argument.arguments[0], fn)).toBeNull()     // computed write
    const ok = parse('function w(){ const b = {}; b.a = 1; return JSON.stringify(b) }').body[0]
    expect(bodyKeys(ok.body.body.at(-1).argument.arguments[0], ok)).toEqual(['a'])
    let spreads = 0
    visit(parse('const x = { ...y }'), (n) => { if (n.type === 'SpreadElement') spreads++ })
    expect(spreads).toBe(1)
  })
})
