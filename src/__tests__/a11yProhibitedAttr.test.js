// V4-A11YGATE-001 — LAYER 1 of the a11y gate: repo-wide static sweep for the WATERWHY class.
//
// Layer 2 (a11yGate.test.jsx) runs axe over RENDERED components, which is the truthful check but
// only ever covers what that file bothers to render. This layer covers all ~480 source files
// including every page nobody renders in isolation, for one rule and one rule only:
// aria-prohibited-attr — an aria-label/aria-labelledby hung on an element whose role cannot carry a
// name, so the label is silently discarded. That is the exact defect V4-WATERWHY-002 shipped to dev.
//
// It is NOT a hand-maintained truth table. The parser only *nominates* candidates; axe-core itself
// decides, by rendering each candidate into a synthetic DOM node and running the real rule over it.
// So the pass/fail line here can never drift from the pass/fail line in Layer 2.
//
// KNOWN LIMITS, stated so nobody over-reads a green run:
//   - `role={expr}` and `{...spread}` are EXEMPT: a runtime role is unknowable statically. PhotoImg
//     is the one such site (role and aria-label share a single condition, verified by hand and
//     covered by Layer 2).
//   - The synthetic node reproduces tag + explicit role + "has text content?", not the real ancestor
//     chain. Tags whose implicit role depends on a parent (li/td/th/tr/option/svg children) get that
//     parent rebuilt; anything else is emitted bare.
//   - Custom components (<Foo aria-label>) are skipped — the attribute lands wherever that component
//     spreads it, which only a render can resolve.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parse } from '@babel/parser'
import axe from 'axe-core'

// vitest rewrites import.meta.url to a server-root URL, so resolve off the project root instead.
const SRC = resolve(process.cwd(), 'src')
const ARIA_NAMING = ['aria-label', 'aria-labelledby']

// Tags whose implicit role only exists inside a particular parent.
const CONTEXT = {
  li: ['ul'], td: ['table', 'tbody', 'tr'], th: ['table', 'tbody', 'tr'], tr: ['table', 'tbody'],
  option: ['select'], optgroup: ['select'], dt: ['dl'], dd: ['dl'],
  figcaption: ['figure'], legend: ['fieldset'], summary: ['details'], caption: ['table'],
  path: ['svg'], g: ['svg'], circle: ['svg'], rect: ['svg'], line: ['svg'], polygon: ['svg'],
  polyline: ['svg'], ellipse: ['svg'], defs: ['svg'], use: ['svg'], text: ['svg'], tspan: ['svg'],
}

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      walkFiles(p, out)
    } else if (/\.jsx?$/.test(name)) out.push(p)
  }
  return out
}

// Nominate: every host element carrying a naming attribute, with what we can learn statically.
function nominate(code, rel) {
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx'] })
  const found = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (node.type === 'JSXElement' && node.openingElement.name?.type === 'JSXIdentifier') {
      const open = node.openingElement
      const tag = open.name.name
      const attrs = open.attributes
      const plain = attrs.filter((a) => a.type === 'JSXAttribute')
      const named = plain.find((a) => ARIA_NAMING.includes(a.name?.name))
      if (named && /^[a-z]/.test(tag)) {
        const roleAttr = plain.find((a) => a.name?.name === 'role')
        const roleDynamic = !!roleAttr && roleAttr.value?.type !== 'StringLiteral'
        const spread = attrs.some((a) => a.type === 'JSXSpreadAttribute')
        if (!roleDynamic && !spread) {
          found.push({
            file: rel,
            line: open.loc.start.line,
            tag,
            attr: named.name.name,
            role: roleAttr?.value?.type === 'StringLiteral' ? roleAttr.value.value : null,
            // "Would a screen reader find text to fall back on?" Any non-whitespace JSXText or any
            // expression child counts; an aria-hidden-only subtree does not.
            hasText: node.children.some((c) =>
              (c.type === 'JSXText' && c.value.trim()) ||
              (c.type === 'JSXExpressionContainer' && c.expression.type !== 'JSXEmptyExpression')),
          })
        }
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k.endsWith('Comments')) continue
      visit(node[k])
    }
  }
  visit(ast.program)
  return found
}

function synthesize(candidates) {
  return candidates.map((c, i) => {
    const attr = c.attr === 'aria-labelledby' ? `aria-labelledby="lbl"` : `aria-label="name"`
    const role = c.role ? ` role="${c.role}"` : ''
    const inner = `<${c.tag}${role} ${attr} data-cand="${i}">${c.hasText ? 'text' : ''}</${c.tag}>`
    const wrap = CONTEXT[c.tag] || []
    const open = wrap.map((w) => `<${w}>`).join('')
    const close = [...wrap].reverse().map((w) => `</${w}>`).join('')
    return open + inner + close
  }).join('\n')
}

describe('a11y gate layer 1 — no prohibited aria naming anywhere in src/ (V4-A11YGATE-001)', () => {
  it('every host element carrying aria-label/aria-labelledby has a role that can hold the name', async () => {
    const files = walkFiles(SRC)
    const candidates = files.flatMap((f) => {
      const code = readFileSync(f, 'utf8')
      if (!ARIA_NAMING.some((a) => code.includes(a))) return []
      return nominate(code, relative(SRC, f))
    })
    // Sanity floor: if the parser stops finding candidates at all the sweep has silently died.
    expect(candidates.length).toBeGreaterThan(50)

    document.body.innerHTML = `<span id="lbl">name</span>\n${synthesize(candidates)}`
    const res = await axe.run(document.body, {
      runOnly: { type: 'rule', values: ['aria-prohibited-attr'] },
      resultTypes: ['violations', 'incomplete'],
      elementRef: false,
    })
    // `incomplete` is a failure here on purpose — axe downgrades to incomplete whenever the element
    // has text content, but the author's label is discarded either way. See helpers/axe.js.
    const bad = [...res.violations, ...res.incomplete].flatMap((r) =>
      r.nodes.map((n) => {
        const idx = Number(n.html.match(/data-cand="(\d+)"/)?.[1])
        const c = candidates[idx]
        return `${c.file}:${c.line}  <${c.tag}${c.role ? ` role="${c.role}"` : ''} ${c.attr}>  — ${r.id}`
      }))
    expect(bad.sort()).toEqual([])
    document.body.innerHTML = ''
  })
})
