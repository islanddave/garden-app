// src/lib/iconAnchors.js — V4-ICON-001 grammar-anchor SVG masters (DESIGNSYS Pass B V101).
// AI-first data module: each anchor carries a 24px master + an 18px-optimized master
// (separate path set, NOT a shrunk 24 — §2). Inner markup only (no <svg> wrapper); the
// Icon component wraps + sets stroke/fill via tokens. Mono glyphs use stroke="currentColor"
// (consumer recolors via CSS `color`). The color-candidate `drop` ships a DEFAULT line/mono
// variant (used until the V4-ICONCOLOR-001 pass) + a `filled` multi-region variant whose
// regions carry data-region + fill="currentColor" so the color pass swaps fills with zero
// geometry redraw (§1 region-intent bridge). Construction notes tie each to the keyline kit.
// Anchor set per V101 §14: today/checklist (was today/sprout until the 2026-08-21 redraw — see
// nav.today), garden, drop, leaf, pin, alert(severity-high), heart, pause.

const A = {
  // today = DAILY CHECKLIST (two ticked rows + one open row). mono. Still satisfies the original
  // §9 constraint this key was drawn for (no sun ↔ weather-sun collision) — it just no longer
  // solves it with a sprout. DELIBERATE FORM, DO NOT CONVERGE IT BACK ON THE SEEDLING: until
  // 2026-08-21 this svg24 was a byte-copy of STATUS_GLYPHS.seedling.svg24, so one mark served a
  // NAV DESTINATION *and* the seedling/sprouting/seeding stages *and* the transplant event —
  // chrome wearing content's mark, the same defect as event.given_away ≡ action.share. Dave ruled
  // the redraw (candidate C, chosen at 77px and at real nav size): /today is a list of what to do
  // today, so the mark now states what the page is. src/__tests__/iconUniqueness.test.js fails if
  // anyone re-points this at a sprout form; the seedling family keeps its own (ruled) synonymy.
  'nav.today': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M3.6 7.6l1.6 1.6 3.2-3.4"/><path d="M11 7.4h9.4"/><path d="M3.6 13.4l1.6 1.6 3.2-3.4"/><path d="M11 13.2h9.4"/><circle cx="5.4" cy="18.6" r="1.8"/><path d="M11 18.8h6.4"/>',
    // 18: drops nothing (all three rows carry the "checklist" read) — re-tuned for aperture per §4,
    // the action.share pattern rather than the nav.garden drop-an-element one. Icon.jsx normalizes
    // strokeSmall 2.0 by 24/size, so an 18 inks at 2.0 device px against the 24's 1.75: at the 24
    // master's r1.8 the ring closes to a solid dot and row 2's tick fuses into it. Ring r1.8->2.5,
    // tick shallower + wider (vertex ~88°->101°, keeps the short leg legible), rows re-pitched to
    // clear the bigger ring, line column pulled right off the widened tick tips.
    svg18: '<path d="M3.4 6l1.8 1.3 3.7-2.9"/><path d="M11.6 6h8.8"/><path d="M3.4 11.4l1.8 1.3 3.7-2.9"/><path d="M11.6 11.4h8.8"/><circle cx="5.9" cy="18.1" r="2.5"/><path d="M11.6 18.2h6.2"/>',
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
  // ── V4-ICON-001 severity ladder (§9 monotonic progression: dot -> triangle -> triangle+alert).
  //    Shape carries the order; the consumer (SeverityBadge) sets `color` per severity tone
  //    (color reinforces, never sole — SC 1.4.1). severity.high (alert) is the top rung, above.
  // severity.low = the base rung: one kit-centered filled dot. mono/solid.
  'severity.low': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/>',
    svg18: '<circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none"/>',
  },
  // severity.med = the middle rung: the enclosure appears (open triangle, no alert content).
  //    Geometry is severity.high's triangle MINUS the bang+dot -> zero drift across the ladder.
  'severity.med': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M12 3.8l8.7 14.9a1 1 0 0 1-.86 1.5H4.16a1 1 0 0 1-.86-1.5z"/>',
    svg18: '<path d="M12 4l8.4 14.5a1 1 0 0 1-.86 1.5H4.46a1 1 0 0 1-.86-1.5z"/>',
  },
  // action.flag = the flag-issue affordance (one waving-pennant silhouette; §3 flag recommendation).
  //    mono; recolored by the consumer when it represents a flagged severity.
  'action.flag': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M7 3.6v16.8"/><path d="M7 4.8c2.9-1.7 5.9 1.7 8.8 0v6.2c-2.9 1.7-5.9-1.7-8.8 0z"/>',
    svg18: '<path d="M7.2 3.9v16.2"/><path d="M7.2 5c2.6-1.5 5.3 1.5 7.9 0v5.6c-2.6 1.5-5.3-1.5-7.9 0z"/>',
  },
  // ── V4-ICON-001 Slice 5: BottomNav mono utility/nav glyphs (emoji-free). All mono/currentColor;
  //    the consumer sets `color` (green/light on the white bar; #fff on the green FAB circle). ──
  'nav.plus': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M12 5.5v13"/><path d="M5.5 12h13"/>',
    svg18: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  },
  'nav.more': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<circle cx="5.6" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="18.4" cy="12" r="1.7" fill="currentColor" stroke="none"/>',
    svg18: '<circle cx="5.4" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="18.6" cy="12" r="1.8" fill="currentColor" stroke="none"/>',
  },
  'nav.findings': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<circle cx="12" cy="12" r="8.3"/><path d="M12 7.8v8.4"/><path d="M7.8 12h8.4"/>',
    svg18: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.6v8.8"/><path d="M7.6 12h8.8"/>',
  },
  'nav.dashboard': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M4.2 11.4 12 4.4l7.8 7"/><path d="M6.2 10v9.4a0.6 0.6 0 0 0 .6 .6h10.4a0.6 0.6 0 0 0 .6-.6V10"/>',
    svg18: '<path d="M4 11.6 12 4.2l8 7.4"/><path d="M6 10v9.4a0.6 0.6 0 0 0 .6 .6h10.8a0.6 0.6 0 0 0 .6-.6V10"/>',
  },
  'nav.inventory': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M12 3.6 4.4 7.8v8.4L12 20.4l7.6-4.2V7.8z"/><path d="M4.4 7.8 12 12l7.6-4.2"/><path d="M12 12v8.4"/>',
    svg18: '<path d="M12 3.4 4 7.8v8.4L12 20.6l8-4.4V7.8z"/><path d="M4 7.8 12 12.2l8-4.4"/><path d="M12 12.2v8.4"/>',
  },
  'nav.helper': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M5.5 6.5h13a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5H11l-4.2 3.2V16H5.5A1.5 1.5 0 0 1 4 14.5V8a1.5 1.5 0 0 1 1.5-1.5z"/>',
    svg18: '<path d="M5 6.5h14a1.5 1.5 0 0 1 1.5 1.5v6.6a1.5 1.5 0 0 1-1.5 1.5h-8l-4.4 3.3V16H5A1.5 1.5 0 0 1 3.5 14.6V8A1.5 1.5 0 0 1 5 6.5z"/>',
  },
  'action.settings': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M4 8.4h9"/><path d="M16.5 8.4H20"/><circle cx="14.7" cy="8.4" r="1.9"/><path d="M4 15.6h3.5"/><path d="M11 15.6h9"/><circle cx="9.3" cy="15.6" r="1.9"/>',
    svg18: '<path d="M3.5 8.4h9.5"/><path d="M16.7 8.4H20.5"/><circle cx="14.9" cy="8.4" r="2"/><path d="M3.5 15.6h3.5"/><path d="M11 15.6h9.5"/><circle cx="9.3" cy="15.6" r="2"/>',
  },
  'nav.notes': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M6.5 3.6h6.8l4.2 4.2v11.6a1 1 0 0 1-1 1H6.5a1 1 0 0 1-1-1V4.6a1 1 0 0 1 1-1z"/><path d="M13 3.6V8h4.4"/><path d="M8.4 12.4h7.2"/><path d="M8.4 15.6h7.2"/>',
    svg18: '<path d="M6 3.4h7l4.4 4.4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.4a1 1 0 0 1 1-1z"/><path d="M12.8 3.4V8h4.4"/><path d="M8 12.4h8"/><path d="M8 15.8h8"/>',
  },
  'nav.signout': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M13.5 5.5H6.8a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h6.7"/><path d="M10.5 12h9.5"/><path d="M16.8 8.8 20 12l-3.2 3.2"/>',
    svg18: '<path d="M13 5.4H6.5a1 1 0 0 0-1 1v11.2a1 1 0 0 0 1 1H13"/><path d="M10 12h10.4"/><path d="M17 8.6 20.4 12l-3.4 3.4"/>',
  },
  'mode.desk': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M6.4 6.5h11.2a1 1 0 0 1 1 1v7.2H5.4V7.5a1 1 0 0 1 1-1z"/><path d="M3.6 17.6h16.8"/>',
    svg18: '<path d="M6 6.4h12a1 1 0 0 1 1 1v7.4H5V7.4a1 1 0 0 1 1-1z"/><path d="M3.4 17.6h17.2"/>',
  },
  'media.mic': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M12 3.6a2.6 2.6 0 0 1 2.6 2.6v4.6a2.6 2.6 0 0 1-5.2 0V6.2A2.6 2.6 0 0 1 12 3.6z"/><path d="M6.8 11.2a5.2 5.2 0 0 0 10.4 0"/><path d="M12 16.4v3.4"/>',
    svg18: '<path d="M12 3.4a2.7 2.7 0 0 1 2.7 2.7v4.6a2.7 2.7 0 0 1-5.4 0V6.1A2.7 2.7 0 0 1 12 3.4z"/><path d="M6.6 11a5.4 5.4 0 0 0 10.8 0"/><path d="M12 16.4v3.6"/>',
  },
  'action.logmany': {
    class: 'mono', register: 'functional', variant: 'line',
    svg24: '<path d="M12 3.8 4 8l8 4.2L20 8z"/><path d="M4 12l8 4.2L20 12"/><path d="M4 16l8 4.2L20 16"/>',
    svg18: '<path d="M12 3.6 3.6 8l8.4 4.4L20.4 8z"/><path d="M3.6 12l8.4 4.4 8.4-4.4"/><path d="M3.6 16l8.4 4.4 8.4-4.4"/>',
  },
  // ── V4-ICONCOLOR-001 MARQUEE (§3.2 exemplar): nav.critters butterfly, Android-Noto orange.
  //    "The color matters" — the north-star color-candidate. 4 wings + body + antennae,
  //    symmetric about x=12. Two-tone wing (bright upper / deeper-burnt lower); deep-brown
  //    body+antennae anchor the silhouette (>=3:1 §12.2). Color pass swaps fills, zero redraw.
  'nav.critters': {
    class: 'color-candidate', register: 'functional', variant: 'filled',
    regionIntent: { wingUpper: 'upper wing pair — bright Noto orange (the glance color)', wingLower: 'lower wing pair — deeper burnt orange', body: 'head+thorax+abdomen — deep brown', antenna: 'two antennae — deep-brown stroke line' },
    colorFills: { wingUpper: 'bflyWingUpper', wingLower: 'bflyWingLower', body: 'bflyBody', antenna: 'bflyAntenna' },
    svg24: '<path data-region="wingUpper" d="M12 9C12.4 6 14.5 3.8 17.6 3.8C20 3.8 21.2 5.6 21 7.8C20.7 10.3 18 12.4 14.8 12.2C13.2 12.1 12 11 12 9.4Z" fill="currentColor" stroke="none"/><path data-region="wingUpper" d="M12 9C11.6 6 9.5 3.8 6.4 3.8C4 3.8 2.8 5.6 3 7.8C3.3 10.3 6 12.4 9.2 12.2C10.8 12.1 12 11 12 9.4Z" fill="currentColor" stroke="none"/><path data-region="wingLower" d="M12 11.4C12.8 12.4 14.6 12.6 16.2 13C18.4 13.6 19.6 15.4 18.8 17.4C18 19.4 15.4 19.8 13.6 18.6C12.4 17.8 12 16 12 14Z" fill="currentColor" stroke="none"/><path data-region="wingLower" d="M12 11.4C11.2 12.4 9.4 12.6 7.8 13C5.6 13.6 4.4 15.4 5.2 17.4C6 19.4 8.6 19.8 10.4 18.6C11.6 17.8 12 16 12 14Z" fill="currentColor" stroke="none"/><circle data-region="body" cx="12" cy="6.4" r="1.5" fill="currentColor" stroke="none"/><path data-region="body" d="M12 7.4C13.1 7.4 13.7 8.4 13.7 10L12.7 17C12.6 17.9 12.3 18.3 12 18.6C11.7 18.3 11.4 17.9 11.3 17L10.3 10C10.3 8.4 10.9 7.4 12 7.4Z" fill="currentColor" stroke="none"/><path data-region="antenna" d="M12 5.6C12.8 4 14 3.2 15.4 3" fill="none" stroke="currentColor"/><path data-region="antenna" d="M12 5.6C11.2 4 10 3.2 8.6 3" fill="none" stroke="currentColor"/>',
    svg18: '<path data-region="wingUpper" d="M12 9.2C12.2 6 14.6 4 17.4 4.4C20 4.8 20.4 7.6 19 9.8C17.8 11.6 14.6 12 12 10.6Z" fill="currentColor" stroke="none"/><path data-region="wingUpper" d="M12 9.2C11.8 6 9.4 4 6.6 4.4C4 4.8 3.6 7.6 5 9.8C6.2 11.6 9.4 12 12 10.6Z" fill="currentColor" stroke="none"/><path data-region="wingLower" d="M12 11.2C13 12 15 12.4 16.6 13.4C18.4 14.6 18.4 16.8 16.6 18C14.8 19 12.6 18 12 15.6Z" fill="currentColor" stroke="none"/><path data-region="wingLower" d="M12 11.2C11 12 9 12.4 7.4 13.4C5.6 14.6 5.6 16.8 7.4 18C9.2 19 11.4 18 12 15.6Z" fill="currentColor" stroke="none"/><circle data-region="body" cx="12" cy="6.6" r="1.4" fill="currentColor" stroke="none"/><path data-region="body" d="M12 7.6C13 7.6 13.5 8.5 13.5 10L12.6 16.8C12.5 17.6 12.3 18 12 18.3C11.7 18 11.5 17.6 11.4 16.8L10.5 10C10.5 8.5 11 7.6 12 7.6Z" fill="currentColor" stroke="none"/><path data-region="antenna" d="M12 5.8C12.8 4.4 13.8 3.8 15 3.6" fill="none" stroke="currentColor"/><path data-region="antenna" d="M12 5.8C11.2 4.4 10.2 3.8 9 3.6" fill="none" stroke="currentColor"/>',
  },
  // ── V4-ICON-001 utility/action family (§9 action coverage; §2 utility-glyph signature). ──
  // The signature move, shared with nav.plus + nav.back and stated so it stays measurable: a
  // content-less utility glyph's dominant stroke spans 13 units (5.5..18.5) centred on 12, round
  // terminals, and any ENCLOSURE is action.info's circle (r 8.4 at 24 / 8.6 at 18) so every
  // enclosed utility glyph reads as one kit rather than as N borrowed stock icons.
  // These carry accessibleName inline (iconRegistry.js falls back to it after ANCHOR_META).
  'action.close': {
    class: 'mono', register: 'functional', variant: 'line', accessibleName: 'Close',
    // Bare X. DELIBERATELY NOT status.failed's X (6.2..17.8): tucked to 6.9..17.1 so the
    // interactive dismiss control sits optically lighter than the status mark it can neighbour.
    // The two stay distinguishable by weight, and status.failed is never interactive.
    svg24: '<path d="M6.9 6.9 17.1 17.1"/><path d="M17.1 6.9 6.9 17.1"/>',
    svg18: '<path d="M7.1 7.1 16.9 16.9"/><path d="M16.9 7.1 7.1 16.9"/>',
  },
  'action.remove': {
    class: 'mono', register: 'functional', variant: 'line', accessibleName: 'Remove',
    // X inside the action.info circle — the chip/tag clear affordance. The enclosure is what
    // separates it from action.close (bare X, dismisses a whole surface) and from status.failed.
    svg24: '<circle cx="12" cy="12" r="8.4"/><path d="M9.2 9.2 14.8 14.8"/><path d="M14.8 9.2 9.2 14.8"/>',
    svg18: '<circle cx="12" cy="12" r="8.6"/><path d="M9.4 9.4 14.6 14.6"/><path d="M14.6 9.4 9.4 14.6"/>',
  },
  'action.check': {
    class: 'mono', register: 'functional', variant: 'line', accessibleName: 'Confirm',
    // Compact tick (legs 5.9 / 11.5). status.harvested's 18px master is ALSO a bare check
    // (its 24 is circled) — this one is deliberately shorter and steeper so the two are told
    // apart by proportion. They are near-synonyms at 18px; both are always label-adjacent.
    svg24: '<path d="M6.2 12.6 10.4 16.8 17.8 8"/>',
    svg18: '<path d="M6.4 12.6 10.4 16.6 17.6 8.2"/>',
  },
  'action.filter': {
    class: 'mono', register: 'functional', variant: 'line', accessibleName: 'Filter',
    svg24: '<path d="M4.6 5.4h14.8l-5.7 7v5.2l-3.4 2v-7.2z"/>',
    svg18: '<path d="M4.4 5.6h15.2l-5.9 7.1v5l-3.4 2v-7.1z"/>',
  },
  'action.groupBy': {
    class: 'mono', register: 'functional', variant: 'line', accessibleName: 'Group by',
    // Two collapsible group headers, each with one indented member. The header carets are the
    // action.chevron form at half scale, so "grouping" and "disclosure" are one kit, not two.
    svg24: '<path d="M4.4 5.2 6.2 6.6 4.4 8"/><path d="M8 6.6h10.6"/><path d="M11 10.8h7.6"/><path d="M4.4 13.8 6.2 15.2 4.4 16.6"/><path d="M8 15.2h10.6"/><path d="M11 19.4h7.6"/>',
    // 18: the carets drop (2.8 units tall = ~2 device px, they close to noise — §4 aperture) AND
    // group B's member drops with them. Four bars at 2.0px stroke leave a 1.2px clear gap, which
    // read as one solid block (verified on the contact sheet): the mark degraded to a plain list.
    // Three bars restore the rhythm — 1.6px clear inside the group vs 3.3px between groups — so
    // the header/member indent still carries "grouped", which is the whole meaning.
    svg18: '<path d="M4.6 6.2h14"/><path d="M9.4 11h9.2"/><path d="M4.6 18h14"/>',
  },
  'action.search': {
    class: 'mono', register: 'functional', variant: 'line', accessibleName: 'Search',
    svg24: '<circle cx="10.8" cy="10.8" r="6.2"/><path d="M15.4 15.4 19.8 19.8"/>',
    svg18: '<circle cx="10.6" cy="10.6" r="6.4"/><path d="M15.4 15.4 19.6 19.6"/>',
  },
  'action.chevron': {
    class: 'mono', register: 'functional', variant: 'line', accessibleName: 'Show more',
    // Disclosure ">" — the mirror of nav.back, and mirrored ON PURPOSE: back and disclose are
    // one pair in this language and the DIRECTION is the meaning. An expander rotates it in CSS
    // (transform), which is why there is no separate down/up key.
    svg24: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
    svg18: '<path d="M9.5 6 15 12l-5.5 6"/>',
  },
}

export const ANCHOR_KEYS = Object.keys(A)
export default A
