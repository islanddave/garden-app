// V4-LOSSEVENT-001 follow-up — one-glyph-one-meaning guard for the V101 icon language.
// Nothing else in the suite can see this class of defect: the optical-weight golden compares ink
// COVERAGE per key, so two keys sharing a form bake identical numbers and pass forever, and the
// V101 registry harness lints each entry in isolation. This is the gate that would have caught
// event.given_away shipping as a byte-copy of the LIVE Share button (action.share) — one mark,
// two meanings, both rendered on the same PlantingDetail screen (HeroPhoto's share button at
// size 22 -> svg24, the event-history rows at size 18 -> svg18).
//
// Contract: no two registry keys may share an identical svg24 (or svg18) unless the PAIR appears
// below. Allowlisting is per unordered PAIR, never per collision group — so a NEW key joining an
// already-allowlisted group still fails, because it contributes pairs nobody has ruled on.
import { describe, it, expect } from 'vitest'
import { GLYPHS, isSvg } from '../lib/iconRegistry.js'

const pk = (a, b) => [a, b].sort().join(' | ')

// RULED — several keys, ONE meaning. A reader recovers from synonymy; this is the safe direction.
// Every entry cites the line that makes it deliberate. Do not add here without a citation.
const DELIBERATE_SYNONYMS = {
  // iconStatus.js:23-28 KEY_FORM — 17 status keys deliberately map onto 12 forms.
  [pk('status.seedling', 'status.sprouting')]: 'KEY_FORM: sprouting -> seedling form (iconStatus.js:24)',
  [pk('status.seedling', 'status.seeding')]:   'KEY_FORM: seeding -> seedling form (iconStatus.js:24)',
  [pk('status.sprouting', 'status.seeding')]:  'KEY_FORM: both -> seedling form (iconStatus.js:24)',
  [pk('status.vegetative', 'status.growing')]: 'KEY_FORM: growing -> vegetative form (iconStatus.js:25)',
  [pk('status.vegetative', 'status.active')]:  'KEY_FORM: active -> vegetative form (iconStatus.js:25)',
  [pk('status.growing', 'status.active')]:     'KEY_FORM: both -> vegetative form (iconStatus.js:25)',
  [pk('status.failed', 'status.dead')]:        'KEY_FORM: dead -> failed form (iconStatus.js:27)',

  // iconEvents.js REUSE block — an event type borrowing its foundation form by reference.
  [pk('status.seed', 'event.sowing')]:            'REUSE: sowing -> STATUS_GLYPHS.seed',
  [pk('status.seedling', 'event.transplant')]:    'REUSE: transplant -> STATUS_GLYPHS.seedling',
  [pk('status.sprouting', 'event.transplant')]:   'REUSE: transplant -> seedling form, which sprouting also aliases',
  [pk('status.seeding', 'event.transplant')]:     'REUSE: transplant -> seedling form, which seeding also aliases',
  [pk('status.rooting', 'event.rooting')]:        'REUSE: rooting -> STATUS_GLYPHS.rooting',
  [pk('status.flowering', 'event.flowering')]:    'REUSE: flowering -> STATUS_GLYPHS.flowering',
  [pk('status.fruiting', 'event.fruit_set')]:     'REUSE: fruit_set -> STATUS_GLYPHS.fruiting',
  [pk('status.harvesting', 'event.harvest')]:     'REUSE: harvest -> STATUS_GLYPHS.harvesting',
  [pk('care.drop', 'event.watering')]:            "REUSE: watering -> ANCHORS['care.drop']",
  [pk('nav.garden', 'event.potting_up')]:         "REUSE: potting_up -> ANCHORS['nav.garden']",
  // V4-LOSSEVENT-001: the X carries three keys for one idea ("these plants are gone"). Kept.
  // Caveat recorded rather than rediscovered: an unadorned X is the universal close/dismiss
  // affordance, so it survives ONLY because it is always label-adjacent and never interactive.
  // Never render it standalone/unlabeled, or on a tappable row that also has a dismiss control.
  [pk('status.failed', 'event.failed')]:          'REUSE: failed -> STATUS_GLYPHS.failed',
  [pk('status.dead', 'event.failed')]:            'REUSE: failed -> failed form, which dead also aliases',

  // Anchor-to-anchor, documented at the definition site.
  [pk('care.pause', 'media.pause')]: 'iconAnchors.js:163 — "media.pause = two rounded bars (reuses care.pause geometry; own key)"',
}

// NOT RULED — the holding pen for a collision the guard FINDS but nobody has decided yet. It is
// deliberately kept (empty is its correct steady state) so the next such collision has an obvious
// home and does not get quietly parked in DELIBERATE_SYNONYMS, where it would read as intentional.
//
// Rules for anything added here: give it a loud TODO(dave) naming the two keys and the evidence
// that the collision is accidental rather than designed, and do NOT promote an entry from here to
// DELIBERATE_SYNONYMS without a ruling plus a citation. Allowlisting here is a stay of execution,
// not an acquittal — assertion 4 below deletes the entry the moment the collision stops being real.
//
// Emptied 2026-08-21. It held exactly one finding: nav.today's svg24 was a byte-copy of the
// seedling form, so a NAV DESTINATION shared its mark with the seedling/sprouting/seeding stages
// and the transplant event (4 pairs). Dave ruled the redraw rather than the synonymy — nav.today
// is now a daily checklist (iconAnchors.js) — so all four pairs stopped colliding and came out.
// The six pairs AMONG status.seedling/sprouting/seeding + event.transplant are untouched and stay
// in DELIBERATE_SYNONYMS above: three lifecycle stages and the transplant event all being "a young
// plant" is genuine synonymy, and it was never the defect.
const UNRULED_COLLISIONS = {}

const ALLOWED = { ...DELIBERATE_SYNONYMS, ...UNRULED_COLLISIONS }
const MASTERS = ['svg24', 'svg18']
const svgEntries = Object.entries(GLYPHS).filter(([, e]) => isSvg(e))

function collisionPairs(master) {
  const byForm = new Map()
  for (const [k, e] of svgEntries) {
    if (!byForm.has(e[master])) byForm.set(e[master], [])
    byForm.get(e[master]).push(k)
  }
  const pairs = []
  for (const keys of byForm.values()) {
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) pairs.push(pk(keys[i], keys[j]))
  }
  return pairs
}

describe('icon language — one glyph, one meaning', () => {
  for (const master of MASTERS) {
    it(`no two registry keys share an identical ${master} outside the documented allowlist`, () => {
      const undocumented = [...new Set(collisionPairs(master))].filter((p) => !(p in ALLOWED))
      expect(undocumented, `undocumented ${master} collision(s) — two keys render the SAME mark. ` +
        'Redraw one, or add the PAIR to DELIBERATE_SYNONYMS with a citation if the synonymy is intended.')
        .toEqual([])
    })
  }

  it('event.given_away is distinct from action.share (V4-LOSSEVENT-001 regression)', () => {
    // The specific defect this guard was built for: action.share is the live Share button, so
    // reusing it for "Plants given away" put one mark on two meanings.
    for (const master of MASTERS) {
      expect(GLYPHS['event.given_away'][master], `event.given_away.${master} is a copy of action.share`)
        .not.toBe(GLYPHS['action.share'][master])
    }
  })

  it('every allowlisted pair still actually collides (no stale entries)', () => {
    const live = new Set(MASTERS.flatMap(collisionPairs))
    const stale = Object.keys(ALLOWED).filter((p) => !live.has(p))
    expect(stale, 'allowlisted pair(s) no longer share a form — delete them, or the allowlist ' +
      'grows into cover for a future collision nobody ruled on').toEqual([])
  })

  it('the allowlist is well-formed and the guard is non-vacuous', () => {
    // Vacuity floor, matching scripts/icon-ci/*.mjs: every assertion above loops over svgEntries,
    // so an empty subject list would be a clean pass covering nothing (a registry key or schema
    // rename does exactly that). 108 isSvg keys at 28a7f501; floor is slack for churn.
    expect(svgEntries.length).toBeGreaterThanOrEqual(90)
    const overlap = Object.keys(DELIBERATE_SYNONYMS).filter((p) => p in UNRULED_COLLISIONS)
    expect(overlap, 'a pair is in BOTH allowlists — promoting one to ruled means deleting the ' +
      'UNRULED entry, not copying it').toEqual([])
    for (const [pair, why] of Object.entries(ALLOWED)) {
      expect(pair, 'allowlist keys must be built with pk() so they are order-independent').toMatch(/^\S.* \| \S.*$/)
      expect(why.length, `${pair} needs a reason`).toBeGreaterThan(0)
    }
  })
})
