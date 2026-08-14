// V4-PHOTOMODEL-001 — the anti-refragmentation guard.
//
// The bug family this ticket exists to close (BUG-PHOTOTHUMB-001, BUG-PHOTONEWTHUMB-001,
// BUG-PHOTOPARENT-001, BUG-PHOTOBLANK-001) all share ONE root cause: each surface re-derived its own
// notion of what a photo is. The sibling guard noBareViewUrlImg bans the raw <img> form. This one
// bans the layer above it — deriving WHICH source to render, or WHICH parents exist, anywhere other
// than photoModel.js.
//
// WHY STATIC AND NOT A RENDER TEST: every failure in this family is invisible to jsdom. jsdom never
// loads an image, so it cannot see that a grid fetched a 4080x3072 original instead of a thumb, and
// it cannot see a thumb 404 degrade. Only a text scan (or a live browser) catches the re-derivation
// before it ships.
//
// BOTH clauses are RATCHETS: the allow-lists may only shrink. Each entry names the surface and why
// it has not been migrated yet, and removing one is what "migrating a surface" means.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(process.cwd(), 'src') + '/'

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue   // app markup only; this guard's own source names the fields
      out.push(...walk(full)); continue
    }
    if (/\.(jsx?|tsx?)$/.test(name) && !/\.test\.[jt]sx?$/.test(name)) out.push(full)
  }
  return out
}

// Strip comments so the extensive explanatory prose in this codebase (which legitimately quotes
// these field names) is never read as code. Matches the sibling guards' convention.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

// ── Clause 1: tier selection ──────────────────────────────────────────────────────────────────
// `thumb_url || view_url` is the fingerprint of a surface deciding for itself which derivative to
// render. It is also WRONG wherever it appears: thumb_url is a presigned URL derived by CONVENTION
// (thumbs/<storage_path>) and presigning never touches S3, so it is a non-empty string on 100% of
// live rows whether or not the thumbnail exists. The `||` therefore never falls through, which IS
// BUG-PHOTONEWTHUMB-001. Only photoModel.js may express the degrade, because only it degrades on
// LOAD FAILURE rather than on falsiness.
const TIER_SELECT = /\bthumb_url\b\s*(\|\||\?\?)/
const TIER_SELECT_ALLOWED = new Set([
  // Not owned by V4-PHOTOMODEL-001; both feed the URL into <PhotoImg initialUrl=...> rather than a
  // bare <img>, so they are expiry-safe but still tier-blind (a missing thumb blanks the tile
  // instead of degrading). Migrate to <PhotoView tier="thumb"> and delete these two lines.
  'pages/LocationDetail.jsx',
  'components/SpaceAttachPicker.jsx',
])

// ── Clause 2: the primitive ───────────────────────────────────────────────────────────────────
// <PhotoImg> is the URL-lifecycle layer, NOT the primitive. Rendering it directly means choosing a
// source by hand and thereby re-opening the tier bug. New surfaces must use <PhotoView>. This list
// is the honest inventory of what has not been migrated yet; it may only shrink.
const PHOTOIMG_ALLOWED = new Set([
  'components/photo/PhotoView.jsx',        // THE primitive — composes PhotoImg by design
  'components/PhotoHero.jsx',              // tier-agnostic hero wrapper (V4-IMGRELIAB-001 frozen contract)
  'components/Lightbox.jsx',               // full-tier by definition; gallery slides carry pre-picked srcs
  'components/FacebookShareSheet.jsx',     // full-tier: shares the original, a thumb would be wrong
  'components/PlantingTile.jsx',           // featured_photo_view_url — no thumb derivative exists for it
  // components/PutUpPhotoThumb.jsx — MIGRATED (V4-PHOTOIDARM-001). It was here because the primitive
  // could not express an id-only photo; <PhotoView resolveById> now can, over the SAME mount-mint.
  'components/SpaceAttachPicker.jsx',      // see clause 1
  'components/planting/GrowthStrip.jsx',   // not yet migrated
  'components/today/CareNeeded.jsx',       // not yet migrated
  'pages/Garden.jsx',                      // featured_photo_view_url tiles
  'pages/LocationDetail.jsx',              // see clause 1
  'pages/PlantingDetail.jsx',              // not yet migrated
  'pages/ProjectDetail.jsx',               // not yet migrated
])

describe('V4-PHOTOMODEL-001 matcher self-tests (a lint that matches nothing is worse than no lint)', () => {
  it('TIER_SELECT flags the || and ?? fallback forms', () => {
    expect(TIER_SELECT.test('src={photo.thumb_url || photo.view_url}')).toBe(true)
    expect(TIER_SELECT.test('initialUrl={p.thumb_url ?? p.view_url}')).toBe(true)
  })
  it('TIER_SELECT does NOT flag a plain read or the model’s own source build', () => {
    expect(TIER_SELECT.test('const thumb = raw.thumb_url')).toBe(false)
    expect(TIER_SELECT.test('URL_FIELDS = [\'view_url\', \'thumb_url\']')).toBe(false)
  })
  it('stripComments removes the prose that legitimately names these fields', () => {
    expect(TIER_SELECT.test(stripComments('// swaps thumb_url || view_url on error'))).toBe(false)
  })
})

describe('photo drift guard: one object, one primitive (V4-PHOTOMODEL-001)', () => {
  it('clause 1 — only photoModel.js selects a derivative tier', () => {
    const offenders = []
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length)
      if (rel === 'lib/photoModel.js' || TIER_SELECT_ALLOWED.has(rel)) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const line of code.split('\n')) {
        if (TIER_SELECT.test(line)) offenders.push(`${rel}: ${line.trim().slice(0, 80)}`)
      }
    }
    expect(offenders, `a surface is choosing its own derivative. thumb_url is a HINT that is ALWAYS truthy, so \`||\` never falls through (BUG-PHOTONEWTHUMB-001) — use <PhotoView tier="thumb">. Offenders:\n${offenders.join('\n')}`).toEqual([])
  })

  it('clause 2 — no NEW surface renders <PhotoImg> directly instead of <PhotoView>', () => {
    const offenders = []
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length)
      if (PHOTOIMG_ALLOWED.has(rel)) continue
      if (/<PhotoImg\b/.test(stripComments(readFileSync(file, 'utf8')))) offenders.push(rel)
    }
    expect(offenders, `<PhotoImg> is the URL-lifecycle layer, not the photo primitive — rendering it directly means hand-picking a source and reopening the tier bug. Use <PhotoView>. Offenders:\n${offenders.join('\n')}`).toEqual([])
  })

  it('clause 2 is a RATCHET — the allow-list may only shrink', () => {
    // Pins the count so migrating a surface without deleting its entry, or re-adding one, fails
    // here. Update this number DOWNWARD only.
    expect(PHOTOIMG_ALLOWED.size).toBe(12)
    for (const rel of PHOTOIMG_ALLOWED) {
      if (rel === 'components/photo/PhotoView.jsx') continue
      expect(/<PhotoImg\b/.test(stripComments(readFileSync(join(SRC, rel), 'utf8'))),
        `${rel} is allow-listed but no longer renders <PhotoImg> — delete its entry and decrement the ratchet count`).toBe(true)
    }
  })

  it('the migrated surfaces are actually on the primitive', () => {
    // A delisting is only real if the surface renders <PhotoView>. PutUpPhotoThumb joined this list
    // with V4-PHOTOIDARM-001; EventDetail is here because it is the surface the id-only arm was
    // built for, and it must not quietly slide back to an allow-listed wrapper.
    for (const rel of ['pages/PhotoLibrary.jsx', 'components/PhotosWall.jsx',
                       'components/PutUpPhotoThumb.jsx', 'pages/EventDetail.jsx']) {
      const code = stripComments(readFileSync(join(SRC, rel), 'utf8'))
      expect(code.includes('<PhotoView'), `${rel} must render <PhotoView>`).toBe(true)
      expect(/<PhotoImg\b/.test(code), `${rel} must not render <PhotoImg> directly`).toBe(false)
    }
  })
})
