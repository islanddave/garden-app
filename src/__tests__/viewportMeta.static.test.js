// V4-KBVIEWPORT-001 — static guard on index.html's viewport meta.
//
// WHY A FILE-READING TEST. vitest.config.ts runs `environment: 'jsdom'` with no
// `environmentOptions.html`, so jsdom builds its document from a synthetic blank page and
// index.html is NEVER loaded into it. `document.querySelector('meta[name=viewport]')` in a normal
// test queries a document the tag was never in — it would return null and the assertion would have
// to be written backwards to pass, proving nothing. Reading the source file is the only way to see
// this at all, and it follows the house pattern already established by noBareViewUrlImg.static,
// noNativeLazyImages.static and pubhide.static.
//
// WHAT IT CATCHES: silent removal or mutation of `interactive-widget=resizes-content` by a merge,
// a re-skin, or an html-transform plugin. That one attribute is the entire fix; nothing else in CI
// can observe it, and losing it regresses the app to the V4-PICKERUX-001 root cause with a fully
// green pipeline.
//
// WHAT IT DOES NOT CATCH: whether Chrome honors the key (device pass), and whether the token
// survives `vite build` into dist/index.html — that is guarded by a grep in deploy.yml and
// deploy-staging.yml, because this test reads source, not the built artifact.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

// Deliberately narrow: the FIRST viewport meta wins in the parser, so matching greedily across the
// file could read a later duplicate and miss a broken first one.
function viewportContent(source) {
  const m = source.match(/<meta\s+name="viewport"\s+content="([^"]*)"/i)
  return m ? m[1] : null
}

describe('index.html viewport meta (V4-KBVIEWPORT-001)', () => {
  it('declares interactive-widget=resizes-content', () => {
    expect(viewportContent(html)).toContain('interactive-widget=resizes-content')
  })

  it('still declares viewport-fit=cover — the Apple/safe-area contract §8.1 preserved', () => {
    // Unknown viewport keys are dropped INDIVIDUALLY by non-supporting browsers, which is the only
    // reason appending interactive-widget to this shared tag is safe. If a future edit replaces the
    // string rather than extending it, this is what notices.
    expect(viewportContent(html)).toContain('viewport-fit=cover')
    expect(viewportContent(html)).toContain('width=device-width')
  })

  it('keeps the Apple meta tags — §8.1 "do not remove", previously unguarded', () => {
    // §8.1 ruled iOS out of scope but explicitly kept the install surface: "leave the surface,
    // accept the degradation." Nothing in the repo enforced that until now.
    for (const tag of [
      'apple-mobile-web-app-capable',
      'apple-mobile-web-app-status-bar-style',
      'apple-mobile-web-app-title',
      'mobile-web-app-capable',
    ]) {
      expect(html).toContain(`name="${tag}"`)
    }
  })

  it('SELF-TEST: the matcher actually flags a viewport meta missing the key', () => {
    // Without this, a matcher that silently stops matching (e.g. after an attribute-order change)
    // would make every assertion above vacuously true. Mandatory per the static-test house pattern.
    const broken = '<meta name="viewport" content="width=device-width, initial-scale=1.0" />'
    expect(viewportContent(broken)).not.toBeNull()
    expect(viewportContent(broken)).not.toContain('interactive-widget')
  })
})
