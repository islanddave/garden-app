// HeroPhoto — the PLANTING specialization of the tier-agnostic PhotoHero shell (front-of-roadmap
// Wave 2C). These assertions are the standing visual/structural parity gate for the extraction: the
// composed tree must still carry the shell chrome (container box, both scrims, Back/Share) AND every
// planting affordance (the <h1> name, StatusPicker, crop-type + key-fact pills, Details pill, hero
// Favorite entityType="plant", and the no-photo crop glyph + /log?plant= deep-link) — in that order,
// in the photo, no-photo AND terminal-error states.
//
// Written against the PRE-extraction render: the four states below were dumped byte-for-byte before
// and after the refactor and diffed clean. Any change here is a hero regression, not a test bug.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))
vi.mock('../context/FavoritesContext.jsx', () => ({ useFavorites: () => ({ isFavorite: () => false, setFavorite: vi.fn() }) }))

import HeroPhoto from '../components/planting/HeroPhoto.jsx'
import { __resetPhotoImgCache } from '../components/PhotoImg.jsx'

beforeEach(() => { apiFetchSpy.mockReset(); __resetPhotoImgCache() })

const PL = {
  id: 'pl1', project_id: 'pr1', name: 'Cherokee Purple', status: 'seedling',
  crop_type: 'Tomato', crop_type_slug: 'tomato', variety_name: 'Cherokee Purple', planted_date: '2026-04-01',
  // Both pills read the cultivar join, not the flat columns (keyFact.js selectCropType/selectKeyFact).
  variety_ref: { type: 'Tomato', crop_type_slug: 'tomato', growth_habit: 'indeterminate' },
}
const scrims = (c) => [...c.querySelectorAll('div')].filter(d =>
  d.style.pointerEvents === 'none' && d.style.background.includes('linear-gradient'))

function mount(props = {}) {
  return render(
    <MemoryRouter>
      <HeroPhoto planting={PL} src="https://s3/a.jpg" photoId="ph1" alt="Cherokee Purple photo"
        onOpenLightbox={() => {}} onOpenDetails={() => {}} onStatusChanged={() => {}} {...props} />
    </MemoryRouter>)
}

describe('HeroPhoto — shell delegated to PhotoHero', () => {
  it('renders one 4:3 clipped hero box with both scrims', () => {
    const { container } = mount()
    const box = container.firstChild
    expect(box.style.aspectRatio).toBe('4 / 3')
    expect(box.style.maxHeight).toBe('420px')
    expect(box.style.borderRadius).toBe('12px')
    expect(box.style.overflow).toBe('hidden')
    const [top, bottom] = scrims(container)
    expect([top.style.height, bottom.style.height]).toEqual(['88px', '180px'])
    expect(scrims(container)).toHaveLength(2)
  })

  it('renders Back and the planting-labelled Share as 44px floating controls', () => {
    mount()
    const back = screen.getByRole('button', { name: 'Back' })
    const share = screen.getByRole('button', { name: 'Share this planting' })
    for (const b of [back, share]) {
      expect(b.style.width).toBe('44px')
      expect(b.style.minHeight).toBe('44px')
      expect(b.style.borderRadius).toBe('50%')
    }
  })

  it('composes PhotoHero — no second hero shell is inlined here', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(process.cwd(), 'src/components/planting/HeroPhoto.jsx'), 'utf8')
    expect(src.includes('<PhotoHero')).toBe(true)
    expect(src.includes('PhotoImg')).toBe(false)                 // the image layer is the shell's job
    expect(/aspectRatio|linear-gradient|aria-label="Back"/.test(src)).toBe(false)
  })
})

describe('HeroPhoto — photo state', () => {
  it('renders the featured photo behind a "View <name> photo" tap target', () => {
    const { container } = mount()
    const btn = screen.getByRole('button', { name: 'View Cherokee Purple photo' })
    const img = container.querySelector('img')
    expect(img.getAttribute('src')).toBe('https://s3/a.jpg')
    expect(img.getAttribute('alt')).toBe('Cherokee Purple photo')
    expect(img.style.objectFit).toBe('cover')
    expect(btn.contains(img)).toBe(true)
  })

  it('opens the lightbox at index 0', () => {
    const onOpenLightbox = vi.fn()
    mount({ onOpenLightbox })
    fireEvent.click(screen.getByRole('button', { name: 'View Cherokee Purple photo' }))
    expect(onOpenLightbox).toHaveBeenCalledWith(0)
  })

  it('falls back to "<name> photo" alt when the consumer gives none', () => {
    const { container } = mount({ alt: undefined })
    expect(container.querySelector('img').getAttribute('alt')).toBe('Cherokee Purple photo')
  })
})

describe('HeroPhoto — planting chrome in the overlay', () => {
  it('renders the name AS the page <h1>', () => {
    mount()
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1.textContent).toBe('Cherokee Purple')
  })

  it('renders the StatusPicker, crop-type pill, key-fact pill and Details pill', () => {
    mount()
    expect(screen.getByRole('combobox', { name: /change planting status/i })).toBeTruthy()
    expect(screen.getByText('Tomato')).toBeTruthy()              // crop-type pill
    expect(screen.getByText('Indeterminate')).toBeTruthy()       // gold key-fact pill
    const details = screen.getByRole('button', { name: /details/i })
    expect(details.getAttribute('aria-haspopup')).toBe('dialog')
  })

  it('the Details pill calls onOpenDetails', () => {
    const onOpenDetails = vi.fn()
    mount({ onOpenDetails })
    fireEvent.click(screen.getByRole('button', { name: /details/i }))
    expect(onOpenDetails).toHaveBeenCalled()
  })

  it('renders exactly one Favorite — the hero heart — immediately after Share', () => {
    mount()
    const favs = screen.getAllByRole('button', { name: 'Favorite' })
    expect(favs).toHaveLength(1)
    const share = screen.getByRole('button', { name: 'Share this planting' })
    expect(share.nextElementSibling.contains(favs[0])).toBe(true)
    expect(share.nextElementSibling.style.width).toBe('44px')    // matches the floating-control chrome
  })
})

describe('HeroPhoto — no-photo state', () => {
  it('renders the crop glyph and the "add first photo" deep-link instead of an image', () => {
    const { container } = mount({ src: null, photoId: null })
    expect(container.querySelector('img')).toBeNull()
    const link = screen.getByLabelText('Add the first photo for this planting')
    expect(link.getAttribute('href')).toBe('/log?project=pr1&plant=pl1')
    expect(within(link.parentElement).getByText('Tap to add first photo')).toBeTruthy()
    expect(link.parentElement.querySelector('svg')).toBeTruthy()  // per-crop-family glyph
    expect(link.parentElement.style.justifyContent).toBe('center')
  })

  it('keeps the full shell + overlay chrome with no photo', () => {
    const { container } = mount({ src: null, photoId: null })
    expect(scrims(container)).toHaveLength(2)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Cherokee Purple')
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Share this planting' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Favorite' })).toHaveLength(1)
  })
})

describe('HeroPhoto — degraded states', () => {
  it('a terminal photo error keeps the hero box and every affordance', async () => {
    apiFetchSpy.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }))
    const { container } = mount()
    fireEvent.error(container.querySelector('img'))
    await waitFor(() => expect(container.querySelector('img')).toBeNull())
    const ph = screen.getByRole('img', { name: 'Cherokee Purple photo' })
    expect(ph.style.objectFit).toBe('cover')                      // placeholder reserves the same box
    expect(scrims(container)).toHaveLength(2)
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
  })

  it('renders with a minimal planting (no name/crop/dates) without throwing', () => {
    const { container } = render(<MemoryRouter><HeroPhoto planting={{ id: 'p0' }} /></MemoryRouter>)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Planting')
    expect(screen.getByRole('button', { name: 'Share this planting' })).toBeTruthy()
    expect(scrims(container)).toHaveLength(2)
  })

  it('renders with no planting at all', () => {
    render(<MemoryRouter><HeroPhoto /></MemoryRouter>)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Planting')
  })
})
