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
// ALL FOUR clauses are RATCHETS: the allow-lists may only shrink. Each entry names the surface and
// why it has not been migrated yet, and removing one is what "migrating a surface" means.
//
// CLAUSES 3 AND 4 EXIST BECAUSE CLAUSES 1 AND 2 BOTH PASSED THROUGH BUG-TIERLESSPHOTOS-001 (added
// 2026-08-28). Being ON the primitive was never the same as asking it for the right derivative:
// `<PhotoView photo={x} />` defaults to TIER.FULL, so a 4.15 MB original in a 40 px box satisfied
// every assertion above. And the sibling noBareViewUrlImg guard keys on the FIELD NAME inside
// `src={…}`, so the Lightbox filmstrip — 24 unwindowed originals at 52x52, bound to the alias
// `im.src` — was invisible to both files at once. Neither gap was an oversight in the matchers; both
// were questions nothing asked.
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
  // components/PlantingTile.jsx — MIGRATED (V4-PHOTOUI-001). It never needed the id-only arm:
  // /api/plants presigns, so the chain is in hand — zero extra network on a windowed 24-tile grid.
  // The call-site adapter remaps the PHOTO id off the planting row; conflating it with the plant id
  // would 404 every self-heal. V4-PERFTHEMEA-001 then made it tier=THUMB once /api/plants started
  // signing the thumbs/ companion — being ON the primitive is exactly what made that a prop change
  // rather than a hand-rolled `thumb_url ||` this clause would have to flag.
  // components/PutUpPhotoThumb.jsx — MIGRATED (V4-PHOTOIDARM-001). It was here because the primitive
  // could not express an id-only photo; <PhotoView resolveById> now can, over the SAME mount-mint.
  'components/SpaceAttachPicker.jsx',      // see clause 1
  // components/planting/GrowthStrip.jsx — MIGRATED (BUG-TIERLESSPHOTOS-001). The 24-element
  // milestone strip is tier=THUMB; the compare stage and playback frame stay FULL on purpose (an
  // 840-device-px box vs an 800px-longest-edge derivative) and are on the primitive regardless.
  // components/today/CareNeeded.jsx — MIGRATED (BUG-TIERLESSPHOTOS-001). It was the worst
  // size-to-box ratio in the app: the featured ORIGINAL into a 30px row thumb on the landing route.
  // pages/Garden.jsx — MIGRATED (BUG-TIERLESSPHOTOS-001). tier=THUMB is requested but currently
  // resolves to [full], because GET /api/projects does not send a featured photo at all.
  // pages/PlantingDetail.jsx — MIGRATED (BUG-TIERLESSPHOTOS-001). The photos grid was the worst
  // size-to-box ratio left in the app: an UNWINDOWED photos.map of minmax(96px,1fr) tiles loading
  // view_url, i.e. every original the planting has — 24 photos = ~99.5 MB against ~4.2 MB of thumbs.
  // pages/ProjectDetail.jsx — MIGRATED (BUG-TIERLESSPHOTOS-001). featured_photo_view_url into a
  // 40x40 box. Its rows come from GET /api/plants?project_id=, not /api/projects, so the thumbs/
  // companion was already signed onto them and no server change was needed.
  'pages/LocationDetail.jsx',              // see clause 1
])

// ── Clause 3: the tier is a DECISION, and it has to be visible ────────────────────────────────
// `tier` defaults to TIER.FULL (PhotoView's signature), so omitting it is not "no opinion" — it is
// "send the ~4.15 MB original", stated in the one way no reader notices. Every render either names
// its tier or appears here with a reason.
//
// A COUNT, not a bare file list, and that is the point: GrowthStrip legitimately has three tier-less
// renders and one tier=THUMB render, so exempting the FILE would let a fourth tier-less render land
// there unseen. The number is the ratchet. Adjust it only alongside a reason.
const TIER_OMITTED_ALLOWED = new Map([
  // The compare stage (before/after) and the playback frame. GrowthStrip.jsx:134-135 measures the
  // box at 840x629 DEVICE px at Dave's dpr 2.625, and the thumb derivative is 800 px on its LONGEST
  // edge (imageDownscale.js THUMB_EDGE_PX) — a landscape thumb is 800 wide, 0.95x, and visibly
  // softer. The 24-element milestone strip in the same file IS tier=THUMB.
  ['components/planting/GrowthStrip.jsx', 3],
  // A reasoned sizing call, argued in-file at PutUpPhotoThumb.jsx:14-18: the id-only arm would spend
  // a second round-trip per row and there are only a handful of put-up rows on a page. Re-argue it
  // explicitly if you change it; do not flip it as part of a sweep.
  ['components/PutUpPhotoThumb.jsx', 1],
])

// A PhotoView tag, attributes possibly spanning many lines. NOT `<PhotoView\b[^>]*>` like the
// sibling img matcher: `onOpen={() => goTo(i)}` contains a `>`, so that shape truncates mid-tag and
// silently reports a tier-less render for any call site with an arrow-function prop (and vice
// versa). PhotoView takes no children, so every render is self-closing and `/>` is the true end.
// The 800-char bound stops a malformed tag from swallowing the rest of the file and reading a
// LATER tag's tier as its own — an unmatched bound is how a source-text guard reports a pass it
// never measured.
const PHOTOVIEW_TAG = /<PhotoView\b[\s\S]{0,800}?\/>/g
const HAS_TIER = /\btier=/

// Returns one entry per <PhotoView> render that does not name a tier. A match containing a further
// `<` did not close where we think it did, so it is reported rather than judged — fail closed.
export function findTierlessPhotoViews(code) {
  const stripped = stripComments(code)
  const out = []
  let m
  PHOTOVIEW_TAG.lastIndex = 0
  while ((m = PHOTOVIEW_TAG.exec(stripped)) !== null) {
    const tag = m[0]
    if (tag.indexOf('<', 1) !== -1) { out.push(`UNPARSEABLE: ${tag.replace(/\s+/g, ' ').slice(0, 70)}`); continue }
    if (!HAS_TIER.test(tag)) out.push(tag.replace(/\s+/g, ' ').slice(0, 70))
  }
  return out
}

// ── Clause 4: an ALIASED presigned src ────────────────────────────────────────────────────────
// The blind spot the Lightbox filmstrip lived in for its whole life. noBareViewUrlImg matches
// `src={…view_url…}` by FIELD NAME, so the moment a caller copies that URL onto a slide object as
// `src` / `thumbSrc`, the field name is gone and a bare <img src={im.src}> reads as innocent — no
// onError, no re-mint, and (before this fix) 24 full originals painted at 52x52. This clause matches
// the SHAPE instead: a bare <img> whose src is `<something>.src` / `<something>.thumbSrc`.
const ALIASED_IMG = /<img\b[\s\S]{0,600}?\/>/g
const ALIASED_SRC = /\bsrc=\{[A-Za-z_$][\w$]*\.(?:src|thumbSrc)\}/
const ALIASED_ALLOWED = new Set([
  // `banner` comes from lib/bannerManifest.js BANNERS — bundled same-origin art with a build-hashed
  // path. No presign, no 900s TTL, no derivative: nothing this clause protects against applies.
  'components/TopChrome.jsx',
])

export function findAliasedSrcImgs(code) {
  const stripped = stripComments(code)
  const out = []
  let m
  ALIASED_IMG.lastIndex = 0
  while ((m = ALIASED_IMG.exec(stripped)) !== null) {
    if (ALIASED_SRC.test(m[0])) out.push(m[0].replace(/\s+/g, ' ').slice(0, 70))
  }
  return out
}

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

  it('findTierlessPhotoViews FLAGS a render with no tier, single- and multi-line', () => {
    expect(findTierlessPhotoViews('<PhotoView photo={p} alt="" />')).toHaveLength(1)
    expect(findTierlessPhotoViews('<PhotoView\n  photo={p}\n  alt=""\n  style={s}\n/>')).toHaveLength(1)
  })
  it('findTierlessPhotoViews does NOT flag a render that names its tier', () => {
    expect(findTierlessPhotoViews('<PhotoView photo={p} tier={TIER.THUMB} alt="" />')).toHaveLength(0)
    expect(findTierlessPhotoViews('<PhotoView\n  photo={p}\n  tier={TIER.FULL}\n/>')).toHaveLength(0)
  })
  it('findTierlessPhotoViews survives an arrow-function prop — the reason it is not [^>]*', () => {
    // THE LOAD-BEARING SELF-TEST. `=>` contains a `>`, so the sibling img matcher's shape would end
    // the tag at `onOpen={() =` and never see the tier that follows. Both directions are proven:
    // the tier is found AFTER the arrow, and a genuinely tier-less arrow render is still caught.
    expect(findTierlessPhotoViews('<PhotoView photo={p} onOpen={() => go(i)} tier={TIER.THUMB} />')).toHaveLength(0)
    expect(findTierlessPhotoViews('<PhotoView photo={p} onOpen={() => go(i)} alt="" />')).toHaveLength(1)
  })
  it('findTierlessPhotoViews counts each render separately, and ignores prose', () => {
    expect(findTierlessPhotoViews('<PhotoView photo={a} />\n<PhotoView photo={b} tier={T} />\n<PhotoView photo={c} />')).toHaveLength(2)
    expect(findTierlessPhotoViews('// a bare <PhotoView photo={p} /> would default to FULL')).toHaveLength(0)
  })

  it('findAliasedSrcImgs FLAGS the filmstrip shape and ignores the composing component', () => {
    expect(findAliasedSrcImgs('<img src={im.src} alt="" aria-hidden="true" />')).toHaveLength(1)
    expect(findAliasedSrcImgs('<img\n  src={slide.thumbSrc}\n  alt=""\n/>')).toHaveLength(1)
    expect(findAliasedSrcImgs('<PhotoImg initialUrl={current.src} alt="" />')).toHaveLength(0)
    expect(findAliasedSrcImgs('<PhotoView photo={slidePhoto(im)} tier={TIER.THUMB} />')).toHaveLength(0)
  })
  it('findAliasedSrcImgs does NOT flag a plain local src or a DOM assignment', () => {
    expect(findAliasedSrcImgs('<img src={preview} alt="" />')).toHaveLength(0)
    expect(findAliasedSrcImgs('<img ref={r} src={src} onError={h} />')).toHaveLength(0)
    expect(findAliasedSrcImgs('e.currentTarget.src = photo.src')).toHaveLength(0)
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

  it('clause 3 — every <PhotoView> names its tier, or is on the reasoned omission list', () => {
    const offenders = []
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length)
      const tierless = findTierlessPhotoViews(readFileSync(file, 'utf8'))
      const allowed = TIER_OMITTED_ALLOWED.get(rel) ?? 0
      if (tierless.length > allowed) {
        for (const hit of tierless.slice(allowed)) offenders.push(`${rel}: ${hit}`)
      }
    }
    expect(offenders, `<PhotoView> defaults to TIER.FULL, so an omitted tier silently requests the ~4.15 MB ORIGINAL (thumb median 176,963 B — 23.4x). Name the tier, or add the surface to TIER_OMITTED_ALLOWED with a measured reason. Offenders:\n${offenders.join('\n')}`).toEqual([])
  })

  it('clause 3 is a RATCHET — an allow-listed file may not gain tier-less renders', () => {
    // The other direction: a count that is too HIGH exempts renders that no longer exist (or never
    // did), which is how an allow-list rots into a blanket. Exact match, both ways.
    for (const [rel, n] of TIER_OMITTED_ALLOWED) {
      expect(findTierlessPhotoViews(readFileSync(join(SRC, rel), 'utf8')).length,
        `${rel} is allow-listed for exactly ${n} tier-less <PhotoView> render(s) — update the count and say why`).toBe(n)
    }
  })

  it('clause 4 — no bare <img> bound to an ALIASED presigned src', () => {
    // The Lightbox filmstrip is what this was written for: `im.src` carries a view_url with the
    // field name stripped off, so noBareViewUrlImg cannot see it, and a bare <img> has no onError —
    // it painted 24 full originals at 52x52 AND blanked permanently at the 900s TTL.
    const offenders = []
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length)
      if (ALIASED_ALLOWED.has(rel)) continue
      for (const hit of findAliasedSrcImgs(readFileSync(file, 'utf8'))) offenders.push(`${rel}: ${hit}`)
    }
    expect(offenders, `a slide alias is still a presigned photo URL: it expires in 900s and it has a thumb. Route it through <PhotoView tier="thumb">. Offenders:\n${offenders.join('\n')}`).toEqual([])
  })

  it('clause 2 is a RATCHET — the allow-list may only shrink', () => {
    // Pins the count so migrating a surface without deleting its entry, or re-adding one, fails
    // here. Update this number DOWNWARD only.
    expect(PHOTOIMG_ALLOWED.size).toBe(6)
    for (const rel of PHOTOIMG_ALLOWED) {
      if (rel === 'components/photo/PhotoView.jsx') continue
      expect(/<PhotoImg\b/.test(stripComments(readFileSync(join(SRC, rel), 'utf8'))),
        `${rel} is allow-listed but no longer renders <PhotoImg> — delete its entry and decrement the ratchet count`).toBe(true)
    }
  })

  it('the migrated surfaces are actually on the primitive', () => {
    // A delisting is only real if the surface renders <PhotoView>. PutUpPhotoThumb joined this list
    // with V4-PHOTOIDARM-001; EventDetail is here because it is the surface the id-only arm was
    // built for, and it must not quietly slide back to an allow-listed wrapper. PlantingTile joined
    // with V4-PHOTOUI-001 — it is the highest-volume photo surface in the app (24 tiles per Garden
    // group), so a silent slide back is the one that costs the most.
    // CareNeeded / GrowthStrip / Garden joined with BUG-TIERLESSPHOTOS-001. CareNeeded is the one
    // to watch: it is on Today, the post-login landing route, at ~200 rows.
    // PlantingDetail / ProjectDetail joined with BUG-TIERLESSPHOTOS-001 and are the last two pages
    // that were still hand-picking a source; PlantingDetail's grid was the largest single payload
    // in the app at ~99.5 MB for a 24-photo planting.
    for (const rel of ['pages/PhotoLibrary.jsx', 'components/PhotosWall.jsx',
                       'components/PutUpPhotoThumb.jsx', 'pages/EventDetail.jsx',
                       'components/PlantingTile.jsx', 'components/today/CareNeeded.jsx',
                       'components/planting/GrowthStrip.jsx', 'pages/Garden.jsx',
                       'pages/PlantingDetail.jsx', 'pages/ProjectDetail.jsx']) {
      const code = stripComments(readFileSync(join(SRC, rel), 'utf8'))
      expect(code.includes('<PhotoView'), `${rel} must render <PhotoView>`).toBe(true)
      expect(/<PhotoImg\b/.test(code), `${rel} must not render <PhotoImg> directly`).toBe(false)
    }
  })
})
