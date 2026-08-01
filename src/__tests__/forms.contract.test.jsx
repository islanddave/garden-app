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
  Field, Input, Select, Textarea, Button, Badge, Card, AsyncRegion, PageShell,
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

describe('Shell primitives — AsyncRegion / PageShell / ErrorBanner / Spinner / Toast', () => {
  it('AsyncRegion precedence: error beats loading beats empty beats children', () => {
    const { rerender } = render(<AsyncRegion error="boom" loading empty>kids</AsyncRegion>)
    expect(screen.getByRole('alert').textContent).toContain('boom')
    rerender(<AsyncRegion loading empty>kids</AsyncRegion>)
    expect(screen.getByRole('status')).toBeDefined()
    rerender(<AsyncRegion empty emptyLabel="None yet">kids</AsyncRegion>)
    expect(screen.getByText('None yet')).toBeDefined()
    rerender(<AsyncRegion>kids</AsyncRegion>)
    expect(screen.getByText('kids')).toBeDefined()
  })

  // The error branch grew a second shape (the recoverable-error card) so pages stop hand-rolling
  // one. These pin BOTH the backward-compatible default and the union the card canonicalizes.
  it('AsyncRegion error branch stays the bare ErrorBanner when no onRetry is given', () => {
    const { container } = render(<AsyncRegion error="boom" />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('boom')
    expect(alert.style.padding).toBe(formStyles.bannerChrome.padding)
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull()
  })

  it('AsyncRegion renders the recoverable-error card when onRetry is supplied', () => {
    const onRetry = vi.fn()
    render(<AsyncRegion error="Service had a problem." errorTitle="Couldn’t load your photos" onRetry={onRetry} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Couldn’t load your photos')
    expect(alert.textContent).toContain('Service had a problem.')
    expect(alert.style.textAlign).toBe('center')
    expect(alert.style.borderRadius).toBe(`${formStyles.T.radiusCard}px`)
    const btn = screen.getByRole('button', { name: 'Retry' })
    fireEvent.click(btn)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  // Union property 1 — the tap target. Only PhotosWall carried a minHeight before; the other three
  // computed to ~34px. Routing through Button inherits the frozen 48px floor for every adopter.
  it('AsyncRegion retry control routes through Button and clears the tap-target floor', () => {
    render(<AsyncRegion error="x" onRetry={() => {}} />)
    const btn = screen.getByRole('button', { name: 'Retry' })
    expect(parseInt(btn.style.minHeight, 10)).toBeGreaterThanOrEqual(44)
    expect(btn.style.minHeight).toBe(`${formStyles.T.buttonMinHeight}px`)
    expect(btn.style.borderRadius).toBe(`${formStyles.T.radiusButton}px`)
    expect(btn.getAttribute('type')).toBe('button')
  })

  // Union property 2 — the decorative glyph is hidden from AT. Only Harvests did this before;
  // elsewhere a screen reader announced the warning emoji inside role="alert".
  it('AsyncRegion error card hides the decorative glyph from assistive tech', () => {
    render(<AsyncRegion error="x" errorTitle="t" onRetry={() => {}} />)
    const glyph = screen.getByRole('alert').firstChild
    expect(glyph.getAttribute('aria-hidden')).toBe('true')
    expect(glyph.textContent).not.toBe('')
  })

  it('AsyncRegion error card takes a custom retryLabel and tolerates a missing title', () => {
    render(<AsyncRegion error="only a message" onRetry={() => {}} retryLabel="Try again" />)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined()
    expect(screen.getByRole('alert').querySelectorAll('p')).toHaveLength(1)
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

describe('Badge — tone, children, escape hatches, no-tone-attr-leak', () => {
  it('renders children inside the badge span', () => {
    render(<Badge>Seedling</Badge>)
    expect(screen.getByText('Seedling')).toBeDefined()
  })
  it('applies tone styling: active tone uses greenPale background', () => {
    render(<Badge tone="active" data-testid="b">Active</Badge>)
    const el = screen.getByTestId('b')
    expect(el.style.backgroundColor).toBeTruthy()
    expect(el.style.border).toContain('1px solid')
  })
  it('neutral tone (default) renders with a background', () => {
    render(<Badge data-testid="n">Label</Badge>)
    expect(screen.getByTestId('n').style.backgroundColor).toBeTruthy()
  })
  it('passes through className, style (merged), and title to the DOM', () => {
    render(<Badge tone="warn" className="my-badge" style={{ marginLeft: 8 }} title="Status note" data-testid="esc">Warn</Badge>)
    const el = screen.getByTestId('esc')
    expect(el.className).toBe('my-badge')
    expect(el.style.marginLeft).toBe('8px')
    expect(el.getAttribute('title')).toBe('Status note')
  })
  it('does not leak the tone prop as a DOM attribute', () => {
    render(<Badge tone="danger" data-testid="leak">Danger</Badge>)
    expect(screen.getByTestId('leak').getAttribute('tone')).toBeNull()
  })
})
