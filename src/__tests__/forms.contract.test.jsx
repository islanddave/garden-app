// Lane D / Phase A — contract-conformance + a11y + per-primitive tests for the
// shared form primitives (src/components/forms/*). Asserts the FROZEN prop
// contract from forms-consolidation-plan-V002 §5 Phase A: label/control
// association, ARIA wiring (aria-invalid / aria-describedby / role=alert),
// escape hatches, one-disabled-convention, shell states, and palette-composed
// chrome. a11y is asserted via association (getByLabelText) + explicit ARIA
// attribute checks (the repo has no jest-axe; association+ARIA is the contract).
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { P } from '../lib/constants.js'
import {
  Field, Input, Select, Textarea, Button, Card, Section, PageShell,
  Spinner, ErrorBanner, Toast, formStyles,
} from '../components/forms'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('Field — label/control association + ARIA wiring', () => {
  it('associates the label with its single control (getByLabelText resolves it)', () => {
    render(<Field label="Item name"><Input value="" onChange={() => {}} /></Field>)
    const control = screen.getByLabelText('Item name')
    expect(control.tagName).toBe('INPUT')
  })

  it('honors an explicit id over the generated one', () => {
    render(<Field label="Qty" id="qty-x"><Input value="" onChange={() => {}} /></Field>)
    expect(screen.getByLabelText('Qty').id).toBe('qty-x')
  })

  it('wires aria-invalid + aria-describedby to a role="alert" error node on error', () => {
    render(<Field label="Email" id="em" error="Bad email"><Input value="" onChange={() => {}} /></Field>)
    const control = screen.getByLabelText('Email')
    const alert = screen.getByRole('alert')
    expect(control.getAttribute('aria-invalid')).toBe('true')
    expect(alert.id).toBe('em-error')
    expect(control.getAttribute('aria-describedby')).toContain('em-error')
    expect(alert.textContent).toContain('Bad email')
  })

  it('marks required (aria-required + SR "(required)") and renders an optional affordance', () => {
    const { rerender } = render(<Field label="Name" id="n" required><Input value="" onChange={() => {}} /></Field>)
    expect(screen.getByLabelText(/Name/).getAttribute('aria-required')).toBe('true')
    expect(screen.getByText('(required)')).toBeDefined()
    rerender(<Field label="Mid" id="n" optional><Input value="" onChange={() => {}} /></Field>)
    expect(screen.getByText('optional')).toBeDefined()
  })

  it('associates help text via aria-describedby', () => {
    render(<Field label="URL" id="u" help="Start with https://"><Input value="" onChange={() => {}} /></Field>)
    const control = screen.getByLabelText('URL')
    expect(control.getAttribute('aria-describedby')).toContain('u-help')
  })

  it('contract-warns when given more than one focusable child', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(<Field label="Two"><Input value="" onChange={() => {}} /><Input value="" onChange={() => {}} /></Field>)
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.some(c => String(c[0]).includes('Field'))).toBe(true)
  })
})

describe('Input / Select / Textarea — escape hatches + error state', () => {
  it('forwards first-class native props and ...rest to the DOM, merges style', () => {
    render(<Input value="" onChange={() => {}} placeholder="hi" type="number" min="0" step="any" data-testid="inp" style={{ marginTop: 9 }} />)
    const el = screen.getByTestId('inp')
    expect(el.getAttribute('placeholder')).toBe('hi')
    expect(el.getAttribute('type')).toBe('number')
    expect(el.getAttribute('min')).toBe('0')
    expect(el.style.marginTop).toBe('9px')
  })

  it('controlled value + onChange round-trips', () => {
    const onChange = vi.fn()
    render(<Input value="abc" onChange={onChange} data-testid="c" />)
    fireEvent.change(screen.getByTestId('c'), { target: { value: 'abcd' } })
    expect(onChange).toHaveBeenCalled()
  })

  it('error prop drives the terra border + aria-invalid (string or bool)', () => {
    render(<Input value="" onChange={() => {}} error="nope" data-testid="e" />)
    const el = screen.getByTestId('e')
    expect(el.getAttribute('aria-invalid')).toBe('true')
  })

  it('does not leak the custom error/errorId props to the DOM', () => {
    render(<Input value="" onChange={() => {}} error="x" errorId="y" data-testid="leak" />)
    const el = screen.getByTestId('leak')
    expect(el.getAttribute('error')).toBeNull()
    expect(el.getAttribute('errorId')).toBeNull()
  })

  it('Select renders options from the options prop + a placeholder', () => {
    render(<Select value="" onChange={() => {}} placeholder="— pick —" options={[{ value: 'a', label: 'Alpha' }, 'beta']} />)
    expect(screen.getByRole('option', { name: '— pick —' })).toBeDefined()
    expect(screen.getByRole('option', { name: 'Alpha' }).value).toBe('a')
    expect(screen.getByRole('option', { name: 'beta' }).value).toBe('beta')
  })

  it('Select also accepts children options', () => {
    render(<Select value="z" onChange={() => {}}><option value="z">Zed</option></Select>)
    expect(screen.getByRole('option', { name: 'Zed' }).value).toBe('z')
  })

  it('Textarea sets rows and vertical resize', () => {
    render(<Textarea value="" onChange={() => {}} rows={5} data-testid="t" />)
    const el = screen.getByTestId('t')
    expect(el.getAttribute('rows')).toBe('5')
    expect(el.style.resize).toBe('vertical')
  })
})

describe('Button — variants + one disabled convention', () => {
  it('defaults to type=button and primary green fill', () => {
    render(<Button>Go</Button>)
    const b = screen.getByRole('button', { name: 'Go' })
    expect(b.getAttribute('type')).toBe('button')
    expect(b.style.backgroundColor).toBeTruthy()
    expect(b.style.minHeight).toBe('48px')
  })

  it('disabled uses the single convention: disabled attr + aria-disabled + not-allowed + P.light', () => {
    render(<Button disabled>X</Button>)
    const b = screen.getByRole('button', { name: 'X' })
    expect(b.disabled).toBe(true)
    expect(b.getAttribute('aria-disabled')).toBe('true')
    expect(b.style.cursor).toBe('not-allowed')
  })

  it('loading disables, sets aria-busy, and swaps the label', () => {
    render(<Button loading loadingLabel="Saving…">Save</Button>)
    const b = screen.getByRole('button')
    expect(b.disabled).toBe(true)
    expect(b.getAttribute('aria-busy')).toBe('true')
    expect(b.textContent).toBe('Saving…')
  })
})

describe('Shell primitives — Section / PageShell / ErrorBanner / Spinner / Toast', () => {
  it('Section precedence: error beats loading beats empty beats children', () => {
    const { rerender } = render(<Section error="boom" loading empty>kids</Section>)
    expect(screen.getByRole('alert').textContent).toContain('boom')
    rerender(<Section loading empty>kids</Section>)
    expect(screen.getByRole('status')).toBeDefined()
    rerender(<Section empty emptyLabel="None yet">kids</Section>)
    expect(screen.getByText('None yet')).toBeDefined()
    rerender(<Section>kids</Section>)
    expect(screen.getByText('kids')).toBeDefined()
  })

  it('PageShell renders title + breadcrumb and forwards async states', () => {
    render(<PageShell title="Add item" breadcrumb="Inventory › Add" error="nope">body</PageShell>)
    expect(screen.getByRole('heading', { name: 'Add item' })).toBeDefined()
    expect(screen.getByText('Inventory › Add')).toBeDefined()
    expect(screen.getByRole('alert').textContent).toContain('nope')
  })

  it('ErrorBanner is role=alert and renders null when empty', () => {
    const { container, rerender } = render(<ErrorBanner>fail</ErrorBanner>)
    expect(screen.getByRole('alert').textContent).toBe('fail')
    rerender(<ErrorBanner>{null}</ErrorBanner>)
    expect(container.querySelector('[role=alert]')).toBeNull()
  })

  it('Spinner exposes an SR label via role=status', () => {
    render(<Spinner label="Loading items…" />)
    expect(screen.getByRole('status').textContent).toContain('Loading items…')
  })

  it('Toast is a polite status, hidden when !show, and auto-resolves via onDone', () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    const { rerender } = render(<Toast message="Saved" show={false} onDone={onDone} />)
    expect(screen.queryByRole('status')).toBeNull()
    rerender(<Toast message="Saved" show duration={2500} onDone={onDone} />)
    const t = screen.getByRole('status')
    expect(t.getAttribute('aria-live')).toBe('polite')
    expect(t.textContent).toBe('Saved')
    act(() => { vi.advanceTimersByTime(2500) })
    expect(onDone).toHaveBeenCalled()
  })

  it('Card renders an optional group title', () => {
    render(<Card title="Required to save">inside</Card>)
    expect(screen.getByText('Required to save')).toBeDefined()
    expect(screen.getByText('inside')).toBeDefined()
  })
})

describe('formStyles — every value composes from the palette P', () => {
  it('chevronDataUri encodes the palette color (P.light → %23777), no hardcoded stroke', () => {
    const uri = formStyles.chevronDataUri(P.light)
    expect(uri).toContain('%23777')
    expect(uri).not.toContain('%23777777')
  })
  it('inputChrome flips the border to terra on error', () => {
    expect(formStyles.inputChrome(true).border).toContain(P.terra)
    expect(formStyles.inputChrome(false).border).toContain(P.border)
  })
  it('selectChrome composes the chevron from P.light', () => {
    expect(formStyles.selectChrome().backgroundImage).toContain('%23777')
  })
  it('buttonChrome freezes minHeight 48 and the disabled convention', () => {
    expect(formStyles.buttonChrome('primary', false).minHeight).toBe(48)
    const dis = formStyles.buttonChrome('primary', true)
    expect(dis.backgroundColor).toBe(P.light)
    expect(dis.cursor).toBe('not-allowed')
  })
})
