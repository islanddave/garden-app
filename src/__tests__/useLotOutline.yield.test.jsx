// BUG-DETAILPAGESCARRYSCROLL-001 (rimpact-scrollmanager-built N4): useLotOutline scrolls on purpose — the row the
// add form just created, after its navigate(-1) — so a Back restore still pulling toward the old place must stop
// first. The outline tells the app-level page-scroll manager (usePageScrollYield) BEFORE its scrollIntoView.
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { PageScrollProvider } from '../hooks/usePageScrollManager.js'
import { useLotOutline } from '../components/seed/useLotOutline.js'

function Lot({ highlight }) {
  const outlined = useLotOutline(highlight, { ready: true })
  return <div data-lot-id="lot-1" data-outlined={outlined === 'lot-1' ? 'true' : undefined}>lot</div>
}

describe('useLotOutline and the page-scroll manager', () => {
  const had = Object.prototype.hasOwnProperty.call(Element.prototype, 'scrollIntoView')
  const original = Element.prototype.scrollIntoView
  afterEach(() => {
    cleanup()
    if (had) Element.prototype.scrollIntoView = original
    else delete Element.prototype.scrollIntoView
  })

  it('yields the page scroll before it scrolls to the outlined lot', () => {
    const calls = []
    // jsdom has no scrollIntoView; the outline only scrolls where there is one.
    Element.prototype.scrollIntoView = function scrollIntoView() { calls.push(`scroll ${this.getAttribute('data-lot-id')}`) }
    const api = { claim: () => () => {}, yieldScroll: () => calls.push('yield') }
    const view = render(
      <PageScrollProvider value={{ api, isReturn: false }}>
        <Lot highlight={{ id: 'lot-1', seq: 1 }} />
      </PageScrollProvider>,
    )
    expect(view.container.querySelector('[data-outlined="true"]')).not.toBeNull()
    expect(calls).toEqual(['yield', 'scroll lot-1'])
  })

  it('outside the provider the outline still scrolls (the yield is a no-op)', () => {
    const calls = []
    Element.prototype.scrollIntoView = function scrollIntoView() { calls.push('scroll') }
    render(<Lot highlight={{ id: 'lot-1', seq: 1 }} />)
    expect(calls).toEqual(['scroll'])
  })
})
