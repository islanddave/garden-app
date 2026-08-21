// BUG-FIELDCHILDDROP-001 — Field must never lose a child silently.
//
// THE DEFECT. Field's render was `{controlChild}{kids.slice(1).filter(k => !isValidElement(k))}`:
// it kept the string children after the first and threw away the ELEMENT ones. A second <div>,
// <span> or control passed to a Field simply did not exist in the DOM. The accompanying
// contractWarn said "only the first gets the label id — wrap extras yourself", which describes an
// unlabelled-but-rendered extra, not a deleted one.
//
// WHY IT SURVIVED. Measured on the pre-fix tree by instrumenting Field and running the whole unit
// suite (727 files / 10,614 tests): the ONLY multi-child Field rendered anywhere in the suite was
// the deliberate one in forms.contract.test.jsx. Both real call sites — AddSeeds' row-edit sheet
// and InventoryAdd's seed-variety field — are on surfaces no test renders, so each shipped with a
// help <div> that no user has ever seen. That is why the sweep below is STATIC as well as
// behavioural: the behavioural half proves the primitive, the static half is the only thing that
// can see a call site nobody renders.
//
// A Fragment child is the same class with a different symptom. React.Children.toArray does not
// descend into a Fragment, so it counts as ONE element: nothing is dropped, but the cloned id and
// ARIA land on the Fragment, React discards every prop but key/children, and the label's htmlFor
// points at an id no element carries. The old warning never fired for it at all.
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parse } from '@babel/parser'
import Field from '../components/forms/Field.jsx'

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('Field — the dev-time error (BUG-FIELDCHILDDROP-001)', () => {
  // React logs its own ~40-line "The above error occurred in <Field>" block on any throw during
  // render. These cases assert the thrown Error directly, so the block is pure CI-log noise.
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {})

  it('throws, naming both child shapes, when given two element children', () => {
    quiet()
    let err
    try {
      render(<Field label="Two"><input data-testid="one" /><span data-testid="two">hint</span></Field>)
    } catch (e) { err = e }
    expect(err, 'a second element child rendered without complaint').toBeDefined()
    expect(err.message).toContain('[forms contract] Field')
    expect(err.message).toContain('received 2')
    expect(err.message).toContain('<input>')
    expect(err.message).toContain('<span>')
    // Actionable, not just loud: it has to say where the extra node should go.
    expect(err.message).toContain('help')
  })

  it('throws when its only child is a Fragment (the label-association blind spot)', () => {
    quiet()
    let err
    try {
      render(<Field label="Frag"><><input data-testid="a" /><input data-testid="b" /></></Field>)
    } catch (e) { err = e }
    expect(err, 'a Fragment child rendered without complaint').toBeDefined()
    expect(err.message).toContain('Fragment')
  })

  it('does NOT fire on the legitimate shapes: one control, false branches, trailing text', () => {
    expect(() => render(<Field label="Ok"><input /></Field>)).not.toThrow()
    expect(() => render(<Field label="Cond">{false && <span />}{null}<input /></Field>)).not.toThrow()
    expect(() => render(<Field label="Text"><input />{' '}suffix</Field>)).not.toThrow()
  })

  it('wires label + ARIA to the single control exactly as before', () => {
    render(<Field label="Qty" id="q" error="bad" help="hint"><input /></Field>)
    const el = screen.getByLabelText('Qty')
    expect(el.id).toBe('q')
    expect(el.getAttribute('aria-invalid')).toBe('true')
    expect(el.getAttribute('aria-describedby')).toBe('q-help q-error')
  })

  it('wires the first ELEMENT child, not literally children[0], so a leading string cannot orphan the label', () => {
    const { container } = render(<Field label="Lead" id="ld">prefix<input /></Field>)
    expect(screen.getByLabelText('Lead').tagName).toBe('INPUT')
    expect(container.textContent).toContain('prefix')
  })
})

describe('Field — production degrades by rendering everything, never by dropping (BUG-FIELDCHILDDROP-001)', () => {
  // contractError is a no-op in a production build (same crashing-Jen's-screen rule as
  // contractWarn), so prod is the branch where a violation actually renders. It must render
  // ALL of it. Without this case the "never drop" half of the fix is unobservable, because
  // dev/test throws before the render is reached.
  const prod = () => vi.stubEnv('MODE', 'production')

  it('renders every element child, in source order, when the guard is disarmed', () => {
    prod()
    const { container } = render(
      <Field label="Two" id="tw">
        <input data-testid="control" />
        <span data-testid="hint">Leave blank to create a new variety.</span>
      </Field>
    )
    expect(screen.queryByTestId('control'), 'the control vanished').not.toBeNull()
    expect(screen.queryByTestId('hint'), 'the second child was dropped — the whole bug').not.toBeNull()
    expect(screen.getByTestId('hint').textContent).toContain('Leave blank')
    // Order matters: the hint sits under the control, where its author put it.
    const html = container.innerHTML
    expect(html.indexOf('data-testid="control"')).toBeLessThan(html.indexOf('data-testid="hint"'))
    // Still exactly one labelled control.
    expect(screen.getByLabelText('Two').getAttribute('data-testid')).toBe('control')
    expect(screen.getByTestId('hint').id).toBe('')
  })

  it('keeps string children too (the one thing the old filter got right)', () => {
    prod()
    const { container } = render(<Field label="Mix"><input data-testid="c" />trailing text</Field>)
    expect(container.textContent).toContain('trailing text')
    expect(screen.queryByTestId('c')).not.toBeNull()
  })

  it('renders three-plus children without loss', () => {
    prod()
    render(
      <Field label="Many">
        <input data-testid="c" /><span data-testid="s1">a</span><span data-testid="s2">b</span>
      </Field>
    )
    for (const id of ['c', 's1', 's2']) expect(screen.queryByTestId(id), `${id} dropped`).not.toBeNull()
  })
})

// ── Static sweep ────────────────────────────────────────────────────────────────────────────
// Matches the a11yLabelledFileInput.test.js pattern: a self-proving detector plus a sanity floor,
// so a green sweep can never mean "the matcher quietly stopped working". This is a LINT-CLASS
// guard — it asserts a shape, not that any control works — and it exists because the two real
// defects were on surfaces the behavioural suite never renders.
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

function eachJsxElement(node, fn) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(n => eachJsxElement(n, fn)); return }
  if (node.type === 'JSXElement') fn(node)
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k.endsWith('Comments')) continue
    eachJsxElement(node[k], fn)
  }
}

// A JSX comment `{/* … */}` and whitespace-only text produce no child at all.
function isRealChild(n) {
  if (n.type === 'JSXText') return n.value.trim() !== ''
  if (n.type === 'JSXExpressionContainer' && n.expression.type === 'JSXEmptyExpression') return false
  return true
}

// Anything that can evaluate to an element at runtime, not just a literal <X/>. A `{cond && <X/>}`
// beside a control is the same defect in a shape the naive check misses.
function mayBeElement(n) {
  if (n.type === 'JSXElement' || n.type === 'JSXFragment') return true
  if (n.type !== 'JSXExpressionContainer') return false
  const t = n.expression.type
  return t === 'JSXElement' || t === 'JSXFragment' || t === 'LogicalExpression' ||
    t === 'ConditionalExpression' || t === 'CallExpression'
}

function scanFieldChildren(code, rel) {
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx'] })
  const findings = []
  let fields = 0
  eachJsxElement(ast.program, (el) => {
    if (el.openingElement.name?.name !== 'Field') return
    fields += 1
    const kids = el.children.filter(isRealChild)
    const candidates = kids.filter(mayBeElement)
    const fragment = kids.some(k => k.type === 'JSXFragment' ||
      (k.type === 'JSXExpressionContainer' && k.expression.type === 'JSXFragment'))
    const line = el.openingElement.loc.start.line
    if (candidates.length > 1) {
      findings.push(`${rel}:${line}  <Field> has ${candidates.length} element children — all but the first were dropped before BUG-FIELDCHILDDROP-001; move help text to the \`help\` prop`)
    } else if (fragment) {
      findings.push(`${rel}:${line}  <Field> wraps its control in a Fragment — the label/ARIA wiring lands on the Fragment and is discarded`)
    }
  })
  return { findings, fields }
}

const SPECIMEN_MULTI = `const A = () => (
  <Field label="Variety">
    <VarietyPicker value={v} onChange={f} />
    <div style={{ marginTop: 6 }}>Leave blank to create a new variety.</div>
  </Field>
)`
const SPECIMEN_COND = `const B = () => (
  <Field label="Variety"><Input value={v} onChange={f} />{showHint && <Hint />}</Field>
)`
const SPECIMEN_FRAG = `const C = () => (
  <Field label="Variety"><><Input value={v} onChange={f} /><Hint /></></Field>
)`
const SPECIMEN_GOOD = `const D = () => (
  <Field label="Variety" help="Leave blank to create a new variety.">
    {/* the control, and only the control */}
    <VarietyPicker value={v} onChange={f} />
  </Field>
)`

describe('no <Field> in src/ passes more than one element child (BUG-FIELDCHILDDROP-001)', () => {
  it('the detector flags the multi-child, conditional-sibling and Fragment shapes, and clears the fixed one', () => {
    expect(scanFieldChildren(SPECIMEN_MULTI, 'spec-multi').findings).toHaveLength(1)
    expect(scanFieldChildren(SPECIMEN_COND, 'spec-cond').findings).toHaveLength(1)
    expect(scanFieldChildren(SPECIMEN_FRAG, 'spec-frag').findings).toHaveLength(1)
    expect(scanFieldChildren(SPECIMEN_GOOD, 'spec-good').findings).toEqual([])
  })

  it('every <Field> call site in src/ passes exactly one control', () => {
    const findings = []
    let fields = 0
    for (const f of walkFiles(SRC)) {
      const code = readFileSync(f, 'utf8')
      if (!code.includes('<Field')) continue
      const r = scanFieldChildren(code, relative(SRC, f))
      findings.push(...r.findings)
      fields += r.fields
    }
    // Sanity floor: 168 live sites when this landed. If the count collapses, the walker or the
    // parser has died and the sweep would report a clean repo for the wrong reason.
    expect(fields, 'parser found almost no <Field> elements at all').toBeGreaterThan(120)
    expect(findings.sort()).toEqual([])
  })
})
