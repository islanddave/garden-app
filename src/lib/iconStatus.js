// src/lib/iconStatus.js — V4-ICON-001 (Pass B V101) plant-status glyph forms.
// 12 mono line forms (kit-matched to the anchor set), 24 + 18 masters. The 17 status
// keys map onto these 12 forms (e.g. sprouting/seeding reuse the seedling sprout).
// Status glyphs are MONO (stroke="currentColor") so PlantStatusBadge's getStatusColors
// ink (sc.text) flows in via currentColor — preserving the Pass A "hue never baked"
// 3-channel contract. (Lifecycle-facet color-candidate stages are a separate concern.)
const FORMS = {
  seed:       { svg24: '<path d="M15.8 4.6c3.6 2.1 5.2 7 3.4 11.4-1.8 4.4-6.5 6.6-10.6 5.2-3.6-1.2-5.4-5.4-3.9-9.6C6.2 7.2 11 2.3 15.8 4.6z"/><path d="M13.4 8.4c-1.7 1.1-2.6 3-2.4 5"/>', svg18: '<path d="M15.8 4.6c3.6 2.1 5.2 7 3.4 11.4-1.8 4.4-6.5 6.6-10.6 5.2-3.6-1.2-5.4-5.4-3.9-9.6C6.2 7.2 11 2.3 15.8 4.6z"/>' },
  rooting:    { svg24: '<path d="M12 6.2c2.7 0 4.7 2 4.7 4.6 0 2.3-1.5 4-3.4 4.5l-.1 .1h-2.4l-.1-.1C8.8 14.8 7.3 13.1 7.3 10.8 7.3 8.2 9.3 6.2 12 6.2z"/><path d="M12 6.2c0-1.4 1-2.5 2.4-2.8-.1 1.4-1 2.5-2.4 2.8z"/><path d="M10.2 15.3c-.5 1.7-.6 3.6-.3 5.4"/><path d="M12 15.4c.1 1.8-.1 3.7-.6 5.4"/><path d="M13.8 15.3c.5 1.7.7 3.6.5 5.4"/>', svg18: '<path d="M12 6.6c2.5 0 4.4 1.9 4.4 4.3 0 2.1-1.4 3.7-3.2 4.2l-.1 .1h-2.2l-.1-.1C9 14.6 7.6 13 7.6 10.9 7.6 8.5 9.5 6.6 12 6.6z"/><path d="M10.4 15.4c-.5 1.7-.6 3.5-.3 5.2"/><path d="M12.6 15.4c.4 1.7.6 3.5.4 5.2"/>' },
  seedling:   { svg24: '<path d="M4.5 20.5h15"/><path d="M12 20.5v-8.2"/><path d="M12 13.2C9.2 13.2 7 11 7 8.2c2.8 0 5 2.2 5 5z"/><path d="M12 11.4c0-2.4 1.9-4.3 4.3-4.3 0 2.4-1.9 4.3-4.3 4.3z"/>', svg18: '<path d="M12 20v-7"/><path d="M12 14C9.4 14 7.4 12 7.4 9.4c2.6 0 4.6 2 4.6 4.6z"/><path d="M12 12.4c0-2.2 1.8-4 4-4 0 2.2-1.8 4-4 4z"/>' },
  vegetative: { svg24: '<path d="M12 21V6.2"/><path d="M12 18.4c-2.4 0-4.3-1.9-4.3-4.3 2.4 0 4.3 1.9 4.3 4.3z"/><path d="M12 14.2c2.4 0 4.3-1.9 4.3-4.3-2.4 0-4.3 1.9-4.3 4.3z"/><path d="M12 10c-2.2 0-4-1.7-4-3.9 2.2 0 4 1.7 4 3.9z"/><path d="M12 6.2c2.1-1 3.4-3 3.6-5.2"/>', svg18: '<path d="M12 20.5V7"/><path d="M12 17c-2.5 0-4.5-2-4.5-4.5 2.5 0 4.5 2 4.5 4.5z"/><path d="M12 12.2c2.5 0 4.5-2 4.5-4.5-2.5 0-4.5 2-4.5 4.5z"/>' },
  flowering:  { svg24: '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M12 11C10.4 9.2 10.6 6.3 12 4.2 13.4 6.3 13.6 9.2 12 11z"/><path d="M12.9 11.6C15.1 10.7 18 11.6 19.4 13.5 17 14.2 14.2 13.6 12.9 11.6z"/><path d="M12.6 12.9C13.9 14.9 13.5 17.8 11.6 19.6 10.5 17.3 11 14.5 12.6 12.9z"/><path d="M11.1 12.6C9.5 14.3 6.6 14.6 4.4 13.5 6 11.6 8.8 11 11.1 12.6z"/><path d="M11.1 11.4C8.9 10.7 7.3 8.3 7 6 9.4 6.4 11.7 8 12.4 10.3"/>', svg18: '<circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><path d="M12 10.3C10.3 8.6 10.3 5.9 12 4.2 13.7 5.9 13.7 8.6 12 10.3z"/><path d="M13.7 12C15.4 10.3 18.1 10.3 19.8 12 18.1 13.7 15.4 13.7 13.7 12z"/><path d="M12 13.7C13.7 15.4 13.7 18.1 12 19.8 10.3 18.1 10.3 15.4 12 13.7z"/><path d="M10.3 12C8.6 13.7 5.9 13.7 4.2 12 5.9 10.3 8.6 10.3 10.3 12z"/>' },
  fruiting:   { svg24: '<path d="M12 21.4c-4.6 0-8.1-3.4-8.1-7.7 0-4 3-7 7-7.3 0.7-0.1 1.5-0.1 2.2 0 4 0.3 7 3.3 7 7.3 0 4.3-3.5 7.7-8.1 7.7z"/><path d="M12 6.4V3.8"/><path d="M12 6.2c-1.8 0-3.2-1.4-3.3-3.2 1.8 0 3.3 1.4 3.3 3.2z"/>', svg18: '<path d="M12 20.8c-4.4 0-7.6-3.3-7.6-7.4 0-4.1 3.2-7.4 7.6-7.4s7.6 3.3 7.6 7.4c0 4.1-3.2 7.4-7.6 7.4z"/><path d="M12 6V3.4"/><path d="M12 6c1.4-0.5 2.3-1.9 2.4-3.4"/>' },
  harvesting: { svg24: '<path d="M4.4 9.5h15.2l-1.6 9.1a1 1 0 0 1-1 0.8H7a1 1 0 0 1-1-0.8z"/><path d="M7.4 9.5C7.4 6.3 9.5 4 12 4s4.6 2.3 4.6 5.5"/><path d="M9 12.6l-0.5 4.2"/><path d="M12 12.6v4.2"/><path d="M15 12.6l0.5 4.2"/>', svg18: '<path d="M4.4 9.8h15.2l-1.6 8.4a1 1 0 0 1-1 0.8H7a1 1 0 0 1-1-0.8z"/><path d="M7.6 9.8C7.6 6.5 9.6 4 12 4s4.4 2.5 4.4 5.8"/>' },
  harvested:  { svg24: '<circle cx="12" cy="12" r="9"/><path d="M7.6 12.4l3 3 5.8-6.8"/>', svg18: '<path d="M4.5 12.5l4.5 4.5 10-11"/>' },
  dormant:    { svg24: '<path d="M19 15.4A8 8 0 1 1 11.2 4.4 6.4 6.4 0 0 0 19 15.4z"/>', svg18: '<path d="M19.2 15A8.2 8.2 0 1 1 10.6 4.2 6.8 6.8 0 0 0 19.2 15z"/>' },
  planning:   { svg24: '<path d="M6.5 5.5h11a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z"/><path d="M9.5 5.5V4.6a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v0.9z"/><path d="M8.6 11h6.8"/><path d="M8.6 14.4h6.8"/><path d="M8.6 17.8h4.2"/>', svg18: '<path d="M6 5.5h12a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z"/><path d="M9.4 5.5V4.6a1 1 0 0 1 1-1h3.2a1 1 0 0 1 1 1v0.9z"/><path d="M8.4 11.5h7.2"/><path d="M8.4 15.5h7.2"/>' },
  ended:      { svg24: '<path d="M6.5 4.5h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z"/>', svg18: '<path d="M6 4.5h12a1.8 1.8 0 0 1 1.8 1.8v11.4a1.8 1.8 0 0 1-1.8 1.8H6a1.8 1.8 0 0 1-1.8-1.8V6.3A1.8 1.8 0 0 1 6 4.5z"/>' },
  failed:     { svg24: '<path d="M6.2 6.2l11.6 11.6"/><path d="M17.8 6.2L6.2 17.8"/>', svg18: '<path d="M6.6 6.6l10.8 10.8"/><path d="M17.4 6.6L6.6 17.4"/>' },
  // ── V4-ICON-001: attention states. These are NOT lifecycle stages — they are what the app says
  // about a planting right now — but they live in status.* because that is the namespace every
  // badge already reads (`status.${x}`), and inventing a second one would split the vocabulary.
  //
  // unseen = the eye-off. Kin to event.observation's lens by design — "you looked at this" and
  // "you have not looked at this lately" are opposites and SHOULD share a root form. The pupil is
  // load-bearing, not decoration: lens + slash alone renders as Ø, the empty-set/diameter sign
  // (seen on the contact sheet), because a near-circular lens with a corner-to-corner slash IS
  // that character. The pupil breaks the read, so the lens is also flattened (w/h 1.73 vs 1.56).
  // The 18 master cannot keep the pupil — lens interior 8.1 device px, pupil-plus-stroke 6.7, a
  // 0.5px counter-space that blobbed on the sheet (§4 aperture) — so it kills the Ø the other
  // way, with a much flatter almond (w/h 2.3) that no longer resembles a circle at all.
  unseen:     { svg24: '<path d="M3.2 12C5.4 8.6 8.4 6.9 12 6.9s6.6 1.7 8.8 5.1c-2.2 3.4-5.2 5.1-8.8 5.1S5.4 15.4 3.2 12z"/><circle cx="12" cy="12" r="2.5"/><path d="M5.6 18.4 18.4 5.6"/>', svg18: '<path d="M3 12C5.4 9.4 8.4 8.1 12 8.1s6.6 1.3 9 3.9c-2.4 2.6-5.4 3.9-9 3.9S5.4 14.6 3 12z"/><path d="M5.2 18.8 18.8 5.2"/>' },
}

// 17 status keys -> 12 forms + a humanized name.
const KEY_FORM = {
  seed: 'seed', rooting: 'rooting', seedling: 'seedling', sprouting: 'seedling', seeding: 'seedling',
  vegetative: 'vegetative', growing: 'vegetative', active: 'vegetative', flowering: 'flowering',
  fruiting: 'fruiting', harvesting: 'harvesting', harvested: 'harvested', dormant: 'dormant',
  planning: 'planning', ended: 'ended', failed: 'failed', dead: 'failed',
  unseen: 'unseen',
}
const NAME = { seed:'Seed', rooting:'Rooting', seedling:'Seedling', sprouting:'Sprouting', seeding:'Seeding', vegetative:'Vegetative', growing:'Growing', active:'Active', flowering:'Flowering', fruiting:'Fruiting', harvesting:'Harvesting', harvested:'Harvested', dormant:'Dormant', planning:'Planning', ended:'Ended', failed:'Failed', dead:'Dead', unseen:'Not seen lately' }

export const STATUS_GLYPHS = Object.fromEntries(Object.entries(KEY_FORM).map(([key, form]) => [key, {
  key: `status.${key}`, glyph: null, svg24: FORMS[form].svg24, svg18: FORMS[form].svg18,
  class: 'mono', register: 'functional', variant: 'line', accessibleName: NAME[key], schemaVersion: 101,
}]))
