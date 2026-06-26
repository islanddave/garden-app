// src/lib/iconAnchors.js — V4-ICON-001 grammar-anchor SVG masters (DESIGNSYS Pass B V101).
// AI-first data module: each anchor carries a 24px master + an 18px-optimized master
// (separate path set, NOT a shrunk 24 — §2). Inner markup only (no <svg> wrapper); the
// Icon component wraps + sets stroke/fill via tokens. Mono glyphs use stroke="currentColor"
// (consumer recolors via CSS `color`). The color-candidate `drop` ships a DEFAULT line/mono
// variant (used until the V4-ICONCOLOR-001 pass) + a `filled` multi-region variant whose
// regions carry data-region + fill="currentColor" so the color pass swaps fills with zero
// geometry redraw (§1 region-intent bridge). Construction notes tie each to the keyline kit.
// Anchor set per V101 §14: today/sprout, garden, drop, leaf, pin, alert(severity-high), heart, pause.

const A = {
  // today = SPROUT (§9: avoids the sun↔weather-sun collision). mono.
  'nav.today': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M4.5 20.5h15"/><path d="M12 20.5v-8.2"/><path d="M12 13.2C9.2 13.2 7 11 7 8.2c2.8 0 5 2.2 5 5z"/><path d="M12 11.4c0-2.4 1.9-4.3 4.3-4.3 0 2.4-1.9 4.3-4.3 4.3z"/>',
    // 18: shorten stem, soil bar narrows; both leaves kept (they carry the read).
    svg18: '<path d="M5.5 20h13"/><path d="M12 20v-7.4"/><path d="M12 13C9.4 13 7.4 11 7.4 8.4c2.6 0 4.6 2 4.6 4.6z"/><path d="M12 11.6c0-2.2 1.8-4 4-4 0 2.2-1.8 4-4 4z"/>',
  },
  // garden = potted plant. mono. RES-3: pot-dominant; 18 master drops the right sprig.
  'nav.garden': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M6.4 13.6h11.2"/><path d="M7.5 13.6l1 5.9a1 1 0 0 0 1 .8h5a1 1 0 0 0 1-.8l1-5.9z"/><path d="M12 13.6V8.6"/><path d="M12 10.8C9.6 10.8 7.7 8.9 7.7 6.5c2.4 0 4.3 1.9 4.3 4.3z"/><path d="M12 9.6c1-1.9 3.1-3 5.2-2.7-.3 2.1-2 3.8-4.1 4"/>',
    // 18: pot + ONE centered leaf (right sprig dropped per §2 complexity floor + RES-3).
    svg18: '<path d="M6.6 13.4h10.8"/><path d="M7.6 13.4l1 6a1 1 0 0 0 1 .8h4.8a1 1 0 0 0 1-.8l1-6z"/><path d="M12 13.4V8.2"/><path d="M12 10.6C9.5 10.6 7.5 8.6 7.5 6.1c2.5 0 4.5 2 4.5 4.5z"/>',
  },
  // drop. DEFAULT = line/mono (matches set weight). `filled` variant = color-candidate (blue), multi-region.
  'care.drop': {
    class: 'color-candidate', register: 'functional', variant: 'line',
    regionIntent: { body: 'teardrop silhouette — color pass: blue (#4a7fb5) fill', highlight: 'inner sheen — color pass: white/pale stroke' },
    svg24: '<path d="M12 3.4C12 3.4 6.5 9.6 6.5 13.5A5.5 5.5 0 0 0 17.5 13.5C17.5 9.6 12 3.4 12 3.4Z"/><path d="M9.6 13.7a2.6 2.6 0 0 0 2.6 2.6"/>',
    // 18: drop the sheen (closes to noise <20px, §4 aperture).
    svg18: '<path d="M12 3.8C12 3.8 7 9.6 7 13.2A5 5 0 0 0 17 13.2C17 9.6 12 3.8 12 3.8Z"/>',
    variants: {
      filled: {
        class: 'color-candidate',
        svg24: '<path data-region="body" d="M12 2.8c0 0-6 6.6-6 10.6A6 6 0 0 0 12 19.4a6 6 0 0 0 6-6c0-4-6-10.6-6-10.6z" fill="currentColor" stroke="none"/><path data-region="highlight" d="M9.2 13.6a2.8 2.8 0 0 0 2.8 2.8" fill="none" stroke="currentColor"/>',
        svg18: '<path data-region="body" d="M12 3c0 0-5.4 6-5.4 9.6A5.4 5.4 0 0 0 12 18a5.4 5.4 0 0 0 5.4-5.4c0-3.6-5.4-9.6-5.4-9.6z" fill="currentColor" stroke="none"/>',
      },
    },
  },
  // leaf = the type-facet glyph. MUST stay mono/recolorable (§3.2). single path-group.
  'facet.type': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M4.6 19.4C4.6 11 11 4.6 19.4 4.6c0 8.4-6.4 14.8-14.8 14.8z"/><path d="M6.8 17.2C9.8 14.2 13.8 10.2 16.8 7.2"/>',
    svg18: '<path d="M5 19C5 11.3 11.3 5 19 5c0 7.7-6.3 14-14 14z"/><path d="M7.2 16.8C10 14 13.6 10.4 16.4 7.6"/>',
  },
  // pin = location facet. mono.
  'facet.location': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M12 21.2c0 0-6.6-6.5-6.6-11.4A6.6 6.6 0 0 1 18.6 9.8C18.6 14.7 12 21.2 12 21.2z"/><circle cx="12" cy="9.8" r="2.5"/>',
    svg18: '<path d="M12 20.8c0 0-6.2-6.2-6.2-10.8A6.2 6.2 0 0 1 18.2 10C18.2 14.6 12 20.8 12 20.8z"/><circle cx="12" cy="10" r="2.3"/>',
  },
  // alert = severity-high (top of the §9 monotonic severity ladder). mono + one solid dot.
  'severity.high': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M12 3.8l8.7 14.9a1 1 0 0 1-.86 1.5H4.16a1 1 0 0 1-.86-1.5z"/><path d="M12 9.6v4.4"/><circle cx="12" cy="17.2" r="0.7" fill="currentColor" stroke="none"/>',
    svg18: '<path d="M12 4l8.4 14.5a1 1 0 0 1-.86 1.5H4.46a1 1 0 0 1-.86-1.5z"/><path d="M12 9.8v4.2"/><circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none"/>',
  },
  // heart = two-state (outline/filled). single shared path → no shape jump on toggle.
  'action.heart': {
    class: 'mono', register: 'functional', variant: 'outline',
    svg24: '<path d="M12 20.4C12 20.4 3.6 15.2 3.6 9.2A4.4 4.4 0 0 1 12 7.1a4.4 4.4 0 0 1 8.4 2.1C20.4 15.2 12 20.4 12 20.4z"/>',
    svg18: '<path d="M12 20C12 20 4 15 4 9.4A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 8 2.1C20 15 12 20 12 20z"/>',
    variants: {
      filled: {
        class: 'mono',
        svg24: '<path d="M12 20.4C12 20.4 3.6 15.2 3.6 9.2A4.4 4.4 0 0 1 12 7.1a4.4 4.4 0 0 1 8.4 2.1C20.4 15.2 12 20.4 12 20.4z" fill="currentColor"/>',
        svg18: '<path d="M12 20C12 20 4 15 4 9.4A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 8 2.1C20 15 12 20 12 20z" fill="currentColor"/>',
      },
    },
  },
  // pause/wait = rest-state partner to drop (§9 split-guide). mono, two bars.
  'care.pause': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M9.3 6.8v10.4"/><path d="M14.7 6.8v10.4"/>',
    svg18: '<path d="M9.5 7v10"/><path d="M14.5 7v10"/>',
  },
}

export const ANCHOR_KEYS = Object.keys(A)
export default A
