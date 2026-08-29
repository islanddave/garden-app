// V4-TIERBLINDMINT-001 (client half) — PhotoImg's `mintTier` is an IDENTITY, not a variant mode.
//
// PhotoImg's contract is frozen at "gains no hero/variant/tier prop (composition, not
// configuration)". This lane narrows that clause rather than amending it: the ban is on a VARIANT
// MODE — a prop the component BRANCHES ON to render differently — and `mintTier` is not one. It
// reaches exactly two sinks (the mint URL and the cache key) and nothing else. A narrowing that
// nobody can check is just a repeal with better prose, so this file is the machine half of it:
//
//   §B proves the narrowing behaviourally — the rendered DOM is byte-identical across tiers, and
//     the component body names no tier value and never branches on the prop.
//   §A pins the client's tier vocabulary to the LAMBDA's own enum, and further proves the client
//     can never put on the wire a tier the server would 400 on.
//   §C is the cache-key half: a thumb and a full URL for ONE photo id are two objects in the
//     bucket and must occupy two slots. Every case here goes RED against the old single-key cache.
//   §D is the point of the whole row — the client finally NAMES the tier it wants.
//   §E is the degrade: a thumb presign for an object that does not exist (181 of 1094 live rows,
//     BUG-PHOTONEWTHUMB-001) must fall back on the in-hand original, with no probe request.
//
// WHAT THIS CANNOT CATCH: jsdom never loads an image. These prove which URL was requested, which
// slot answered, and what the DOM says — never that a picture appeared or how many bytes moved.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, fireEvent, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: () => Promise.resolve('t') }),
}))

import PhotoImg, { __resetPhotoImgCache, __seedPhotoImgUrl, PRESIGN_TTL_MS } from '../components/PhotoImg.jsx'
import PhotoView from '../components/photo/PhotoView.jsx'
import { TIER } from '../lib/photoModel.js'
// The Lambda's OWN enum, imported rather than transcribed. viewTier.js is dependency-free (no aws
// sdk, no neon), which is why it can be reached from a jsdom unit test at all — same precedent as
// preservationColumnParity.test.js. Re-typing these two strings here would leave exactly the drift
// this import exists to make impossible.
import { PHOTO_VIEW_TIERS, normalizeViewTier } from '../../lambda/photos/viewTier.js'
// A cross-origin photo now spends one absorbed CORS attempt before an error reaches the heal.
// failPhotoLoad says "the image failed" and is blind to the flag; PhotoImg.cors.test.jsx owns the retry.
import { failPhotoLoad } from './helpers/photoLoadFailure.js'

beforeEach(() => { fetchSpy.mockReset(); __resetPhotoImgCache() })

const __dirname = dirname(fileURLToPath(import.meta.url))
const img = (c) => c.querySelector('img')
const src = (c) => c.querySelector('img')?.getAttribute('src') ?? null
const requested = () => fetchSpy.mock.calls.map(c => String(c[0]))
// jsdom's default rect is 0×0, which reads as off-screen and closes PhotoImg's P5 viewport gate.
const onScreen = (el) => { if (el) el.getBoundingClientRect = () => ({ top: 10, left: 10, bottom: 110, right: 110, width: 100, height: 100, x: 10, y: 10, toJSON() {} }) }
const foreground = () => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}
// The `?tier=` a request actually carried, or null for the bare path.
const wireTier = (url) => (url.includes('?') ? new URLSearchParams(url.split('?')[1]).get('tier') : null)

// ── §A — the client vocabulary IS the Lambda's ────────────────────────────────────────────────
describe('A. the tier vocabulary cannot drift from the Lambda', () => {
  it('A1 the client enum and PHOTO_VIEW_TIERS are the same set', () => {
    expect([...Object.values(TIER)].sort()).toEqual([...PHOTO_VIEW_TIERS].sort())
  })

  // Stronger than A1: exercises the server's own acceptance FUNCTION, so a future server that keeps
  // the constant but narrows normalizeViewTier still reds here.
  it('A2 every client tier is accepted verbatim by the server normalizer', () => {
    for (const t of Object.values(TIER)) expect(normalizeViewTier(t)).toBe(t)
  })

  // The keystone. `_tier()` coerces an unknown tier to FULL rather than passing it through, because
  // the client sits in a render path where a 400 classifies as transient and retries forever. This
  // drives real renders and feeds whatever reached the wire back into the SERVER's normalizer: if
  // any junk value could produce a 400, this goes red without anyone having to imagine the value.
  it('A3 no mintTier value, however malformed, can put a 400-able tier on the wire', async () => {
    const junk = ['thumbnail', 'THUMB', 'small', 'orig', '', 'full ', '../../etc/passwd', 'thumb;full', 0, 1, null, undefined, {}, [], true]
    for (let i = 0; i < junk.length; i++) {
      __resetPhotoImgCache(); fetchSpy.mockReset()
      fetchSpy.mockResolvedValue({ view_url: 'https://s3/j.jpg' })
      const { container } = render(<PhotoImg photoId={`jx${i}`} initialUrl="https://s3/stale.jpg" alt="x" mintTier={junk[i]} />)
      failPhotoLoad(() => img(container))
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
      const t = wireTier(requested()[0])
      expect(normalizeViewTier(t), `mintTier=${JSON.stringify(junk[i])} put tier=${JSON.stringify(t)} on the wire, which the server 400s`).not.toBeNull()
    }
  })
})

// ── §B — an identity, not a variant mode ──────────────────────────────────────────────────────
const SRC_TEXT = readFileSync(resolve(__dirname, '../components/PhotoImg.jsx'), 'utf8')
const BODY_MARK = 'export default function PhotoImg'
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const BODY = stripComments(SRC_TEXT.slice(SRC_TEXT.indexOf(BODY_MARK)))

// A tier VALUE named anywhere in the component body means the body can compare against one.
const TIER_VALUE = /\bTIER\s*\.|['"]thumb['"]|['"]full['"]|\b_TIERS\b|\b_tier\s*\(/
// `mintTier` adjacent to a comparison / conditional operator, or as a control-flow subject.
const MINTTIER_BRANCH = /mintTier\s*(?:===|!==|==|!=|>=|<=|>|<|\?)|(?:===|!==|==|!=|&&|\|\||\?|:)\s*mintTier\b|\b(?:if|switch|while)\s*\([^)]*\bmintTier\b/

describe('B. matcher self-tests (a lint that matches nothing is worse than no lint)', () => {
  it('B0a TIER_VALUE flags the forms a variant mode would use', () => {
    expect(TIER_VALUE.test("if (mintTier === TIER.THUMB) return null")).toBe(true)
    expect(TIER_VALUE.test("const cls = mintTier === 'thumb' ? 'sm' : 'lg'")).toBe(true)
    expect(TIER_VALUE.test("const t = _tier(mintTier)")).toBe(true)
  })
  it('B0b TIER_VALUE does NOT flag the body\'s legitimate non-tier strings', () => {
    expect(TIER_VALUE.test("fallback = 'placeholder'")).toBe(false)
    expect(TIER_VALUE.test("if (fallback !== 'none') setTerminal(true)")).toBe(false)
    expect(TIER_VALUE.test("hasFallback = false")).toBe(false)
  })
  it('B0c MINTTIER_BRANCH flags a branch and NOT a pass-through', () => {
    expect(MINTTIER_BRANCH.test("if (mintTier === 'thumb') return null")).toBe(true)
    expect(MINTTIER_BRANCH.test("const w = mintTier ? 64 : 800")).toBe(true)
    expect(MINTTIER_BRANCH.test("switch (mintTier) {")).toBe(true)
    expect(MINTTIER_BRANCH.test("const cached = _cache.get(_key(photoId, mintTier))")).toBe(false)
    expect(MINTTIER_BRANCH.test("}, [photoId, apiFetch, mintTier, onRemint, adopt])")).toBe(false)
  })
})

describe('B. mintTier is an identity, not a variant mode (the frozen contract survives)', () => {
  it('B1 the marker the body scan slices on still exists', () => {
    expect(SRC_TEXT.indexOf(BODY_MARK)).toBeGreaterThan(0)
    expect(BODY.startsWith(BODY_MARK)).toBe(true)
  })

  it('B2 the component body names no tier VALUE — so it cannot compare against one', () => {
    const offenders = BODY.split('\n').filter(l => TIER_VALUE.test(l)).map(l => l.trim())
    expect(offenders, `the body names a tier value; that is a variant mode, which the frozen contract bans:\n${offenders.join('\n')}`).toEqual([])
  })

  it('B3 the component body never branches on mintTier', () => {
    const offenders = BODY.split('\n').filter(l => MINTTIER_BRANCH.test(l)).map(l => l.trim())
    expect(offenders, `mintTier is being branched on — it must reach the mint URL and the cache key and nothing else:\n${offenders.join('\n')}`).toEqual([])
  })

  // The behavioural half of B2/B3: same props, different tier, byte-identical DOM.
  it('B4 the rendered img is byte-identical across tiers', () => {
    const props = { photoId: 'b4', initialUrl: 'https://s3/a.jpg', alt: 'Tomato', className: 'c', style: { borderRadius: 12 }, 'data-testid': 'tt' }
    const t = render(<PhotoImg {...props} mintTier={TIER.THUMB} />)
    const f = render(<PhotoImg {...props} mintTier={TIER.FULL} />)
    const none = render(<PhotoImg {...props} />)
    expect(t.container.innerHTML).toBe(f.container.innerHTML)
    expect(t.container.innerHTML).toBe(none.container.innerHTML)
  })

  it('B5 the TERMINAL / placeholder render is byte-identical across tiers too (a11y included)', async () => {
    const err = new Error('gone'); err.status = 404
    fetchSpy.mockRejectedValue(err)
    const props = { initialUrl: 'https://s3/a.jpg', alt: 'Tomato' }
    const t = render(<PhotoImg {...props} photoId="b5t" mintTier={TIER.THUMB} />)
    const f = render(<PhotoImg {...props} photoId="b5f" mintTier={TIER.FULL} />)
    failPhotoLoad(() => img(t.container)); failPhotoLoad(() => img(f.container))
    await waitFor(() => expect(img(t.container)).toBeNull())
    await waitFor(() => expect(img(f.container)).toBeNull())
    expect(t.container.innerHTML).toBe(f.container.innerHTML)
    expect(t.container.querySelector('div').getAttribute('role')).toBe('img')   // not a vacuous ''==''
  })

  it('B6 mintTier never reaches the DOM (destructured, not left in ...rest)', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(<PhotoImg photoId="b6" initialUrl="https://s3/a.jpg" alt="x" mintTier={TIER.THUMB} />)
    const names = img(container).getAttributeNames()
    expect(names.filter(n => /mint|tier/i.test(n))).toEqual([])
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/mintTier/)   // React's unknown-prop warning
    warn.mockRestore()
  })
})

// ── §C — the cache is keyed on (photoId, tier) ────────────────────────────────────────────────
// EVERY case in this block goes red against the pre-lane single-key `_cache.get(photoId)`.
describe('C. one photo id, two tiers, two cache slots', () => {
  const ID = 'c-shared'
  const THUMB_URL = 'https://s3.example.invalid/thumbs/c/a.jpg?sig=thumb'
  const FULL_URL = 'https://s3.example.invalid/c/a.jpg?sig=full'

  it('C1 a seeded thumb URL and a seeded full URL for the SAME id do not collide', async () => {
    // Under one key the second seed OVERWRITES the first, so the thumb instance adopts FULL_URL —
    // a 2.97 MB original painted into a 180 px tile, silently and with zero network to notice it by.
    __seedPhotoImgUrl(ID, THUMB_URL, undefined, TIER.THUMB)
    __seedPhotoImgUrl(ID, FULL_URL, undefined, TIER.FULL)
    const t = render(<PhotoImg photoId={ID} mintTier={TIER.THUMB} alt="tile" />)
    await waitFor(() => expect(src(t.container)).toBe(THUMB_URL))
    const f = render(<PhotoImg photoId={ID} mintTier={TIER.FULL} alt="hero" />)
    await waitFor(() => expect(src(f.container)).toBe(FULL_URL))
    expect(fetchSpy).not.toHaveBeenCalled()   // both answered from cache: nothing masked by a re-fetch
  })

  it('C2 a warm THUMB slot does NOT answer a FULL mount-fetch (the Lightbox 163 KB hazard)', async () => {
    fetchSpy.mockResolvedValue({ view_url: FULL_URL })
    __seedPhotoImgUrl(ID, THUMB_URL, undefined, TIER.THUMB)
    const { container } = render(<PhotoImg photoId={ID} mintTier={TIER.FULL} alt="lightbox" />)
    await waitFor(() => expect(src(container)).toBe(FULL_URL))
    expect(fetchSpy).toHaveBeenCalledTimes(1)               // minted its own rather than inheriting
    expect(wireTier(requested()[0])).toBeNull()             // and minted it AS the full original
  })

  it('C3 co-visible thumb and full instances mint SEPARATELY and adopt their own URLs', async () => {
    fetchSpy.mockImplementation((path) => Promise.resolve({ view_url: String(path).includes('tier=thumb') ? THUMB_URL : FULL_URL }))
    const { container } = render(
      <div>
        <PhotoImg photoId={ID} mintTier={TIER.THUMB} alt="tile" />
        <PhotoImg photoId={ID} mintTier={TIER.FULL} alt="hero" />
      </div>,
    )
    await waitFor(() => expect(container.querySelectorAll('img').length).toBe(2))
    const srcs = [...container.querySelectorAll('img')].map(i => i.getAttribute('src'))
    expect(new Set(srcs).size).toBe(2)                       // in-flight dedup is per (id, tier), not per id
    expect(srcs).toEqual([THUMB_URL, FULL_URL])
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('C4 same-tier co-visible instances still share ONE in-flight mint (storm control intact)', async () => {
    let resolveIt
    fetchSpy.mockReturnValue(new Promise((r) => { resolveIt = r }))
    const { container } = render(
      <div>
        <PhotoImg photoId="c4" mintTier={TIER.THUMB} alt="a" />
        <PhotoImg photoId="c4" mintTier={TIER.THUMB} alt="b" />
      </div>,
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await act(async () => { resolveIt({ view_url: THUMB_URL }) })
    await waitFor(() => expect(container.querySelectorAll('img').length).toBe(2))
  })

  it('C5 the elapsed gate reads the rendered tier\'s slot, not the other tier\'s', async () => {
    fetchSpy.mockResolvedValue({ view_url: THUMB_URL })
    // THUMB is stale, FULL is fresh — and FULL is seeded SECOND on purpose, so that a single-key
    // cache ends up holding the FRESH stamp, sees "no heal needed" and leaves the tile on an expired
    // presign: a permanent blank on resume, the failure PhotoImg exists to prevent.
    __seedPhotoImgUrl(ID, 'https://s3/expired.jpg', Date.now() - PRESIGN_TTL_MS - 1, TIER.THUMB)
    __seedPhotoImgUrl(ID, FULL_URL, Date.now(), TIER.FULL)
    const { container } = render(<PhotoImg photoId={ID} mintTier={TIER.THUMB} hasFallback initialUrl="https://s3/expired.jpg" alt="tile" />)
    onScreen(img(container))
    foreground()
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    expect(wireTier(requested()[0])).toBe('thumb')
  })

  // C1–C5 all read the cache. C6/C7 cover the WRITE that _seed performs at mount, which nothing
  // else in the suite pins to a tier: a mutation making _seed stamp the full slot for a thumb
  // instance passed all 59 pre-existing photo tests.
  it('C6 a fresh THUMB mount is covered by the elapsed gate too (no flash-on-foreground)', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/never.jpg' })
    const { container } = render(<PhotoImg photoId="c6" mintTier={TIER.THUMB} initialUrl={THUMB_URL} alt="tile" />)
    onScreen(img(container))
    foreground()
    await act(async () => {})
    // If the mount stamp landed in the OTHER tier's slot this instance would look un-minted and
    // re-fetch on every app switch — NEW-4's flash-on-foreground, restored for every tile in a grid.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('C7 a rendered THUMB instance does not publish its URL as the answer for the FULL tier', async () => {
    fetchSpy.mockResolvedValue({ view_url: FULL_URL })
    render(<PhotoImg photoId={ID} mintTier={TIER.THUMB} initialUrl={THUMB_URL} alt="tile" />)   // _seed publishes
    await act(async () => {})
    expect(fetchSpy).not.toHaveBeenCalled()                                                     // the tile costs nothing
    const f = render(<PhotoImg photoId={ID} mintTier={TIER.FULL} alt="lightbox" />)             // id-only → mount-fetch
    await waitFor(() => expect(src(f.container)).toBe(FULL_URL))                                // minted its own
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(wireTier(requested()[0])).toBeNull()
  })
})

// ── §D — the client actually names a tier ─────────────────────────────────────────────────────
describe('D. the mint URL carries the tier', () => {
  it('D1 a THUMB heal requests ?tier=thumb', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/fresh-thumb.jpg' })
    const { container } = render(<PhotoImg photoId="d1" initialUrl="https://s3/stale.jpg" alt="x" mintTier={TIER.THUMB} />)
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(src(container)).toBe('https://s3/fresh-thumb.jpg'))
    expect(requested()).toEqual(['/api/photos/view-url/d1?tier=thumb'])
  })

  it('D2 a FULL heal requests the bare path — byte-identical to the shipped client', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/fresh.jpg' })
    const { container } = render(<PhotoImg photoId="d2" initialUrl="https://s3/stale.jpg" alt="x" mintTier={TIER.FULL} />)
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(src(container)).toBe('https://s3/fresh.jpg'))
    expect(requested()).toEqual(['/api/photos/view-url/d2'])
  })

  it('D3 no mintTier at all is the same wire request as mintTier=FULL', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/fresh.jpg' })
    const { container } = render(<PhotoImg photoId="d3" initialUrl="https://s3/stale.jpg" alt="x" />)
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    expect(requested()).toEqual(['/api/photos/view-url/d3'])
  })

  it('D4 a tier=THUMB PhotoView heals the THUMB, then the ORIGINAL once the chain has degraded', async () => {
    const row = { id: 'd4', thumb_url: 'https://s3/t.jpg', view_url: 'https://s3/f.jpg' }
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/minted.jpg' })
    const { container } = render(<PhotoView photo={row} tier={TIER.THUMB} alt="tile" />)
    onScreen(img(container))
    // Step 0 — still on the thumb. A proactive heal here must renew the THUMB.
    __seedPhotoImgUrl('d4', 'https://s3/t.jpg', Date.now() - PRESIGN_TTL_MS - 1, TIER.THUMB)
    foreground()
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    expect(wireTier(requested()[0])).toBe('thumb')
    // The thumb object does not exist → <img> 404 → the chain advances to the in-hand original, and
    // the SAME prop now renews the original instead.
    await waitFor(() => expect(src(container)).toBe('https://s3/minted.jpg'))
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(src(container)).toBe('https://s3/f.jpg'))
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    expect(wireTier(requested()[1])).toBeNull()
  })
})

// ── §E — a thumb that has no object ───────────────────────────────────────────────────────────
// thumb_url is presigned by CONVENTION and presigning never touches S3, so it is a non-empty string
// on all 1094 live rows while only 913 have an object. The 404 arrives from the <img>, and the whole
// answer is the in-hand original — deliberately NOT a HEAD probe, which would spend an S3 round trip
// on every heal to learn what the next <img> error reports for free.
describe('E. a missing thumb degrades on the in-hand original, with no probe', () => {
  const row = { id: 'e1', thumb_url: 'https://s3/missing-thumb.jpg', view_url: 'https://s3/original.jpg' }

  it('E1 the 404 swaps in the full source with ZERO network calls', async () => {
    const { container } = render(<PhotoView photo={row} tier={TIER.THUMB} alt="tile" />)
    expect(src(container)).toBe('https://s3/missing-thumb.jpg')
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(src(container)).toBe('https://s3/original.jpg'))
    expect(fetchSpy).not.toHaveBeenCalled()   // no probe, no mint: the degrade target came down in the same response
  })

  it('E2 the retry budget is NOT spent on the degrade — the original still gets its one heal', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/healed.jpg' })
    const { container } = render(<PhotoView photo={row} tier={TIER.THUMB} alt="tile" />)
    failPhotoLoad(() => img(container))                                   // thumb 404 → degrade, budget untouched
    await waitFor(() => expect(src(container)).toBe('https://s3/original.jpg'))
    failPhotoLoad(() => img(container))                                   // original expired → its own heal
    await waitFor(() => expect(src(container)).toBe('https://s3/healed.jpg'))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(wireTier(requested()[0])).toBeNull()                       // heals the ORIGINAL, not the absent thumb
  })

  it('E3 a row with NO thumb at all never asks for one', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/healed.jpg' })
    const { container } = render(<PhotoView photo={{ id: 'e3', view_url: 'https://s3/original.jpg' }} tier={TIER.THUMB} alt="tile" />)
    expect(src(container)).toBe('https://s3/original.jpg')
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    expect(wireTier(requested()[0])).toBeNull()
  })

  it('E4 nothing in the degrade path issues a HEAD (or any non-GET) request', async () => {
    fetchSpy.mockResolvedValue({ view_url: 'https://s3/healed.jpg' })
    const { container } = render(<PhotoView photo={row} tier={TIER.THUMB} alt="tile" />)
    onScreen(img(container))
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(src(container)).toBe('https://s3/original.jpg'))
    failPhotoLoad(() => img(container))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    for (const [, init] of fetchSpy.mock.calls) expect((init?.method ?? 'GET').toUpperCase()).toBe('GET')
  })
})

afterEach(() => { vi.restoreAllMocks() })
