// V5-SEEDCARDS-001 — the one lot-row -> PhotoView adapter. The photo id is the PHOTO's
// (hero_photo_id), never the lot's id: PhotoImg re-mints an expired URL by that id, and a lot id there
// 404s into a permanent blank after the 900s presign — invisible to jsdom, so it is pinned here.
import { describe, it, expect } from 'vitest'
import { lotPhoto } from '../components/seed/lotPhoto.js'

describe('lotPhoto', () => {
  it('maps a lot row to its hero photo — the id is hero_photo_id, never the lot id', () => {
    const p = lotPhoto({ id: 'lot-1', hero_photo_id: 'ph-9', featured_photo_view_url: 'https://v', featured_photo_thumb_url: 'https://t' })
    expect(p).toEqual({ id: 'ph-9', featured_photo_view_url: 'https://v', featured_photo_thumb_url: 'https://t', inventory_item_id: 'lot-1' })
    expect(p.id).not.toBe('lot-1')
  })
  it('is null without a view URL, and a missing thumb or hero id is null, not the lot id', () => {
    expect(lotPhoto({ id: 'lot-1', hero_photo_id: 'ph-9' })).toBeNull()
    expect(lotPhoto(null)).toBeNull()
    const p = lotPhoto({ id: 'lot-2', featured_photo_view_url: 'https://v' })
    expect(p.id).toBeNull()
    expect(p.featured_photo_thumb_url).toBeNull()
  })

  // BUG-SEEDLISTSIGNING-001: the seed list sends the hero's id and no URL.
  describe('byId — the list row shape', () => {
    it('maps an id-only row to an id-only photo whose id is the PHOTO id', () => {
      expect(lotPhoto({ id: 'lot-1', hero_photo_id: 'ph-9' }, { byId: true }))
        .toEqual({ id: 'ph-9', inventory_item_id: 'lot-1' })
    })
    it('is null for a lot with no photo at all', () => {
      expect(lotPhoto({ id: 'lot-1', hero_photo_id: null }, { byId: true })).toBeNull()
      expect(lotPhoto({ id: 'lot-1' }, { byId: true })).toBeNull()
      expect(lotPhoto(null, { byId: true })).toBeNull()
    })
    it('still renders from a URL when the row carries one (a list cached before the change)', () => {
      expect(lotPhoto({ id: 'lot-1', hero_photo_id: 'ph-9', featured_photo_view_url: 'https://v' }, { byId: true }))
        .toEqual({ id: 'ph-9', featured_photo_view_url: 'https://v', featured_photo_thumb_url: null, inventory_item_id: 'lot-1' })
    })
  })
})
