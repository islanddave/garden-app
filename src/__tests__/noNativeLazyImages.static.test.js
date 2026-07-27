// BUG-PHOTOTHUMB-001 — class-level guard: native loading="lazy" is BANNED on <img> in this app.
//
// WHY THIS IS A STATIC SCAN AND NOT A RENDER TEST: the failure is invisible to jsdom. Every unit
// test passed for as long as the bug existed, because jsdom does not implement lazy loading at all
// — it never fetches images, so an <img loading="lazy"> that a real browser silently refuses to
// request looks identical to a working one. Only a live browser (or this text scan) can see it.
//
// Measured on the live app 2026-07-27, Dave's own browser: 120 <img> with correct srcs, 9 in the
// viewport → 0 network requests. The same elements flipped to eager loaded instantly. Explicit
// width/height did NOT rescue it, and IntersectionObserver is the same viewport-intersection
// machinery so it does not rescue it either. Image count is bounded by useImageWindow instead.
//
// This guard exists because the fix has to hold across 12 surfaces and a pending UI wave
// (v4-uiux-homogenization) is going to rewrite several of them. Reintroducing the attribute makes
// images silently stop loading — no error, no broken-image icon, just blank.
//
// If a future surface genuinely needs it, prove native lazy actually FIRES there in a real browser
// first (count network requests), then add that file to ALLOWED with the evidence in a comment.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(process.cwd(), 'src') + '/'
const ALLOWED = new Set([]) // empty by design — see header before adding anything

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue   // app markup only; this guard's own source names the attribute
      out.push(...walk(full)); continue
    }
    if (/\.(jsx?|tsx?)$/.test(name) && !/\.test\.[jt]sx?$/.test(name)) out.push(full)
  }
  return out
}

// Strip comments so the explanatory prose in PhotoLibrary/PhotosWall/useImageWindow (which
// legitimately quotes the banned attribute) is not mistaken for real markup.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('no native loading="lazy" on images (BUG-PHOTOTHUMB-001)', () => {
  it('no source file sets loading="lazy"', () => {
    const offenders = []
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length)
      if (ALLOWED.has(rel)) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      code.split('\n').forEach((line, i) => {
        if (/loading\s*=\s*["'{]?\s*["']?lazy/.test(line)) offenders.push(`${rel}:${i + 1}`)
      })
    }
    expect(offenders, `native lazy-loading never fires in this app — images would silently never be requested. Offenders:\n${offenders.join('\n')}`).toEqual([])
  })
})
