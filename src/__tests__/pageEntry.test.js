// BUG-OVERLAYRELOADKEY-001 — src/lib/pageEntry.js: which history entry the PAGE TREE is showing, read off
// window.history.state for code that cannot use the router. Pure, so every branch is pinned here; the
// consequences (a page that mounts under an overlay keeps its place) are in
// useScrollRestore.underOverlay.test.jsx and gate:seeds-scroll flow h.
import { describe, it, expect } from 'vitest'
import { pageEntryKey, locationEntryKey, CONTINUES_ENTRY_KEY } from '../lib/pageEntry.js'

// A background as OverlayContext stores it: the page's location, historyEntry included.
const bg = (extra = {}) => ({ pathname: '/seeds', search: '?view=saved', hash: '', state: null, key: 'kPage', historyEntry: { idx: 1, doc: 'd' }, ...extra })
// A history state as BrowserRouter writes it.
const st = (usr, key = 'kOverlay', idx = 2) => ({ usr, key, idx })

describe('pageEntryKey — the entry the page tree shows', () => {
  it('a plain entry is its own', () => {
    expect(pageEntryKey(st(null, 'kPage', 1))).toBe('kPage')
    expect(pageEntryKey(st({ seedsReturn: '/seeds' }, 'kPage', 1))).toBe('kPage')
  })

  it('under a route overlay it is the background\'s, not the overlay\'s', () => {
    expect(pageEntryKey(st({ background: bg() }))).toBe('kPage')
    // A Search peek pushed inside the overlay carries the same background: still the page's.
    expect(pageEntryKey(st({ background: bg(), peekPushed: true }, 'kPeek', 3))).toBe('kPage')
  })

  it('a DismissRegistry Back marker over an overlay copies the usr, so it resolves the same way', () => {
    expect(pageEntryKey({ ...st({ background: bg() }), __backnav: { v: 2, seq: 1 } })).toBe('kPage')
  })

  it('an entry left by an overlay\'s replace-close answers to the page entry it continues', () => {
    expect(pageEntryKey(st({ [CONTINUES_ENTRY_KEY]: 'kPage' }, 'kReplaced', 2))).toBe('kPage')
  })

  // No writer puts both on one entry (the stamp rides on a page entry, a background inside `usr`), but the
  // precedence is OverlayProvider's: a background decides what the page tree renders, so it decides here.
  it('a background outranks a stamp on the same entry', () => {
    expect(pageEntryKey(st({ background: bg(), [CONTINUES_ENTRY_KEY]: 'kOther' }))).toBe('kPage')
  })

  it('an overlay opened over such an entry resolves through the stamp its background carries', () => {
    const continued = bg({ key: 'kReplaced', state: { [CONTINUES_ENTRY_KEY]: 'kPage' } })
    expect(pageEntryKey(st({ background: continued }, 'kOverlay2', 3))).toBe('kPage')
  })

  it('honors a background only as OverlayProvider does: flag on, and shaped like a location', () => {
    expect(pageEntryKey(st({ background: bg() }), false)).toBe('kOverlay')
    expect(pageEntryKey(st({ background: 'nope' }))).toBe('kOverlay')
    expect(pageEntryKey(st({ background: { key: 'kPage' } }))).toBe('kOverlay')   // no pathname
    expect(pageEntryKey(st({ background: null }))).toBe('kOverlay')
  })

  it('is null for an entry react-router has not keyed, and for no state at all', () => {
    expect(pageEntryKey({ idx: 0 })).toBe(null)
    expect(pageEntryKey({ usr: null, key: '', idx: 0 })).toBe(null)
    expect(pageEntryKey(null)).toBe(null)
    expect(pageEntryKey(undefined)).toBe(null)
    expect(pageEntryKey('state')).toBe(null)
  })

  it('a background of the first entry answers react-router\'s own \'default\', as that entry itself does', () => {
    expect(pageEntryKey(st({ background: bg({ key: 'default' }) }))).toBe('default')
  })

  it('a background with no key is not read as the overlay\'s entry', () => {
    const { key: _drop, ...keyless } = bg()
    expect(pageEntryKey(st({ background: keyless }))).toBe(null)
  })

  it('ignores a stamp that is not a key', () => {
    expect(pageEntryKey(st({ [CONTINUES_ENTRY_KEY]: 42 }, 'kReplaced'))).toBe('kReplaced')
    expect(pageEntryKey(st({ [CONTINUES_ENTRY_KEY]: '' }, 'kReplaced'))).toBe('kReplaced')
    expect(pageEntryKey(st({ background: bg({ state: { [CONTINUES_ENTRY_KEY]: {} } }) }))).toBe('kPage')
  })
})

describe('locationEntryKey — what a replace-close stamps', () => {
  it('the location\'s own key, or the entry it already continues', () => {
    expect(locationEntryKey(bg())).toBe('kPage')
    expect(locationEntryKey(bg({ key: 'kReplaced', state: { [CONTINUES_ENTRY_KEY]: 'kPage' } }))).toBe('kPage')
  })
  it('null for anything that carries no key', () => {
    expect(locationEntryKey({ pathname: '/today', search: '' })).toBe(null)
    expect(locationEntryKey(null)).toBe(null)
    expect(locationEntryKey(undefined)).toBe(null)
  })
})
