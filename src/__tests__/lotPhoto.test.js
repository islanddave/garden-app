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
})
