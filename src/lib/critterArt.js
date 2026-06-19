// critterArt — resolve a critter's art to the ANIMATED set by default, with the static
// reserve served when the user prefers reduced motion. Single source of truth for the
// V3-CRITANIM-001 default-swap so every surface (Collection dex, in-garden CritterSprite)
// behaves identically.
//
// Asset layout (brahmagupta build): static reserve at public/critters/{file}.svg, animated
// at public/critters/animated/{file}.svg with IDENTICAL filenames — so the swap is a pure
// path-prefix change. Files in public/ are served verbatim (no SVGO), so the SMIL motion
// survives. prefers-reduced-motion → static reserve (the animation is then never requested).
//
// Reduced-motion is read live (matchMedia) and may be overridden for tests/SSR safety.

export function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

// '/critters/C001-honeybee.svg' -> '/critters/animated/C001-honeybee.svg'
// Idempotent: an already-animated path is returned unchanged. Non-/critters/ paths
// (e.g. launch-5 prototype art with no animated counterpart) are returned unchanged.
export function animatedArtUrl(staticUrl) {
  if (!staticUrl || typeof staticUrl !== 'string') return staticUrl
  if (staticUrl.includes('/critters/animated/')) return staticUrl
  const i = staticUrl.lastIndexOf('/')
  if (i < 0) return staticUrl
  const dir = staticUrl.slice(0, i)
  if (!dir.endsWith('/critters')) return staticUrl
  return dir + '/animated' + staticUrl.slice(i)
}

// Resolve to animated unless reduced motion is preferred (or explicitly forced static).
// reducedMotion: optional boolean override (defaults to live matchMedia).
export function resolveCritterArt(staticUrl, { reducedMotion } = {}) {
  const rm = reducedMotion ?? prefersReducedMotion()
  return rm ? staticUrl : animatedArtUrl(staticUrl)
}
