// V4-IMGRELIAB-001 §A5 — class-level guard: a bare <img> bound to a presigned-photo field
// (view_url / thumb_url / featured_photo_view_url) is BANNED. Those URLs are S3 presigns with a 900s
// TTL; a bare <img> has no onError, so once the URL expires it blanks permanently. Every such surface
// must go through <PhotoImg>, which self-heals (re-mints via GET /api/photos/view-url/:id).
//
// WHY A STATIC SCAN: the failure is a time-delayed blank (URL expiry), invisible to jsdom — a render
// test never sees it. This guard freezes the A2b migration so Lane C cannot ship a bare space-hero
// <img>, and a future UI rewrite cannot silently re-scatter a bare photo <img>.
//
// TAG-AWARE + MULTI-LINE (crucible BLOCKER): this codebase writes `<img` and `src={…}` on separate
// lines, so a line-by-line scan (like the sibling noNativeLazyImages guard) matches NOTHING and passes
// vacuously. The matcher below spans the whole <img …> tag. It keys on the lowercase intrinsic `<img`,
// so composing COMPONENTS (<PhotoImg initialUrl={…view_url}>, <HeroPhoto src={…featured_photo_view_url}>)
// are inherently excluded, and it requires the JSX brace form `src={…}`, so DOM `.src = …view_url`
// assignments are excluded too. The self-test below proves it flags a real offender (a matcher that
// matches nothing is the worst outcome).
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(process.cwd(), 'src') + '/'
// Deliberate exceptions — each carries its reason inline (mirrors the sibling guard's convention).
const ALLOWED = new Set([
  // PhotoLibrary GRID renders thumb_url (~200KB) NOT the 4080×3072 original, per BUG-PHOTOBLANK-001
  // (30 originals ≈ 90MB → blank tab). PhotoImg's mint returns the full view_url, so the grid keeps its
  // bandwidth-gated hand-rolled thumb→full onError until a thumb-aware PhotoImg mode exists. The MODAL
  // (full-size, single image) IS migrated. Re-evaluate when PhotoImg gains a thumb variant.
  'pages/PhotoLibrary.jsx',
])

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

// Strip comments so explanatory prose that legitimately quotes the field names is not read as markup.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

// Return the bare-<img> offenders in `code` (already-stripped or raw). Exported + self-tested so the
// matcher's correctness is proven, not assumed. A `<img …>` tag (attrs may span newlines) whose
// src={…} references a presigned-photo field is an offender.
const IMG_TAG = /<img\b[^>]*>/g
const SRC_FIELD = /\bsrc=\{[^}]*(?:featured_photo_view_url|thumb_url|view_url)/
export function findBareViewUrlImgs(code) {
  const stripped = stripComments(code)
  const offenders = []
  let m
  while ((m = IMG_TAG.exec(stripped)) !== null) {
    if (SRC_FIELD.test(m[0])) offenders.push(m[0].replace(/\s+/g, ' ').slice(0, 70))
  }
  return offenders
}

describe('§A5 matcher self-test (a lint that matches nothing is worse than no lint)', () => {
  it('FLAGS a single-line bare <img> bound to view_url', () => {
    expect(findBareViewUrlImgs('<img src={p.view_url} alt="x" />')).toHaveLength(1)
  })
  it('FLAGS a MULTI-LINE bare <img> bound to view_url (the codebase shape)', () => {
    expect(findBareViewUrlImgs('<img\n  src={photo.view_url}\n  decoding="async"\n/>')).toHaveLength(1)
  })
  it('FLAGS thumb_url and featured_photo_view_url', () => {
    expect(findBareViewUrlImgs('<img src={photo.thumb_url || photo.view_url} />')).toHaveLength(1)
    expect(findBareViewUrlImgs('<img src={pl.featured_photo_view_url} alt="" />')).toHaveLength(1)
  })
  it('does NOT flag composing components (<PhotoImg>, <HeroPhoto>)', () => {
    expect(findBareViewUrlImgs('<PhotoImg initialUrl={photo.view_url} />')).toHaveLength(0)
    expect(findBareViewUrlImgs('<HeroPhoto src={pl.featured_photo_view_url} />')).toHaveLength(0)
  })
  it('does NOT flag an object-literal slide, a comment, or a DOM .src assignment', () => {
    expect(findBareViewUrlImgs('const s = { src: p.view_url, alt: c }')).toHaveLength(0)
    expect(findBareViewUrlImgs('// swaps to photo.view_url on error')).toHaveLength(0)
    expect(findBareViewUrlImgs('e.currentTarget.src = photo.view_url')).toHaveLength(0)
  })
  it('does NOT flag a PhotoImg-style bare <img src={src}> with no presigned field', () => {
    expect(findBareViewUrlImgs('<img ref={r} src={src} onError={h} />')).toHaveLength(0)
  })
})

describe('no bare <img> bound to a presigned-photo field (V4-IMGRELIAB-001 §A5)', () => {
  it('every photo <img> goes through <PhotoImg>', () => {
    const offenders = []
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length)
      if (ALLOWED.has(rel)) continue
      for (const hit of findBareViewUrlImgs(readFileSync(file, 'utf8'))) offenders.push(`${rel}: ${hit}`)
    }
    expect(offenders, `bare presigned-photo <img> can blank permanently on URL expiry — route it through <PhotoImg>. Offenders:\n${offenders.join('\n')}`).toEqual([])
  })

  it('the Lightbox main image is a <PhotoImg>, not a bare <img src={current.src}> (aliased src the field-scan cannot see)', () => {
    const code = stripComments(readFileSync(join(SRC, 'components/Lightbox.jsx'), 'utf8'))
    expect(/<img\b[^>]*\bsrc=\{current\.src\}/.test(code), 'Lightbox main <img src={current.src}> must be <PhotoImg> for self-heal').toBe(false)
    expect(code.includes('<PhotoImg')).toBe(true)
  })
})
