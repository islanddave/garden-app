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
// A cross-origin photo now spends one absorbed CORS attempt before an error reaches the heal.
// failPhotoLoad says "the image failed" and is blind to the flag; PhotoImg.cors.test.jsx owns the retry.
import { failPhotoLoad } from './helpers/photoLoadFailure.js'

beforeEach(() => { apiFetchSpy.mockReset(); __resetPhotoImgCache() })

const PL = {
  id: 'pl1', project_id: 'pr1', name: 'Cherokee Purple', status: 'seedling',
  crop_type: 'Tomato', crop_type_slug: 'tomato', variety_name: 'Cherokee Purple', planted_date: '2026-04-01',
  // Both pills read the cultivar join, not the flat columns (keyFact.js selectCropType/selectKeyFact).
  // Only keys the plants Lambda's variety_ref blocks emit (lambda/plants/index.js). Until 2026-10-11 this
  // carried `type: 'Tomato'`, which no block sends, so the chip below was asserted through
  // selectCropType's explicit-field branch, one prod never takes (BUG-HEROPHOTOPHANTOMFIXTURE-001).
  // The gold pill is this tomato's days: its growth type is the crop card's green pill, not the hero's
  // (V5-PLANTPAGEDESIGNQS-001 part 1, 2026-10-12).
  variety_ref: { name: 'Cherokee Purple', crop_type_slug: 'tomato', growth_habit: 'indeterminate',
    days_to_maturity_min: 80, days_to_maturity_max: 90 },
}
// The chip shows only when the NAME says pepper/tomato; its words are the cultivar's crop type.
const PL_NAMED = {
  ...PL, id: 'pl2', name: 'Purple Blush Tomatillo', variety_name: 'Purple Blush',
  crop_type: 'Tomatillo', crop_type_slug: 'tomatillo',
  variety_ref: { name: 'Purple Blush', crop_type_slug: 'tomatillo', growth_habit: null },
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

  it('renders the StatusPicker, key-fact pill and Details pill', () => {
    mount()
    expect(screen.getByRole('combobox', { name: /change planting status/i })).toBeTruthy()
    expect(screen.getByText('80–90 days')).toBeTruthy()          // gold key-fact pill
    expect(screen.queryByText('Indeterminate')).toBeNull()       // the card's word, never the hero's
    const details = screen.getByRole('button', { name: /details/i })
    expect(details.getAttribute('aria-haspopup')).toBe('dialog')
  })

  // A tomato whose name never says "tomato" wears the chip too (V5-PLANTPAGEDESIGNQS-001; keyFact.js
  // selectCropType; PlantingDetail.heroCropChip.test.jsx owns the page level).
  it('a tomato named by cultivar alone wears the crop-type pill', () => {
    mount()
    const chip = screen.getByText('Tomato')
    expect(screen.getByRole('heading', { level: 1 }).nextElementSibling.contains(chip)).toBe(true)
  })

  it('renders the crop-type pill, worded from crop_type_slug', () => {
    mount({ planting: PL_NAMED })
    const chip = screen.getByText('Tomatillo')
    expect(chip.tagName).toBe('SPAN')
    expect(screen.getByRole('heading', { level: 1 }).nextElementSibling.contains(chip)).toBe(true)
    expect(screen.queryByText('Tomato')).toBeNull()              // the name heuristic never words it
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
    failPhotoLoad(() => container.querySelector('img'))
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
