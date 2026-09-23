// V5-SEEDSPOLISH-001 — a packet photo that fails to load on My seeds ends as the SAME sprout box a row
// with no photo shows (Dave, 2026-09-21). Before this it ended as PhotoImg's plain green placeholder:
// the sprout box with the sprout missing. Real MySeeds + PhotoView + PhotoImg, only the API mocked, so
// a row walks the real degrade chain (thumb -> original -> one re-mint) and the real onTerminal event
// (PhotoImg freeze delta (5)) rather than a probe's idea of them.
//
// Loading must look exactly as before — the stone box while a picture is on its way — so the pending
// and loaded rows are pinned beside the failed one. The flag is proved to name the photo it failed
// for: an unrelated edit keeps the sprout without re-minting, and a row re-pointed at another photo
// draws that photo instead of inheriting the old one's failure.
//
// S7 covers the phone-cached (photos-v1) arm, which the Seeds layout gate cannot reach: its harness
// registers no service worker, so every row there mints.
//
// WHAT THIS CANNOT CATCH: jsdom never loads an image, so a failed load is a synthetic error event, and
// the markup comparison proves the DOM is the no-photo row's, not how Chrome paints it.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, cleanup, within } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
  isFromCache: () => false,
}))

import { MemoryRouter } from 'react-router-dom'
import MySeeds from '../pages/MySeeds.jsx'
import { useSeedItems } from '../hooks/useSeedItems.js'
import { ToastProvider } from '../context/ToastContext.jsx'
import { __resetPhotoImgCache } from '../components/PhotoImg.jsx'
import { __resetDeviceThumb } from '../lib/deviceThumb.js'
import { failPhotoLoad } from './helpers/photoLoadFailure.js'
import { makeFakeCaches } from './helpers/swHarness.js'

const pepper = (id, hero, extra = {}) => ({
  id, name: `Pepper ${id}`, variety_name: `Pepper ${id}`, category: 'seeds', type: 'consumable', unit: 'packet',
  status: 'active', quantity_on_hand: 1, variety_id: `v-${id}`, crop_slug: 'pepper', seed_stage: null,
  seed_process: null, source_plant_id: null, source_kind: null, source_id: null, source: null,
  purchase_date: null, year_harvested: null, stage_entered_at: null, created_at: '2026-07-01T12:00:00Z',
  // The list's shape: the derived hero's id and its thumb's object key, no URL keys.
  hero_photo_id: hero, featured_photo_id: null,
  hero_thumb_key: hero ? `thumbs/inventory/${id}/${hero}.jpg` : null,
  scoville_min: null, scoville_max: null, scoville_source: null, variety_source_url: null,
  ...extra,
})

// Every mint returns a DISTINCT url. An identical re-mint trips the separate same-url heal stall
// (BUG-PHOTOIMGSAMEURLHEAL-001), which never reaches TERMINAL and is not this item.
let n = 0
let rows = []
let plan = null   // (photoId, tier) => Promise | undefined; undefined takes the default distinct mint
const minted = (id, tier) => `https://photos.test/${tier === 'thumb' ? 'thumbs/' : ''}${id}.jpg?X-Amz-Signature=s${++n}`
const failure = (status) => { const e = new Error(`status ${status}`); e.status = status; return Promise.reject(e) }

beforeEach(() => {
  n = 0
  plan = null
  rows = [pepper('a', 'ph-a'), pepper('b', 'ph-b'), pepper('c', null)]
  __resetPhotoImgCache()
  __resetDeviceThumb()
  delete globalThis.caches
  fetchSpy.mockReset()
  try { window.sessionStorage.clear() } catch { /* jsdom */ }
  fetchSpy.mockImplementation((path) => {
    const p = String(path)
    const m = p.match(/^\/api\/photos\/view-url\/([^?]+)(?:\?tier=(\w+))?$/)
    if (m) {
      const tier = m[2] ?? 'full'
      return plan?.(m[1], tier) ?? Promise.resolve({ view_url: minted(m[1], tier), expires_in: 900 })
    }
    if (p.startsWith('/api/inventory-items?category=seeds')) return Promise.resolve(rows)
    if (p.startsWith('/api/varieties/crop-types')) return Promise.resolve([{ slug: 'pepper', display_name: 'Pepper' }])
    return Promise.resolve([])
  })
})
afterEach(() => { cleanup(); delete globalThis.caches })

let store = null
function Host() {
  store = useSeedItems()
  return <MySeeds store={store} />
}
const mountOpen = async () => {
  await act(async () => { render(<MemoryRouter><ToastProvider><Host /></ToastProvider></MemoryRouter>) })
  await waitFor(() => expect(screen.getAllByTestId('facet-group-header').length).toBe(1))
  await act(async () => { fireEvent.click(screen.getByTestId('facet-group-header')) })
}
const rowFor = (id) => document.querySelector(`[data-lot-id="${id}"]`)
const photoIn = (id) => () => within(rowFor(id)).queryByTestId('my-seed-photo')
const boxIn = (id) => within(rowFor(id)).getByTestId('my-seed-thumb')
const viewUrlCalls = () => fetchSpy.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith('/api/photos/view-url/'))
const mintsFor = (photoId) => viewUrlCalls().filter((p) => p.split('?')[0] === `/api/photos/view-url/${photoId}`)
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const STONE = 'rgb(232, 226, 218)'       // P.photoPlaceholder: a photo box while its picture is on its way
const GREEN_PALE = 'rgb(216, 243, 220)'  // P.greenPale: the no-photo box, and PhotoImg's own neutral fill

// Row `id` (id-only arm) down the whole degrade chain to PhotoImg's TERMINAL: the thumb fails, the
// original is minted and fails, its one re-mint fails too. Waits only on PhotoView/PhotoImg's own
// progress, never on the sprout, so a My seeds that ignores the event reds on an assertion below
// instead of timing out here.
async function driveToTerminal(id) {
  const photo = photoIn(id)
  await waitFor(() => expect(photo()?.tagName).toBe('IMG'))
  expect(photo().getAttribute('src')).toContain('/thumbs/')
  failPhotoLoad(photo)                                            // rung 1 (thumb) -> PhotoView degrades
  await waitFor(() => expect(photo()?.getAttribute('src') || '').toMatch(/photos\.test\/ph-/))
  const firstFull = photo().getAttribute('src')
  failPhotoLoad(photo)                                            // rung 2 (original) -> ONE reactive re-mint
  await waitFor(() => expect(photo()?.getAttribute('src') || firstFull).not.toBe(firstFull))
  failPhotoLoad(photo)                                            // the re-mint fails too -> TERMINAL
  await settle()
}

describe('My seeds — a packet photo that cannot be shown ends as the no-photo sprout box', () => {
  it('S1 a photo that fails all the way to TERMINAL ends as the SAME sprout box the no-photo row shows', async () => {
    await mountOpen()
    await driveToTerminal('a')
    expect(photoIn('a')()).toBeNull()
    expect(boxIn('a').querySelector('svg')).toBeTruthy()
    expect(boxIn('a').outerHTML).toBe(boxIn('c').outerHTML)      // the no-photo row's element, byte for byte
    expect(boxIn('a').style.backgroundColor).toBe(GREEN_PALE)
    // The sprout came at the END of the chain: thumb, original, one re-mint — the same three mints as
    // before this change, so no rung was cut short on the way.
    expect(mintsFor('ph-a')).toEqual(['/api/photos/view-url/ph-a?tier=thumb', '/api/photos/view-url/ph-a', '/api/photos/view-url/ph-a'])
  })

  it('S2 a photo still on its way keeps today\'s look — the stone box with the neutral fill, no sprout', async () => {
    plan = (id) => (id === 'ph-b' ? new Promise(() => {}) : undefined)
    await mountOpen()
    await waitFor(() => expect(mintsFor('ph-b')).toEqual(['/api/photos/view-url/ph-b?tier=thumb']))
    await settle()
    const box = boxIn('b')
    expect(box.style.backgroundColor).toBe(STONE)
    expect(box.querySelector('svg')).toBeNull()
    const fill = photoIn('b')()
    expect(fill.tagName).toBe('DIV')                               // PhotoImg's pending box, never <img src=null>
    expect(fill.getAttribute('aria-hidden')).toBe('true')
    expect(fill.style.backgroundColor).toBe(GREEN_PALE)
    expect(box.outerHTML).not.toBe(boxIn('c').outerHTML)           // loading and "no image" must look different
  })

  it('S3 a photo that loads draws the image in the stone box, no sprout', async () => {
    await mountOpen()
    await waitFor(() => expect(photoIn('a')()?.tagName).toBe('IMG'))
    expect(photoIn('a')().getAttribute('src')).toMatch(/^https:\/\/photos\.test\/thumbs\/ph-a\.jpg\?X-Amz-Signature=s\d+$/)
    expect(boxIn('a').style.backgroundColor).toBe(STONE)
    expect(boxIn('a').querySelector('svg')).toBeNull()
  })

  it('S4 the flag names the photo it failed for — kept through an unrelated edit, dropped for a new photo', async () => {
    await mountOpen()
    await driveToTerminal('a')
    expect(boxIn('a').querySelector('svg')).toBeTruthy()
    const before = viewUrlCalls().length
    // An edit that leaves the photo alone keeps the sprout and spends no mint on a known failure.
    await act(async () => { store.patch('a', (r) => ({ ...r, quantity_on_hand: 2 })) })
    await settle()
    expect(boxIn('a').querySelector('svg')).toBeTruthy()
    expect(viewUrlCalls().length).toBe(before)
    // The row re-pointed at a different photo (a refresh that moved the hero) draws that photo.
    await act(async () => { store.patch('a', (r) => ({ ...r, hero_photo_id: 'ph-a2', hero_thumb_key: 'thumbs/inventory/a/ph-a2.jpg' })) })
    await waitFor(() => expect(photoIn('a')()?.tagName).toBe('IMG'))
    expect(photoIn('a')().getAttribute('src')).toContain('/thumbs/ph-a2.jpg')
    expect(boxIn('a').style.backgroundColor).toBe(STONE)
    expect(boxIn('a').querySelector('svg')).toBeNull()
  })

  it('S5 a photo deleted since the list loaded (view-url 404) ends as the sprout box after ONE mint', async () => {
    plan = (id) => (id === 'ph-a' ? failure(404) : undefined)
    await mountOpen()
    await waitFor(() => expect(mintsFor('ph-a').length).toBeGreaterThan(0))
    await settle()
    expect(photoIn('a')()).toBeNull()
    expect(boxIn('a').outerHTML).toBe(boxIn('c').outerHTML)
    expect(mintsFor('ph-a')).toEqual(['/api/photos/view-url/ph-a?tier=thumb'])
  })

  it('S6 a photo that came with a URL and no id fails straight to the sprout box too (the flag keys on its URL)', async () => {
    const LEGACY = 'https://photos.test/legacy/d.jpg?X-Amz-Signature=old'
    rows = [...rows, pepper('d', null, { featured_photo_view_url: LEGACY })]
    await mountOpen()
    const photo = photoIn('d')
    await waitFor(() => expect(photo()?.getAttribute('src')).toBe(LEGACY))
    failPhotoLoad(photo)                                            // no id to re-mint by: the first error is terminal
    await settle()
    expect(photo()).toBeNull()
    expect(boxIn('d').outerHTML).toBe(boxIn('c').outerHTML)
    expect(viewUrlCalls().filter((p) => !/\/ph-[ab](\?|$)/.test(p))).toEqual([])
  })

  it('S7 a phone-cached thumb whose copy fails, and whose one heal fails too, ends as the sprout box after ONE mint', async () => {
    // The row draws the phone's own copy with no mint (BUG-SEEDTHUMBSOFFLINE-001); that copy fails, a
    // single ?tier=thumb mint heals it, the healed URL fails as well: TERMINAL on the one-rung URL arm.
    const DEVICE_A = 'https://photos.test/thumbs/inventory/a/ph-a.jpg?x-id=GetObject'
    const api = makeFakeCaches({ 'photos-v1': { [DEVICE_A]: new Response('A', { headers: { 'Content-Type': 'image/jpeg' } }) } })
    api.has = async (name) => api.store.has(name)
    globalThis.caches = api
    await mountOpen()
    const photo = photoIn('a')
    await waitFor(() => expect(photo()?.getAttribute('src')).toBe(DEVICE_A))
    expect(mintsFor('ph-a')).toEqual([])                            // the phone's copy needed no mint
    failPhotoLoad(photo)                                            // the cached copy fails -> one heal
    await waitFor(() => expect(photo()?.getAttribute('src') || '').toMatch(/X-Amz-Signature/))
    failPhotoLoad(photo)                                            // the healed URL fails too -> TERMINAL
    await settle()
    expect(photo()).toBeNull()
    expect(boxIn('a').outerHTML).toBe(boxIn('c').outerHTML)
    expect(mintsFor('ph-a')).toEqual(['/api/photos/view-url/ph-a?tier=thumb'])
    expect(photoIn('b')()?.tagName).toBe('IMG')                     // the neighbour is untouched
  })
})
