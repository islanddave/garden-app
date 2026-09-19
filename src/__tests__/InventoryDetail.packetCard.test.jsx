// V5-SEEDCARDS-001 — the seed's detail page shows its packet picture, big, and the cultivar facts.
//
// Dave, 2026-09-19: each seed shows its packet image, "also a bigger version of it on the seed's detail
// page", with the details filled in (country of origin, packet URL, heat). UX spec §7 is the design;
// this file pins it and pins the other half of the brief just as hard: EVERY OTHER CATEGORY RENDERS
// EXACTLY AS IT DID.
//
// WHAT JSDOM CANNOT SEE, AND HOW THIS FILE COPES. jsdom never loads an image, so the picture is
// asserted by what PhotoImg was ASKED for — PhotoImg is mocked to a prop readout, and the REAL PhotoView
// above it still makes the tier decision. That is why the seed fixture carries a thumb URL the by-id
// GET does not send today: with no thumb in hand, TIER.THUMB and TIER.FULL resolve to the same single
// source and a tier assertion could not tell them apart.
//
// NEGATIVES CARRY THEIR OWN ANCHOR. Every "X is absent" assertion below sits in a test that first
// proves the surface it is absent FROM rendered — against the pre-change page all of them go red on
// the anchor, never green on the absence (run against base a3eb208's InventoryDetail.jsx, 2026-09-19).
//
// THE BYTE PINS at the bottom were captured from base a3eb208 — the page before this change — and are
// compared after it. Regenerate deliberately, never to "fix" a red run; a diff is the point:
//   INVDETAIL_BASE_BYTES_WRITE=1 npx vitest run src/__tests__/InventoryDetail.packetCard.test.jsx
//
// No jest-dom (L-182): plain DOM reads.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'

const { fetchSpy, navigateSpy, updateItemSpy, deleteItemSpy, paramsRef } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  updateItemSpy: vi.fn(),
  deleteItemSpy: vi.fn(),
  paramsRef: { current: { id: 'inv-seed-1' } },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useParams: () => paramsRef.current,
  useNavigate: () => navigateSpy,
}))
vi.mock('../hooks/useInventory.js', () => ({
  useInventory: () => ({ updateItem: updateItemSpy, deleteItem: deleteItemSpy }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span data-testid="favorite-toggle" /> }))
// A PROP READOUT, not a stub: every prop the page hands PhotoUpload is serialised (functions as
// '[fn]'), so a changed call site — a new prop, a dropped id, a different label — changes the bytes.
// The input carries the real `inputId`, which is the contract the "Add packet photo" box drives, and
// `finish` stands in for a completed upload.
vi.mock('../components/PhotoUpload.jsx', () => ({
  default: (props) => (
    <span data-testid="photo-upload"
      data-props={JSON.stringify(props, (k, v) => (typeof v === 'function' ? '[fn]' : v))}>
      <input id={props.inputId} type="file" data-testid="photo-upload-input" hidden />
      <button type="button" data-testid="photo-upload-trigger" style={props.buttonStyle}>
        {props.buttonLabel ?? 'Add Photo'}
      </button>
      <button type="button" data-testid="photo-upload-finish"
        onClick={() => props.onUploadComplete?.({ id: 'ph-uploaded' })}>finish</button>
    </span>
  ),
}))
vi.mock('../components/PhotoImg.jsx', () => ({
  default: ({ photoId, initialUrl, mintTier, alt, onLoad: _l, onOpen: _o, onError: _e, hasFallback: _h, fallback: _f, style: _s, ...rest }) => (
    <img alt={alt ?? ''} data-photo-id={photoId ?? ''} data-initial-url={initialUrl ?? ''}
      data-mint-tier={mintTier ?? ''} {...rest} />
  ),
}))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'
import { shuLabel } from '../lib/varietySpec.js'
import { SUPPLIER_COLORS } from '../lib/supplierPalette.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const SOURCES = [
  { id: 'src-botanical', name: 'Botanical Interests', kind: 'seed_company', locality: null, address: null, website_url: null, notes: null },
  { id: 'src-sandia', name: 'Sandia Seed Company', kind: 'seed_company', locality: null, address: null, website_url: null, notes: null },
]

const VIEW_URL = 'https://photos.example.test/inventory/inv-seed-1/ph-hero.jpg?sig=1'
const THUMB_URL = 'https://photos.example.test/thumbs/inventory/inv-seed-1/ph-hero.jpg?sig=1'

// A pepper lot as GET /:id returns it since e36c2d1: `i.*`, the DERIVED hero (featured_photo_id is
// overridden with it and hero_photo_id repeats it), the full-size URL, and the cultivar facts.
const PEPPER = {
  id: 'inv-seed-1', name: 'Carolina Reaper', type: 'consumable', category: 'seeds', status: 'active',
  quantity_on_hand: 1, unit: 'packet', reorder_threshold: null, reorder_quantity: null,
  unit_cost: null, quantity_purchased: null, purchase_date: null, location_text: null,
  brand: null, model: null, condition: null, notes: null,
  source: null, source_url: 'https://www.sandiaseed.com/products/carolina-reaper',
  source_id: 'src-sandia', acquired_from_source_id: null,
  variety_id: 'var-reaper', variety_name: 'Carolina Reaper', crop_slug: 'pepper',
  seed_stage: null, source_plant_id: null, source_kind: null, year_harvested: null, germination: null,
  featured_photo_id: 'ph-hero', hero_photo_id: 'ph-hero', featured_photo_view_url: VIEW_URL,
  featured_photo_thumb_url: THUMB_URL,
  scoville_min: 1200000, scoville_max: 2000000,
  origin_country: 'United States', origin_region: 'South Carolina', species: 'Capsicum chinense',
  days_to_maturity_min: 90, days_to_maturity_max: 120, dtm_basis: 'from-transplant',
  breeding_system: 'open_pollinated',
  variety_source_url: 'https://www.johnnyseeds.com/vegetables/peppers/hot-peppers/carolina-reaper.html',
}
const NO_PHOTO = {
  ...PEPPER, featured_photo_id: null, hero_photo_id: null, featured_photo_view_url: null,
  featured_photo_thumb_url: null,
}

// A durable and a consumable, one each, so both halves of the form are inside the byte pins. Both
// carry the photo and cultivar keys every GET /:id row now has (null facts: no cultivar), because the
// claim is that NONE of it reaches a non-seed page — not merely that it has nothing to show.
const NON_SEED_EXTRAS = {
  featured_photo_id: 'ph-tool', hero_photo_id: 'ph-tool',
  featured_photo_view_url: 'https://photos.example.test/inventory/inv-tool-1/ph-tool.jpg?sig=1',
  crop_slug: null, variety_name: null, scoville_min: null, scoville_max: null, origin_country: null,
  origin_region: null, species: null, days_to_maturity_min: null, days_to_maturity_max: null,
  dtm_basis: null, breeding_system: null, variety_source_url: null, germination: null,
}
const TOOL = {
  id: 'inv-tool-1', name: 'Hori hori knife', type: 'durable', category: 'tools', status: 'active',
  quantity: 1, condition: 'good', brand: 'Nisaku', model: 'NJP650',
  quantity_on_hand: null, unit: null, reorder_threshold: null, reorder_quantity: null,
  unit_cost: '24.99', quantity_purchased: 1, purchase_date: '2026-03-04', location_text: 'Stable rack',
  notes: 'shed shelf', source: 'order no. 350019', source_url: 'https://tools.example.test/hori',
  source_id: 'src-botanical', acquired_from_source_id: null, variety_id: null, year_harvested: null,
  ...NON_SEED_EXTRAS,
}
const AMENDMENT = {
  id: 'inv-amend-1', name: 'Neem oil', type: 'consumable', category: 'amendment', status: 'active',
  quantity_on_hand: 2, unit: 'oz', reorder_threshold: 1, reorder_quantity: 2,
  quantity: null, condition: null, brand: null, model: null,
  unit_cost: null, quantity_purchased: null, purchase_date: null, location_text: null,
  notes: null, source: null, source_url: null,
  source_id: null, acquired_from_source_id: null, variety_id: null, year_harvested: null,
  ...NON_SEED_EXTRAS, featured_photo_id: null, hero_photo_id: null, featured_photo_view_url: null,
}

// Rows by id; `queue` lets a test hand the SECOND read of one id a different row (the after-upload
// re-read). Every other path answers an empty list.
let rows
let queue
beforeEach(() => {
  fetchSpy.mockReset(); navigateSpy.mockReset(); updateItemSpy.mockReset(); deleteItemSpy.mockReset()
  updateItemSpy.mockResolvedValue({ item: {} })
  rows = {}
  queue = {}
  fetchSpy.mockImplementation((path) => {
    const m = /^\/api\/inventory-items\/([^/?]+)$/.exec(String(path))
    if (m) {
      const q = queue[m[1]]
      if (q && q.length) return Promise.resolve(q.shift())
      return rows[m[1]] ? Promise.resolve(rows[m[1]]) : Promise.reject(Object.assign(new Error('nf'), { status: 404 }))
    }
    if (path === '/api/varieties/sources') return Promise.resolve(SOURCES)
    return Promise.resolve([])
  })
  clearReloadBlocks()
})

async function renderPage(row, { wrap = (n) => n } = {}) {
  rows[row.id] = row
  paramsRef.current = { id: row.id }
  let out
  await act(async () => { out = render(wrap(<ToastProvider><InventoryDetail /></ToastProvider>)) })
  await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy())
  return out
}

const itemGets = (id) => fetchSpy.mock.calls.filter(([p, o]) => p === `/api/inventory-items/${id}` && !o).length
const card = () => screen.getByTestId('packet-card')
const facts = () => screen.getByTestId('packet-facts')
const factRows = () => Array.from(facts().querySelectorAll('[data-testid="packet-fact"]'))
  .map(n => [n.children[0].textContent, n.children[1].textContent])
const uploadProps = (node) => JSON.parse(node.getAttribute('data-props'))
// The link's visible line is hidden from AT; its accessible name is a separate sentence.
const linkLine = (a) => a.querySelector('[aria-hidden="true"]')?.textContent
const labelTexts = () => Array.from(document.querySelectorAll('label')).map(l => l.textContent.trim())

describe('the packet card — seeds only, right under the title', () => {
  it('sits between the title and the Plant-from-packet CTA', async () => {
    await renderPage(PEPPER)
    const h1 = screen.getByRole('heading', { level: 1 })
    const cta = screen.getByLabelText('Plant from Carolina Reaper')
    expect(h1.compareDocumentPosition(card()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(card().compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders the HERO photo at FULL tier — never the lot id, never the thumb', async () => {
    await renderPage(PEPPER)
    const img = card().querySelector('[data-testid="packet-photo"]')
    expect(img, 'no packet photo rendered').toBeTruthy()
    // The lot id here would re-point PhotoImg's expiry re-mint at /api/photos/view-url/<lotId>: a 404.
    expect(img.getAttribute('data-photo-id')).toBe('ph-hero')
    expect(img.getAttribute('data-photo-id')).not.toBe(PEPPER.id)
    // FULL: the viewer opens on these same bytes. The fixture carries a thumb precisely so a THUMB
    // request would pick it and red here.
    expect(img.getAttribute('data-mint-tier')).toBe('full')
    expect(img.getAttribute('data-initial-url')).toBe(VIEW_URL)
  })

  it('the image box is a button named for the packet, and it opens the app Lightbox on the same photo', async () => {
    await renderPage(PEPPER)
    expect(screen.queryByRole('dialog')).toBeNull()
    const open = screen.getByRole('button', { name: 'Enlarge packet photo of Carolina Reaper' })
    fireEvent.click(open)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('data-testid')).toBe('lightbox')
    const main = dialog.querySelector('[data-testid="lightbox-image"]')
    expect(main.getAttribute('data-photo-id')).toBe('ph-hero')
    expect(main.getAttribute('data-initial-url')).toBe(VIEW_URL)
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Android Back closes the viewer and leaves the page where it was', async () => {
    // A real history floor, the BackNav.history harness's reason: at index 0 a back() is a SILENT
    // no-op in jsdom, and "the dialog closed" must be caused by a Back that actually happened.
    let pops = 0
    const onPop = () => { pops += 1 }
    window.addEventListener('popstate', onPop)
    try {
      window.history.replaceState({ __base: 1 }, '')
      window.history.pushState({ __floor: 1 }, '')
      await renderPage(PEPPER, { wrap: (n) => <DismissRegistryProvider>{n}</DismissRegistryProvider> })
      fireEvent.click(screen.getByRole('button', { name: 'Enlarge packet photo of Carolina Reaper' }))
      expect(screen.getByRole('dialog')).toBeTruthy()
      expect(readMarker(window.history.state), 'opening the viewer armed no Back marker').toBeTruthy()

      const before = pops
      act(() => { window.history.back() })
      await waitFor(() => expect(pops, 'no popstate arrived — the Back never happened').toBe(before + 1))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      // Landed on the page's own entry: the viewer's marker was consumed, nothing below it.
      expect(window.history.state?.__floor).toBe(1)
      expect(readMarker(window.history.state)).toBeNull()
      expect(screen.getByTestId('packet-card')).toBeTruthy()
    } finally {
      window.removeEventListener('popstate', onPop)
    }
  })

  it('with no image the box says "Add packet photo" and opens the one upload input', async () => {
    await renderPage(NO_PHOTO)
    const add = screen.getByRole('button', { name: 'Add packet photo' })
    expect(card().contains(add)).toBe(true)
    // Not a viewer: nothing to enlarge, no image asked for.
    expect(screen.queryByRole('button', { name: /Enlarge packet photo/ })).toBeNull()
    expect(card().querySelector('[data-testid="packet-photo"]')).toBeNull()

    const input = document.getElementById('inventory-photo-inv-seed-1')
    expect(input, 'input#inventory-photo-<id> is missing').toBeTruthy()
    const clicked = vi.spyOn(input, 'click')
    fireEvent.click(add)
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('carries the ONE PhotoUpload on a seed page, inside the card, on the old contract', async () => {
    await renderPage(PEPPER)
    const uploads = screen.getAllByTestId('photo-upload')
    expect(uploads).toHaveLength(1)
    expect(card().contains(uploads[0])).toBe(true)
    const p = uploadProps(uploads[0])
    expect(p.keyPrefix).toBe('inventory')
    expect(p.parentId).toBe('inv-seed-1')
    expect(p.linkage).toEqual({ inventory_item_id: 'inv-seed-1' })
    expect(p.errorMode).toBe('surface')
    expect(p.inputId).toBe('inventory-photo-inv-seed-1')
    expect(p.buttonLabel).toBe('Add photo')
    expect(p.buttonStyle.minHeight).toBeGreaterThanOrEqual(44)
    expect(p.onUploadComplete).toBe('[fn]')
    // The standalone Photo card is gone for seeds (its header was the only "Photo" text on the page).
    expect(screen.queryByText('Photo', { exact: true })).toBeNull()
  })

  it('re-reads the item after an upload, and the box shows the new first photo', async () => {
    queue[NO_PHOTO.id] = [NO_PHOTO, {
      ...NO_PHOTO, featured_photo_id: 'ph-new', hero_photo_id: 'ph-new',
      featured_photo_view_url: 'https://photos.example.test/inventory/inv-seed-1/ph-new.jpg?sig=1',
    }]
    await renderPage(NO_PHOTO)
    expect(screen.getByRole('button', { name: 'Add packet photo' })).toBeTruthy()
    expect(itemGets(NO_PHOTO.id)).toBe(1)

    await act(async () => { fireEvent.click(screen.getByTestId('photo-upload-finish')) })
    await waitFor(() => expect(itemGets(NO_PHOTO.id)).toBe(2))
    const open = await screen.findByRole('button', { name: 'Enlarge packet photo of Carolina Reaper' })
    const img = open.querySelector('[data-testid="packet-photo"]')
    expect(img.getAttribute('data-photo-id')).toBe('ph-new')
    expect(img.getAttribute('data-initial-url')).toBe('https://photos.example.test/inventory/inv-seed-1/ph-new.jpg?sig=1')
  })

  it('a re-read with the SAME hero keeps the URL on screen, and one with no URL never blanks the box', async () => {
    const resigned = { ...PEPPER, featured_photo_view_url: 'https://photos.example.test/inventory/inv-seed-1/ph-hero.jpg?sig=2' }
    const unsigned = { ...PEPPER, featured_photo_view_url: null }
    queue[PEPPER.id] = [PEPPER, resigned, unsigned]
    await renderPage(PEPPER)
    const url = () => card().querySelector('[data-testid="packet-photo"]')?.getAttribute('data-initial-url')
    expect(url()).toBe(VIEW_URL)

    await act(async () => { fireEvent.click(screen.getByTestId('photo-upload-finish')) })
    await waitFor(() => expect(itemGets(PEPPER.id)).toBe(2))
    await act(async () => {})
    // A second photo does not replace the hero, and a re-signed URL for the same photo would only
    // make the box download the full original again.
    expect(url()).toBe(VIEW_URL)

    await act(async () => { fireEvent.click(screen.getByTestId('photo-upload-finish')) })
    await waitFor(() => expect(itemGets(PEPPER.id)).toBe(3))
    await act(async () => {})
    expect(url()).toBe(VIEW_URL)
  })

  it('draws the supplier stripe and the FULL supplier name; no supplier, no stripe and no chip', async () => {
    const { unmount } = await renderPage(PEPPER)
    const chip = await waitFor(() => {
      const c = facts().querySelector('[data-testid="supplier-chip"]')
      expect(c, 'the supplier chip never appeared').toBeTruthy()
      return c
    })
    expect(chip.textContent).toBe('Sandia Seed Company')
    // First in the facts column, above every fact.
    expect(facts().firstElementChild).toBe(chip)
    expect(card().style.borderLeftWidth).toBe('4px')
    const probe = document.createElement('div')
    probe.style.color = SUPPLIER_COLORS.sandiaseedcompany.primary
    expect(card().style.borderLeftColor).toBe(probe.style.color)
    unmount()

    await renderPage({ ...PEPPER, source_id: null })
    expect(card()).toBeTruthy()
    expect(facts().querySelector('[data-testid="supplier-chip"]')).toBeNull()
    expect(card().style.borderLeftWidth).not.toBe('4px')
  })
})

describe('the packet card — facts, in one fixed order, with the row\'s words', () => {
  it('Heat, Country of origin, Species, Days to maturity, Breeding', async () => {
    await renderPage(PEPPER)
    const heat = shuLabel(PEPPER)
    expect(heat, 'shuLabel returned nothing for the fixture — the Heat row would be vacuous').toBeTruthy()
    expect(factRows()).toEqual([
      ['Heat', heat],
      ['Country of origin', 'United States · South Carolina'],
      ['Species', 'Capsicum chinense'],
      ['Days to maturity', '90–120 days from transplant'],
      ['Breeding', 'Open-pollinated'],
    ])
    const species = facts().querySelector('[data-fact="species"]').children[1]
    expect(species.style.fontStyle).toBe('italic')
  })

  it('leaves an absent fact OUT — no dash, no empty label', async () => {
    await renderPage({
      ...NO_PHOTO, name: 'Black Krim', crop_slug: 'tomato', scoville_min: null, scoville_max: null,
      origin_country: null, origin_region: null, days_to_maturity_min: null, days_to_maturity_max: null,
      dtm_basis: null, breeding_system: null, species: 'Solanum lycopersicum',
    })
    expect(factRows()).toEqual([['Species', 'Solanum lycopersicum']])
    expect(facts().textContent).not.toMatch(/—/)
    expect(facts().textContent).not.toMatch(/not recorded/)
  })

  it('a pepper with no number says Heat "not recorded"; F1, sowing basis and one-number maturity read right', async () => {
    await renderPage({
      ...PEPPER, scoville_min: null, scoville_max: null, breeding_system: 'f1',
      days_to_maturity_min: 80, days_to_maturity_max: 80, dtm_basis: 'from-sow',
    })
    expect(factRows()).toEqual([
      ['Heat', 'not recorded'],
      ['Country of origin', 'United States · South Carolina'],
      ['Species', 'Capsicum chinense'],
      ['Days to maturity', '80 days from sowing'],
      ['Breeding', 'F1 hybrid'],
    ])
  })

  it('"unknown" breeding and an unset maturity basis state nothing they do not know', async () => {
    await renderPage({ ...PEPPER, breeding_system: 'unknown', dtm_basis: null, origin_region: null })
    const got = Object.fromEntries(factRows())
    expect(got['Days to maturity']).toBe('90–120 days')
    expect(got['Country of origin']).toBe('United States')
    expect(Object.keys(got)).not.toContain('Breeding')
    expect(Object.keys(got)).toEqual(['Heat', 'Country of origin', 'Species', 'Days to maturity'])
  })

  it('is read-only — cultivar facts are edited in the variety editor, never here', async () => {
    await renderPage(PEPPER)
    expect(factRows().length).toBe(5)
    expect(facts().querySelectorAll('input, select, textarea, button').length).toBe(0)
  })
})

describe('the packet card — the link out', () => {
  it('"Packet page · <domain> ↗" opens the lot\'s own source_url in a new tab, safely', async () => {
    await renderPage(PEPPER)
    const a = screen.getByTestId('packet-link')
    expect(facts().contains(a)).toBe(true)
    expect(linkLine(a)).toBe('Packet page · sandiaseed.com ↗')
    expect(a.getAttribute('href')).toBe(PEPPER.source_url)
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getByRole('link', { name: 'Packet page on sandiaseed.com, opens in browser' })).toBe(a)
    expect(a.style.minHeight).toBe('44px')
  })

  it('without a packet URL the cultivar\'s page stands in, named for where it goes — never "Supplier"', async () => {
    await renderPage({ ...PEPPER, source_url: '' })
    const a = screen.getByTestId('packet-link')
    expect(linkLine(a)).toBe('About this variety · johnnyseeds.com ↗')
    expect(a.getAttribute('href')).toBe(PEPPER.variety_source_url)
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getByRole('link', { name: 'About this variety on johnnyseeds.com, opens in browser' })).toBe(a)
    // Everything the link says, to eyes and to a screen reader.
    expect(a.textContent).not.toMatch(/supplier/i)
    expect(a.textContent).not.toMatch(/Packet page/)
  })

  it('no http(s) URL anywhere, no link — a javascript: packet URL never becomes an href', async () => {
    await renderPage({ ...PEPPER, source_url: 'javascript:alert(1)', variety_source_url: null })
    expect(factRows().length).toBe(5)
    expect(screen.queryByTestId('packet-link')).toBeNull()
    expect(Array.from(card().querySelectorAll('a')).map(a => a.getAttribute('href'))).toEqual([])
  })

  it('follows the packet URL AS SAVED — an unsaved edit does not move it, a save does', async () => {
    await renderPage(PEPPER)
    const field = screen.getByLabelText('Packet page (URL)')
    fireEvent.change(field, { target: { value: 'https://www.botanicalinterests.com/products/reaper' } })
    expect(linkLine(screen.getByTestId('packet-link'))).toBe('Packet page · sandiaseed.com ↗')

    await act(async () => { fireEvent.click(screen.getByText('Save changes')) })
    expect(updateItemSpy).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(linkLine(screen.getByTestId('packet-link'))).toBe('Packet page · botanicalinterests.com ↗'))
  })
})

describe('the form, in a seed\'s words', () => {
  it('Packet page (URL), Supplier with its help, and Qty on hand with the used-up rule', async () => {
    await renderPage(PEPPER)
    const labels = labelTexts()
    expect(labels).toContain('Packet page (URL)')
    expect(labels).toContain('Supplier')
    expect(labels).not.toContain('Source URL')
    expect(labels).not.toContain('Origin')
    expect(screen.getByText('Who sold, packed or gave it.')).toBeTruthy()
    // The picker keeps its testid; only its name changes.
    await waitFor(() => expect(screen.getByTestId('inv-detail-origin-chip')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Clear supplier' })).toBeTruthy()
    // "Qty on hand" stays — it is now the only writer of a packet's quantity — and says the rule.
    expect(labels.some(t => t.startsWith('Qty on hand'))).toBe(true)
    const qty = screen.getByLabelText('Qty on hand')
    const help = document.getElementById(qty.getAttribute('aria-describedby'))
    expect(help.textContent).toBe('Set to 0 when the packet is used up — it moves to Sowed previously.')
  })

  it('a packet with no supplier shows the Supplier combobox under its new name', async () => {
    await renderPage({ ...PEPPER, source_id: null })
    expect(screen.getByTestId('inv-detail-origin').getAttribute('aria-label')).toBe('Supplier')
  })

  it('asks the source registry ONCE — the card joins the picker\'s request', async () => {
    await renderPage(PEPPER)
    await waitFor(() => expect(facts().querySelector('[data-testid="supplier-chip"]')).toBeTruthy())
    const gets = fetchSpy.mock.calls.filter(([p, o]) => p === '/api/varieties/sources' && !o)
    expect(gets.length).toBe(1)
  })
})

describe('every other category is untouched', () => {
  it('a tool keeps its Photo card, "Origin" and "Source URL", and grows no packet card', async () => {
    await renderPage(TOOL)
    expect(screen.getByText('Photo', { exact: true })).toBeTruthy()
    const uploads = screen.getAllByTestId('photo-upload')
    expect(uploads).toHaveLength(1)
    // Exactly the props it had: no label, no style, no re-read.
    expect(uploadProps(uploads[0])).toEqual({
      keyPrefix: 'inventory', parentId: 'inv-tool-1', linkage: { inventory_item_id: 'inv-tool-1' },
      errorMode: 'surface', inputId: 'inventory-photo-inv-tool-1',
    })
    const labels = labelTexts()
    expect(labels).toContain('Origin')
    expect(labels).toContain('Source URL')
    expect(labels).not.toContain('Supplier')
    expect(labels).not.toContain('Packet page (URL)')
    expect(screen.getByText('Who grew, bred, packed or gave it.')).toBeTruthy()
    expect(screen.queryByTestId('packet-card')).toBeNull()
    expect(screen.queryByRole('button', { name: /packet photo/i })).toBeNull()
    expect(document.querySelector('[data-testid="packet-photo"]')).toBeNull()
  })

  it('a consumable non-seed keeps a bare "Qty on hand"', async () => {
    await renderPage(AMENDMENT)
    const qty = screen.getByLabelText('Qty on hand')
    expect(qty.getAttribute('aria-describedby')).toBeNull()
    expect(document.body.textContent).not.toMatch(/Sowed previously/)
  })

  it('a tool page asks the source registry once — the card\'s hook never fires for it', async () => {
    await renderPage(TOOL)
    await waitFor(() => expect(screen.getByTestId('inv-detail-origin-chip')).toBeTruthy())
    const gets = fetchSpy.mock.calls.filter(([p, o]) => p === '/api/varieties/sources' && !o)
    expect(gets.length).toBe(1)
  })
})

// ── Byte pins against base a3eb208 ───────────────────────────────────────────────────────────────
// React 18's client useId is a module-global counter (":r<n>:"), so the ids one render receives depend
// on how many ids every EARLIER test in this file mounted. They are renamed by order of first
// appearance: a changed id STRUCTURE (one added, one dropped, a label moved to another control) still
// shows as a diff; a test inserted above this block does not. Three pickers strip the colons into a
// listbox id (`sp-list-rc`, and vp-/ps- likewise), so that spelling maps onto the same name.
function normaliseIds(html) {
  const seen = new Map()
  const name = (core) => {
    if (!seen.has(core)) seen.set(core, `id${seen.size}`)
    return seen.get(core)
  }
  return html.replace(/:(r[0-9a-z]+):|\b((?:vp|sp|ps)-list-)(r[0-9a-z]+)/g,
    (m, colonCore, prefix, bareCore) => (colonCore ? `:${name(colonCore)}:` : `${prefix}${name(bareCore)}`))
}
const FIXTURE_DIR = resolve(process.cwd(), 'src/__tests__/__fixtures__')
const WRITE = process.env.INVDETAIL_BASE_BYTES_WRITE === '1'

describe.each([
  ['tool (durable)', TOOL, 'inventoryDetail.tool.base-a3eb208.html', 'inv-detail-origin-chip'],
  ['amendment (consumable)', AMENDMENT, 'inventoryDetail.amendment.base-a3eb208.html', 'inv-detail-origin'],
])('a %s renders byte-identically to base a3eb208', (_label, row, file, settledTestId) => {
  it('matches the markup captured before V5-SEEDCARDS-001', async () => {
    const { container } = await renderPage(row)
    await waitFor(() => expect(screen.getByTestId(settledTestId)).toBeTruthy())
    await act(async () => {})
    const html = normaliseIds(container.innerHTML)
    const fixture = resolve(FIXTURE_DIR, file)
    if (WRITE) {
      mkdirSync(dirname(fixture), { recursive: true })
      writeFileSync(fixture, html)
      expect(WRITE, 'baseline written — re-run without INVDETAIL_BASE_BYTES_WRITE to assert').toBe(true)
      return
    }
    expect(existsSync(fixture), `missing baseline fixture ${fixture}`).toBe(true)
    const baseline = readFileSync(fixture, 'utf8')
    // The fixture is the page we think it is, not an error screen or a spinner.
    expect(baseline).toContain(row.name)
    expect(baseline).toContain('Source URL')
    expect(baseline).toContain('Photo')
    expect(html).toBe(baseline)
  })
})
