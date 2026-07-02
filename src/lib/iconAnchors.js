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
    colorFills: { body: 'dropBody', highlight: 'dropHighlight' },
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
  // ── V4-ICONCOLOR-001 color-candidate glance/lifecycle glyphs (multi-region, solid). ──
  // sun = care/weather, gold. body=disc, rays=stroke (both gold via colorFills).
  'care.sun': {
    class: 'color-candidate', register: 'functional', variant: 'filled',
    regionIntent: { body: 'solar disc — gold fill', rays: 'eight radial rays — gold stroke' },
    colorFills: { body: 'sunBody', rays: 'sunRays' },
    svg24: '<circle data-region="body" cx="12" cy="12" r="4.4" fill="currentColor" stroke="none"/><g data-region="rays" stroke="currentColor" fill="none"><path d="M12 3.2v2.6"/><path d="M12 18.2v2.6"/><path d="M3.2 12h2.6"/><path d="M18.2 12h2.6"/><path d="M5.8 5.8l1.85 1.85"/><path d="M16.35 16.35l1.85 1.85"/><path d="M18.2 5.8l-1.85 1.85"/><path d="M7.65 16.35l-1.85 1.85"/></g>',
    svg18: '<circle data-region="body" cx="12" cy="12" r="4.6" fill="currentColor" stroke="none"/><g data-region="rays" stroke="currentColor" fill="none"><path d="M12 2.6v2.8"/><path d="M12 18.6v2.8"/><path d="M2.6 12h2.8"/><path d="M18.6 12h2.8"/><path d="M5.6 5.6l2 2"/><path d="M16.4 16.4l2 2"/><path d="M18.4 5.6l-2 2"/><path d="M7.6 16.4l-2 2"/></g>',
  },
  // lifecycle stages (sprout->bud->bloom->fruit). functional color-candidates; geometry
  // echoes the mono status forms (seedling/flowering/fruiting) so there is zero drift.
  'lifecycle.sprout': {
    class: 'color-candidate', register: 'functional', variant: 'filled',
    regionIntent: { leaf: 'cotyledon leaves — fresh green', stem: 'stem — deep green', soil: 'soil line — brown (24 only)' },
    colorFills: { leaf: 'lcSproutLeaf', stem: 'lcStem', soil: 'lcSoil' },
    svg24: '<path data-region="soil" d="M4.5 20.5h15" fill="none" stroke="currentColor"/><path data-region="stem" d="M12 20.5v-8.2" fill="none" stroke="currentColor"/><path data-region="leaf" d="M12 13.2C9.2 13.2 7 11 7 8.2c2.8 0 5 2.2 5 5z" fill="currentColor" stroke="none"/><path data-region="leaf" d="M12 11.4c0-2.4 1.9-4.3 4.3-4.3 0 2.4-1.9 4.3-4.3 4.3z" fill="currentColor" stroke="none"/>',
    svg18: '<path data-region="stem" d="M12 20v-7" fill="none" stroke="currentColor"/><path data-region="leaf" d="M12 14C9.4 14 7.4 12 7.4 9.4c2.6 0 4.6 2 4.6 4.6z" fill="currentColor" stroke="none"/><path data-region="leaf" d="M12 12.4c0-2.2 1.8-4 4-4 0 2.2-1.8 4-4 4z" fill="currentColor" stroke="none"/>',
  },
  'lifecycle.bud': {
    class: 'color-candidate', register: 'functional', variant: 'filled',
    regionIntent: { bud: 'closed flower bud — purple', calyx: 'calyx leaves — green', stem: 'stem — deep green' },
    colorFills: { bud: 'lcBud', calyx: 'lcSproutLeaf', stem: 'lcStem' },
    svg24: '<path data-region="stem" d="M12 20.5v-7" fill="none" stroke="currentColor"/><path data-region="calyx" d="M9.4 13.5c-1.4 0-2.5-1.1-2.5-2.5 1.4 0 2.5 1.1 2.5 2.5z" fill="currentColor" stroke="none"/><path data-region="calyx" d="M14.6 13.5c1.4 0 2.5-1.1 2.5-2.5-1.4 0-2.5 1.1-2.5 2.5z" fill="currentColor" stroke="none"/><path data-region="bud" d="M12 4.2c2.4 1.4 3.4 4.3 2.4 7-0.6 1.6-1.5 2.4-2.4 3-0.9-0.6-1.8-1.4-2.4-3-1-2.7 0-5.6 2.4-7z" fill="currentColor" stroke="none"/>',
    svg18: '<path data-region="stem" d="M12 20.5v-6.5" fill="none" stroke="currentColor"/><path data-region="bud" d="M12 4c2.6 1.5 3.6 4.6 2.5 7.5-0.6 1.6-1.6 2.5-2.5 3.1-0.9-0.6-1.9-1.5-2.5-3.1-1.1-2.9-0.1-6 2.5-7.5z" fill="currentColor" stroke="none"/>',
  },
  'lifecycle.bloom': {
    class: 'color-candidate', register: 'functional', variant: 'filled',
    regionIntent: { petals: 'open flower petals — terra', center: 'flower center — gold' },
    colorFills: { petals: 'lcBloomPetals', center: 'lcBloomCenter' },
    svg24: '<path data-region="petals" d="M12.00 9.60C14.60 9.60 13.04 3.40 12.00 3.40C10.96 3.40 9.40 9.60 12.00 9.60z" fill="currentColor" stroke="none"/><path data-region="petals" d="M14.28 11.26C15.09 13.73 20.50 10.33 20.18 9.34C19.86 8.35 13.48 8.79 14.28 11.26z" fill="currentColor" stroke="none"/><path data-region="petals" d="M13.41 13.94C11.31 15.47 16.21 19.57 17.05 18.96C17.90 18.35 15.51 12.41 13.41 13.94z" fill="currentColor" stroke="none"/><path data-region="petals" d="M10.59 13.94C8.49 12.41 6.10 18.35 6.95 18.96C7.79 19.57 12.69 15.47 10.59 13.94z" fill="currentColor" stroke="none"/><path data-region="petals" d="M9.72 11.26C10.52 8.79 4.14 8.35 3.82 9.34C3.50 10.33 8.91 13.73 9.72 11.26z" fill="currentColor" stroke="none"/><circle data-region="center" cx="12" cy="12" r="2.0" fill="currentColor" stroke="none"/>',
    svg18: '<path data-region="petals" d="M12 10.3C10.3 8.6 10.3 5.9 12 4.2 13.7 5.9 13.7 8.6 12 10.3z" fill="currentColor" stroke="none"/><path data-region="petals" d="M13.7 12C15.4 10.3 18.1 10.3 19.8 12 18.1 13.7 15.4 13.7 13.7 12z" fill="currentColor" stroke="none"/><path data-region="petals" d="M12 13.7C13.7 15.4 13.7 18.1 12 19.8 10.3 18.1 10.3 15.4 12 13.7z" fill="currentColor" stroke="none"/><path data-region="petals" d="M10.3 12C8.6 13.7 5.9 13.7 4.2 12 5.9 10.3 8.6 10.3 10.3 12z" fill="currentColor" stroke="none"/><circle data-region="center" cx="12" cy="12" r="2.0" fill="currentColor" stroke="none"/>',
  },
  'lifecycle.fruit': {
    class: 'color-candidate', register: 'functional', variant: 'filled',
    regionIntent: { fruit: 'ripe round fruit — terra', cap: 'leaf/stem cap — deep green' },
    colorFills: { fruit: 'lcFruit', cap: 'lcStem' },
    svg24: '<path data-region="fruit" d="M12 21.4c-4.6 0-8.1-3.4-8.1-7.7 0-4 3-7 7-7.3 0.7-0.1 1.5-0.1 2.2 0 4 0.3 7 3.3 7 7.3 0 4.3-3.5 7.7-8.1 7.7z" fill="currentColor" stroke="none"/><path data-region="cap" d="M12 6.4V3.8" fill="none" stroke="currentColor"/><path data-region="cap" d="M12 6.2c-1.8 0-3.2-1.4-3.3-3.2 1.8 0 3.3 1.4 3.3 3.2z" fill="currentColor" stroke="none"/>',
    svg18: '<path data-region="fruit" d="M12 20.8c-4.4 0-7.6-3.3-7.6-7.4 0-4.1 3.2-7.4 7.6-7.4s7.6 3.3 7.6 7.4c0 4.1-3.2 7.4-7.6 7.4z" fill="currentColor" stroke="none"/><path data-region="cap" d="M12 6V3.4" fill="none" stroke="currentColor"/><path data-region="cap" d="M12 6.2c-1.6 0-2.9-1.2-3-2.9 1.6 0 3 1.2 3 2.9z" fill="currentColor" stroke="none"/>',
  },
  // ── V200 Slice-5b mono utility glyphs (photo hero + fly-up; emoji-free hard rule). ──
  // nav.back = left chevron (hero back control). mono. 18 widens the chevron angle slightly for aperture.
  'nav.back': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
    svg18: '<path d="M14.5 6L9 12l5.5 6"/>',
  },
  // action.share = iOS-style tray + up-arrow (cleaner than node-share at 18). mono.
  // 18 drops nothing — narrows the tray gap + arrow so the up-arrow keeps aperture.
  'action.share': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M12 3.6v10.2"/><path d="M8.4 7.2L12 3.6l3.6 3.6"/><path d="M7.4 10.4H5.6a1.4 1.4 0 0 0-1.4 1.4v7a1.4 1.4 0 0 0 1.4 1.4h12.8a1.4 1.4 0 0 0 1.4-1.4v-7a1.4 1.4 0 0 0-1.4-1.4h-1.8"/>',
    svg18: '<path d="M12 3.8v9.4"/><path d="M8.6 7.2L12 3.8l3.4 3.4"/><path d="M7.6 10.6H5.8a1.4 1.4 0 0 0-1.4 1.4v6.6a1.4 1.4 0 0 0 1.4 1.4h12.4a1.4 1.4 0 0 0 1.4-1.4v-6.6a1.4 1.4 0 0 0-1.4-1.4h-1.8"/>',
  },
  // action.info = "i" in a circle (Details pill). mono + one solid dot (echoes severity.high's dot).
  'action.info': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<circle cx="12" cy="12" r="8.4"/><path d="M12 11v5.4"/><circle cx="12" cy="7.9" r="0.8" fill="currentColor" stroke="none"/>',
    svg18: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11.2v5.2"/><circle cx="12" cy="7.8" r="0.9" fill="currentColor" stroke="none"/>',
  },
  // action.edit = pencil (edit affordance). mono. 18 drops the ferrule line (closes to noise <20px, §4 aperture).
  'action.edit': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M16.4 4.6l3 3-9.5 9.5-3.6.6.6-3.6z"/><path d="M14.6 6.4l3 3"/>',
    svg18: '<path d="M16.2 4.8l3 3-9.4 9.4-3.7.7.7-3.7z"/>',
  },
  // action.archive = lid + box + handle slot. mono.
  'action.archive': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M4.4 6.2h15.2v3H4.4z"/><path d="M5.6 9.2h12.8v8.8a1.2 1.2 0 0 1-1.2 1.2H6.8a1.2 1.2 0 0 1-1.2-1.2z"/><path d="M9.6 12.6h4.8"/>',
    svg18: '<path d="M4.6 6.4h14.8v3.2H4.6z"/><path d="M5.8 9.6h12.4v8.4a1.2 1.2 0 0 1-1.2 1.2H7a1.2 1.2 0 0 1-1.2-1.2z"/><path d="M9.8 12.8h4.4"/>',
  },
  // media.camera = body + viewfinder bump + lens (add-photo action). mono.
  'media.camera': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M4.2 8.4h3l1.4-2.2h6.8l1.4 2.2h2.6a1.2 1.2 0 0 1 1.2 1.2v8.4a1.2 1.2 0 0 1-1.2 1.2H4.2a1.2 1.2 0 0 1-1.2-1.2V9.6a1.2 1.2 0 0 1 1.2-1.2z"/><circle cx="12" cy="13.4" r="3.4"/>',
    svg18: '<path d="M4.4 8.6h3.2l1.4-2.2h6l1.4 2.2h2.2a1.2 1.2 0 0 1 1.2 1.2v8a1.2 1.2 0 0 1-1.2 1.2H4.4a1.2 1.2 0 0 1-1.2-1.2V9.8a1.2 1.2 0 0 1 1.2-1.2z"/><circle cx="12" cy="13.4" r="3.4"/>',
  },
  // ── media-control family (play/pause/stop) — solid fills, rounded corners, mutually consistent. ──
  // media.play = solid right triangle w/ rounded vertices (matches set rounded-join grammar). solid.
  'media.play': {
    class: 'mono', register: 'functional', variant: 'filled',
    svg24: '<path d="M8 5.9a1 1 0 0 1 1.5-.86l9.2 5.96a1 1 0 0 1 0 1.68l-9.2 5.96A1 1 0 0 1 8 17.86z" fill="currentColor" stroke="none"/>',
    svg18: '<path d="M8.3 6.2a1 1 0 0 1 1.5-.86l8.4 5.66a1 1 0 0 1 0 1.66l-8.4 5.66A1 1 0 0 1 8.3 17.5z" fill="currentColor" stroke="none"/>',
  },
  // media.pause = two rounded bars (reuses care.pause geometry; own key). mono.
  'media.pause': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M9.3 6.8v10.4"/><path d="M14.7 6.8v10.4"/>',
    svg18: '<path d="M9.5 7v10"/><path d="M14.5 7v10"/>',
  },
  // media.stop = solid rounded square (time-lapse stop). solid.
  'media.stop': {
    class: 'mono', register: 'functional', variant: 'filled',
    svg24: '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="1.4" fill="currentColor" stroke="none"/>',
    svg18: '<rect x="6.6" y="6.6" width="10.8" height="10.8" rx="1.4" fill="currentColor" stroke="none"/>',
  },
  'care.containers': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M3.5 10.2H11.5"/><path d="M4.2 10.2H10.8L9.9 19a0.7 0.7 0 0 1-0.7 0.6H5.7a0.7 0.7 0 0 1-0.7-0.6Z"/><path d="M13 11H20"/><path d="M13.7 11H19.3L18.6 18.4a0.7 0.7 0 0 1-0.7 0.6H15.1a0.7 0.7 0 0 1-0.7-0.6Z"/>',
    svg18: '<path d="M3.2 10.4H11"/><path d="M4 10.4H10.2L9.4 19H5.4Z"/><path d="M12.8 11.2H19.6"/><path d="M13.5 11.2H19L18.3 18.6H14.8Z"/>',
  },
  'care.inground': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M12 14.4V8.8"/><path d="M12 10.6C9.9 10.6 8.2 8.9 8.2 6.8c2.1 0 3.8 1.7 3.8 3.8z"/><path d="M12 9.6c0.9-1.7 2.9-2.7 4.8-2.5-0.3 1.9-1.9 3.4-3.8 3.6"/><path d="M3.2 15.5H20.8"/><path d="M5.4 18.3h2"/><path d="M10.4 18.3h3.2"/><path d="M16.6 18.3h2"/>',
    svg18: '<path d="M12 14V8.4"/><path d="M12 10.4C9.8 10.4 8 8.6 8 6.4c2.2 0 4 1.8 4 4z"/><path d="M12 9.4c0.9-1.8 3-2.8 5-2.6-0.3 2-2 3.5-4 3.7"/><path d="M3 15.4H21"/><path d="M6 18.2h3"/><path d="M13 18.2h4"/>',
  },
}

export const ANCHOR_KEYS = Object.keys(A)
export default A
