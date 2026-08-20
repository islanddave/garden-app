// BUG-PHOTOUPLOADKBD-001 — repo-wide static sweep for the keyboard-unreachable file picker.
//
// THE DEFECT: a <label> wrapping an <input type="file"> that is hidden with display:none. The input
// is out of the tab order and out of the accessibility tree; a <label> has no tabindex and no role,
// so it is not focusable either. Net: the control is operable by pointer only. It shipped at two
// sites (PhotoUpload single mode, ProjectDetail's mini-logger) and reads as perfectly ordinary code.
//
// WHY A STATIC SWEEP AND NOT AN AXE CASE. The a11y gate — both layers — is blind to this class by
// construction. Measured on the pre-fix tree: axe returns ZERO findings on the defective markup, not
// merely zero violations, and not only for the gate's rule set but for axe's FULL default set. A
// display:none subtree is excluded from the audit outright, and a <label> is not an interactive
// element, so no rule has anything to fire on. Layer 1 (a11yProhibitedAttr) only inspects elements
// carrying aria-label. Nothing else in the suite covers a page nobody renders in isolation.
//
// This is a LINT-CLASS guard, not behavioral proof — it asserts a shape, not that any control works.
// The behavioral proof lives in PhotoUpload.test.jsx and ProjectDetail.miniPhotoKbd.test.jsx, which
// assert tab-order membership and Enter/Space activation. This one exists to stop a THIRD site.
//
// The correct pattern, already used at seven sites: a real <button type="button"> whose onClick
// calls .click() on the hidden input, with the accessible name on the button.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parse } from '@babel/parser'

const SRC = resolve(process.cwd(), 'src')

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

const attrs = (el) => el.openingElement.attributes.filter((a) => a.type === 'JSXAttribute')
const tagOf = (el) =>
  el.openingElement.name?.type === 'JSXIdentifier' ? el.openingElement.name.name : null

function isFileInput(el) {
  return tagOf(el) === 'input' && attrs(el).some((a) =>
    a.name?.name === 'type' && a.value?.type === 'StringLiteral' && a.value.value === 'file')
}

// Hidden in the two ways this repo hides a picker: style={{ display: 'none' }} or the `hidden` attr.
function isVisuallyHidden(el) {
  return attrs(el).some((a) => {
    if (a.name?.name === 'hidden') return true
    if (a.name?.name !== 'style') return false
    const obj = a.value?.type === 'JSXExpressionContainer' ? a.value.expression : null
    if (obj?.type !== 'ObjectExpression') return false
    return obj.properties.some((p) =>
      p.type === 'ObjectProperty' &&
      (p.key?.name === 'display' || p.key?.value === 'display') &&
      p.value?.type === 'StringLiteral' && p.value.value === 'none')
  })
}

function eachJsxElement(node, fn) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((n) => eachJsxElement(n, fn)); return }
  if (node.type === 'JSXElement') fn(node)
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k.endsWith('Comments')) continue
    eachJsxElement(node[k], fn)
  }
}

// Returns { findings, labels, fileInputs } so a caller can prove the parser is still finding things.
function scan(code, rel) {
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx'] })
  const findings = []
  let labels = 0
  let fileInputs = 0
  eachJsxElement(ast.program, (el) => {
    if (isFileInput(el)) fileInputs += 1
    if (tagOf(el) !== 'label') return
    labels += 1
    eachJsxElement(el.children, (kid) => {
      if (isFileInput(kid) && isVisuallyHidden(kid)) {
        findings.push(`${rel}:${el.openingElement.loc.start.line}  <label> wraps a hidden <input type="file"> (line ${kid.openingElement.loc.start.line}) — keyboard-unreachable`)
      }
    })
  })
  return { findings, labels, fileInputs }
}

// The detector proving itself, so a green sweep can never mean "the matcher quietly stopped working".
const SPECIMEN_BAD = `const A = () => (
  <label htmlFor="x" style={{ padding: 4 }}>
    Add Photo
    <input id="x" type="file" accept="image/*" style={{ display: 'none' }} />
  </label>
)`
const SPECIMEN_GOOD = `const B = () => (
  <>
    <button type="button" aria-label="Add photo" onClick={() => ref.current?.click()}>Add Photo</button>
    <input ref={ref} id="x" type="file" accept="image/*" aria-hidden="true" tabIndex={-1} style={{ display: 'none' }} />
  </>
)`

describe('no <label> wraps a hidden file input anywhere in src/ (BUG-PHOTOUPLOADKBD-001)', () => {
  it('the detector flags the defective shape and clears the button shape', () => {
    expect(scan(SPECIMEN_BAD, 'specimen-bad').findings).toHaveLength(1)
    expect(scan(SPECIMEN_GOOD, 'specimen-good').findings).toEqual([])
  })

  it('every file picker in src/ has a focusable trigger', () => {
    const files = walkFiles(SRC)
    let labels = 0
    let fileInputs = 0
    const findings = []
    for (const f of files) {
      const code = readFileSync(f, 'utf8')
      if (!code.includes('<label') && !code.includes('type="file"')) continue
      const r = scan(code, relative(SRC, f))
      findings.push(...r.findings)
      labels += r.labels
      fileInputs += r.fileInputs
    }
    // Sanity floors: if either count collapses, the walker or the parser has silently died and the
    // sweep would report a clean repo for the wrong reason. Held well below the live counts so
    // ordinary churn does not trip them.
    expect(labels, 'parser found no <label> elements at all').toBeGreaterThan(20)
    expect(fileInputs, 'parser found no file inputs at all').toBeGreaterThan(5)
    expect(findings.sort()).toEqual([])
  })
})
