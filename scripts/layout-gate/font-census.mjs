// font-census.mjs — which fonts actually PAINTED a page's text, read from Chrome itself.
//
// Companion to tests/harness/robotoPin.js (V5-TODAYSHAPECI-001 / OPS-UNDOTOASTGATECI-001). The pin's
// own report (window.__fontPin) proves the Roboto faces LOADED; it cannot prove the page USED them.
// Text reaches a host font whenever a stack runs past every aliased name: a component that declares
// a family nobody aliased, a generic-only stack, a glyph no Roboto subset carries. On the Mac that is
// San Francisco and on CI's runner DejaVu Sans — exactly the Mac/CI divergence the pin exists to
// remove — and nothing else in a gate's numbers would say so. CSS.getPlatformFontsForNode is the
// renderer's own account of which font drew how many glyphs of each element's text, so this answers
// the question directly instead of inferring it from a width.
//
// Measured on a standalone page 2026-09-25 (Chrome 153, macOS): the app's body stack went from
// `.SF NS` (host) to `Roboto` (web font) under the pin, and glyphs outside the loaded subsets were
// reported as `.SF NS` (host) — the case this exists to catch.
//
// It tags text-bearing elements with a marker attribute to address them over CDP and removes every
// marker before returning. Run it AFTER a gate has measured, never before.
const MARK = 'data-font-census'

// THE ONLY TEXT ALLOWED TO PAINT IN A HOST FONT: characters the pinned Roboto build does not carry,
// on elements whose whole text is those characters. Each falls through every aliased family to the
// host's fallback (measured: ▾ in `.SF NS` and ⋯ in PingFang SC on the Mac, both in DejaVu Sans on the
// CI runner), so it is drawn by a different font on every machine, including the phone. Allowed ONLY
// because it cannot move a box: measured 2026-09-25 on Today busyfull at 426x836, replacing every one
// of them with Roboto-painted ASCII ('v', '...') left all 9 group cards [3332, 54 x8], all 9 chevron
// header rows (52px), all 4 chooser buttons (36px) and the page (6620px) exactly where they were —
// the rows and buttons that hold them are fixed-size. Their glyph RECTS still follow the host font's
// ascent and descent, so the Today gate's ink count skips them (today-shape.mjs, INK). A new entry
// here needs the same measurement, not an assumption.
export const HOST_FONT_OK = {
  '▾': '▾ — the care-group disclosure chevron (CareNeeded.jsx), inside a 52px header row',
  '⋯': '⋯ — the bulk "Choose which … to log" button (CareNeeded.jsx), 34x36 fixed',
}

export async function fontCensus({ send, sessionId, evalIn }, rootSelector) {
  const texts = await evalIn(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)})
    if (!root) return null
    const out = []
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const own = [...el.childNodes].filter(c => c.nodeType === 3).map(c => c.nodeValue).join('')
      if (own.trim()) { el.setAttribute('${MARK}', String(out.length)); out.push(own) }
    }
    return out
  })()`)
  if (!texts) throw new Error(`font census: ${rootSelector} is not in the page`)
  const byFont = new Map()
  const violations = []
  let allowed = 0
  try {
    await send('DOM.enable', {}, sessionId)
    await send('CSS.enable', {}, sessionId)
    const { root } = await send('DOM.getDocument', { depth: 0 }, sessionId)
    const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: `[${MARK}]` }, sessionId)
    // Both lists are in document order; a count that disagrees means the page changed underneath the
    // census, and every per-element attribution below would be wrong.
    if (nodeIds.length !== texts.length) throw new Error(`font census: tagged ${texts.length} elements, CDP found ${nodeIds.length}`)
    for (let i = 0; i < nodeIds.length; i++) {
      const { fonts } = await send('CSS.getPlatformFontsForNode', { nodeId: nodeIds[i] }, sessionId)
      for (const f of fonts) {
        const key = `${f.familyName} ${f.isCustomFont ? '(web font)' : '(HOST font)'}`
        byFont.set(key, (byFont.get(key) || 0) + f.glyphCount)
        if (f.isCustomFont) continue
        const text = texts[i].replace(/\s+/g, '')
        if (text && [...text].every(ch => ch in HOST_FONT_OK)) { allowed += f.glyphCount; continue }
        violations.push(`${f.familyName} painted ${f.glyphCount} glyph(s) of ${JSON.stringify(texts[i].replace(/\s+/g, ' ').trim().slice(0, 60))}`)
      }
    }
  } finally {
    await evalIn(`(() => { for (const el of document.querySelectorAll('[${MARK}]')) el.removeAttribute('${MARK}'); return 1 })()`)
    try { await send('CSS.disable', {}, sessionId); await send('DOM.disable', {}, sessionId) } catch { /* the page may already be gone */ }
  }
  const entries = [...byFont.entries()].sort((a, b) => b[1] - a[1])
  return {
    elements: texts.length,
    glyphs: entries.reduce((a, [, v]) => a + v, 0),
    webGlyphs: entries.filter(([k]) => k.endsWith('(web font)')).reduce((a, [, v]) => a + v, 0),
    allowedHostGlyphs: allowed,
    fonts: Object.fromEntries(entries),
    violations,
  }
}

export const fmtCensus = c => `${c.glyphs} glyphs in ${c.elements} text-bearing elements — ${Object.entries(c.fonts).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}${c.allowedHostGlyphs ? ` (${c.allowedHostGlyphs} host glyph(s), all allowlisted ${Object.keys(HOST_FONT_OK).join(' ')})` : ''}`

// One fixed string laid out in the app's own body stack at three weight/size pairs the two surfaces
// use. The same font file on two machines should lay it out to the same width; when a Mac run and a
// CI run disagree, this number says whether the renderer's glyph advances differ (hinting, subpixel
// positioning) before anyone reads the page-level numbers. Printed, never asserted.
const PROBE = 'Logged Water for Marvel of Four Seasons Butterhead Lettuce — 0.31 in · 45°F'
export async function fontProbe(evalIn) {
  return evalIn(`(() => {
    const s = document.createElement('span')
    s.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap;font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    s.textContent = ${JSON.stringify(PROBE)}
    document.body.appendChild(s)
    const out = {}
    for (const [w, px] of [[400, 16], [600, 14], [700, 13.6]]) {
      s.style.fontWeight = String(w); s.style.fontSize = px + 'px'
      out[w + ' ' + px + 'px'] = Math.round(s.getBoundingClientRect().width * 1000) / 1000
    }
    s.remove()
    return out
  })()`)
}
