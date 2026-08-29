// PhotoHero — the tier-agnostic hero shell (front-of-roadmap Wave 2C). Proves the shell owns the
// container/scrims/Back/Share/no-photo box, composes PhotoImg for the image layer (self-heal wiring
// intact — NOT a bare <img>), and knows nothing about the tier: every tier affordance arrives via a
// slot. The planting specialization is asserted separately in HeroPhoto.test.jsx.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn(), navigateSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('react-router-dom', async (orig) => ({ ...(await orig()), useNavigate: () => navigateSpy }))

import PhotoHero, { HERO_FLOAT_BTN } from '../components/PhotoHero.jsx'
import { __resetPhotoImgCache } from '../components/PhotoImg.jsx'
// A cross-origin photo now spends one absorbed CORS attempt before an error reaches the heal.
// failPhotoLoad says "the image failed" and is blind to the flag; PhotoImg.cors.test.jsx owns the retry.
import { failPhotoLoad } from './helpers/photoLoadFailure.js'

beforeEach(() => { apiFetchSpy.mockReset(); navigateSpy.mockReset(); __resetPhotoImgCache() })

// The two scrims: absolutely-positioned, click-through, gradient-painted.
const scrims = (c) => [...c.querySelectorAll('div')].filter(d =>
  d.style.pointerEvents === 'none' && d.style.background.includes('linear-gradient'))

describe('PhotoHero — image layer', () => {
  it('renders the image through PhotoImg (not a bare <img>): photoId is wired to the self-heal re-mint', async () => {
    apiFetchSpy.mockResolvedValue({ view_url: 'https://s3/fresh.jpg' })
    const { container } = render(<PhotoHero src="https://s3/stale.jpg" photoId="p1" alt="A photo" onOpenImage={() => {}} />)
    const img = container.querySelector('img')
    expect(img.getAttribute('src')).toBe('https://s3/stale.jpg')
    expect(img.getAttribute('alt')).toBe('A photo')
    expect(img.style.objectFit).toBe('cover')
    failPhotoLoad(() => container.querySelector('img'))
    await waitFor(() => expect(container.querySelector('img').getAttribute('src')).toBe('https://s3/fresh.jpg'))
    expect(apiFetchSpy).toHaveBeenCalledWith('/api/photos/view-url/p1', { cache: 'no-store' })
  })

  it('wraps the image in a full-bleed open button labelled by openLabel, and fires onOpenImage', () => {
    const onOpenImage = vi.fn()
    const { container } = render(<PhotoHero src="https://s3/a.jpg" photoId="p2" openLabel="View the thing" onOpenImage={onOpenImage} />)
    const btn = screen.getByRole('button', { name: 'View the thing' })
    expect(btn.style.inset).toMatch(/^0(px)?$/)
    expect(btn.contains(container.querySelector('img'))).toBe(true)
    fireEvent.click(btn)
    expect(onOpenImage).toHaveBeenCalledTimes(1)
  })

  it('renders the image un-wrapped (self-positioned) when no onOpenImage is given', () => {
    const { container } = render(<PhotoHero src="https://s3/a.jpg" photoId="p3" />)
    const img = container.querySelector('img')
    expect(img.closest('button')).toBeNull()
    expect(img.style.position).toBe('absolute')
    expect(img.style.objectFit).toBe('cover')
  })

  it('a terminal image error keeps the hero box (PhotoImg placeholder inherits the image styling)', async () => {
    apiFetchSpy.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }))
    const { container } = render(<PhotoHero src="https://s3/dead.jpg" photoId="p4" alt="A photo" onOpenImage={() => {}} />)
    failPhotoLoad(() => container.querySelector('img'))
    await waitFor(() => expect(container.querySelector('img')).toBeNull())
    const ph = screen.getByRole('img', { name: 'A photo' })
    expect(ph.style.objectFit).toBe('cover')
    expect(scrims(container)).toHaveLength(2)                       // chrome survives the failure
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
  })
})

describe('PhotoHero — no-photo state', () => {
  it('renders the emptyState slot in a centered box and no image', () => {
    const { container } = render(<PhotoHero src={null} emptyState={<a href="/add">Add a photo</a>} />)
    expect(container.querySelector('img')).toBeNull()
    const cta = screen.getByText('Add a photo')
    const box = cta.parentElement
    expect(box.style.inset).toMatch(/^0(px)?$/)
    expect(box.style.justifyContent).toBe('center')
    expect(box.style.alignItems).toBe('center')
  })

  it('keeps the full shell (scrims + Back + Share) with no photo', () => {
    const { container } = render(<PhotoHero src={null} />)
    expect(scrims(container)).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy()
  })
})

describe('PhotoHero — shell chrome', () => {
  it('renders exactly two scrims: a top scrim and a taller bottom scrim, both click-through', () => {
    const { container } = render(<PhotoHero src="https://s3/a.jpg" photoId="p5" onOpenImage={() => {}} />)
    const [top, bottom] = scrims(container)
    expect(top.style.top).toBe('0px')
    expect(top.style.height).toBe('88px')
    expect(bottom.style.bottom).toBe('0px')
    expect(bottom.style.height).toBe('180px')
    expect(scrims(container)).toHaveLength(2)
  })

  it('the container is a 4:3 rounded, clipped box', () => {
    const { container } = render(<PhotoHero src={null} />)
    const box = container.firstChild
    expect(box.style.position).toBe('relative')
    expect(box.style.aspectRatio).toBe('4 / 3')
    expect(box.style.maxHeight).toBe('420px')
    expect(box.style.borderRadius).toBe('12px')
    expect(box.style.overflow).toBe('hidden')
  })

  it('Back navigates back', () => {
    render(<PhotoHero src={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(navigateSpy).toHaveBeenCalledWith(-1)
  })

  it('Share invokes Web Share with the given title/url, and is inert (no throw) without it', () => {
    const share = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true })
    render(<PhotoHero src={null} shareTitle="A title" shareUrl="https://x/y" shareLabel="Share this" />)
    fireEvent.click(screen.getByRole('button', { name: 'Share this' }))
    expect(share).toHaveBeenCalledWith({ title: 'A title', url: 'https://x/y' })

    delete navigator.share
    fireEvent.click(screen.getByRole('button', { name: 'Share this' }))   // unsupported → inert, no throw
  })

  it('defaults shareUrl to the current location', () => {
    const share = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true })
    render(<PhotoHero src={null} shareTitle="T" />)
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    expect(share).toHaveBeenCalledWith({ title: 'T', url: window.location.href })
    delete navigator.share
  })

  it('renders tier `actions` beside Share and the `overlay` slot inside the box', () => {
    const { container } = render(
      <PhotoHero src={null} actions={<span data-testid="fav">fav</span>} overlay={<div data-testid="ov">ov</div>} />)
    const fav = screen.getByTestId('fav')
    expect(fav.previousElementSibling).toBe(screen.getByRole('button', { name: 'Share' }))
    expect(container.firstChild.contains(screen.getByTestId('ov'))).toBe(true)
  })

  it('exports the floating-control style so a specializer matches Back/Share exactly', () => {
    render(<PhotoHero src={null} />)
    const back = screen.getByRole('button', { name: 'Back' })
    expect(HERO_FLOAT_BTN.width).toBe(44)
    expect(back.style.width).toBe('44px')
    expect(back.style.borderRadius).toBe('50%')
  })
})

describe('PhotoHero — tier agnosticism', () => {
  it('renders with no tier props at all', () => {
    const { container } = render(<PhotoHero />)
    expect(container.firstChild).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy()
    expect(screen.queryByRole('heading')).toBeNull()                // no tier chrome of its own
  })

  // Structural guard against the shell re-acquiring tier knowledge (the exact drift the extraction
  // exists to prevent): its imports are frozen to the generic surfaces, and its code (comments
  // stripped — the header prose legitimately explains the tiers) names no domain noun.
  it('imports nothing tier-specific and names no domain noun', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const raw = readFileSync(join(process.cwd(), 'src/components/PhotoHero.jsx'), 'utf8')
    const imports = [...raw.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort()
    expect(imports).toEqual(['../lib/constants.js', './Icon.jsx', './PhotoImg.jsx', 'react', 'react-router-dom'])
    const code = raw.replace(/^\s*\/\/.*$/gm, '')
    expect(/planting|\bcrop|favorite|status|harvest/i.test(code)).toBe(false)
  })
})
