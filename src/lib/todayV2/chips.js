// src/lib/todayV2/chips.js — the redesigned Today's JUMP-BAR chips, as data (V5-TODAYREDESIGN-001 S3; plan-v2
// §2.4, §2.7, §4 "Jump bar"; §13 Simplify 5). PURE.
//
// A chip is NAVIGATION ONLY: it opens its section (a visit overlay, never remembered) and scrolls to it. Numbers
// sit only on the work chips (Protect, Water, Feed, Check — the S3 brief, which supersedes plan §2.7's
// "Heads-up n"); Heads-up, Harvest and Put-Up carry none (Reward UX: no count badge on a harvest or a jar).
// There is no in-view highlight (Simplify 5), so a chip has no state of its own.
//
// A chip EXISTS when its section is on the page and, for a counted chip, its count is above zero — at the visit's
// ready point, where the set is HELD for the visit: a held chip stays when its count falls to 0 and reads
// "Water · done". A chip that goes live later (a section inserted mid-visit) takes its slot in the fixed order.
// Water, Feed and Check all land on Needs care and carry the task filter S4's filter row applies.
//
// Icons: the colour `filled` variant on every chip that has one — the bar Dave approved on the S3b contact
// sheet (2026-09-29): event.brought_inside, care.drop, care.feed, event.observation, nav.harvests (and nav.putup,
// same family). action.flag has no colour variant and renders mono.
export const CHIP_ORDER = ['protect', 'headsup', 'water', 'feed', 'check', 'harvest', 'putup']

export const CHIPS = {
  protect: { section: 'protect', label: 'Protect', icon: 'event.brought_inside', counted: true },
  headsup: { section: 'headsup', label: 'Heads-up', icon: 'action.flag', counted: false },
  water: { section: 'care', task: 'water', label: 'Water', icon: 'care.drop', counted: true },
  feed: { section: 'care', task: 'feed', label: 'Feed', icon: 'care.feed', counted: true },
  check: { section: 'care', task: 'check', label: 'Check', icon: 'event.observation', counted: true },
  harvest: { section: 'harvest', label: 'Harvest', icon: 'nav.harvests', counted: false },
  putup: { section: 'putup', label: 'Put-Up', icon: 'nav.putup', counted: false },
}

// §2.4 — one predicate per task chip, over the page's ACTIVE care rows (buildCareNeeded minus skipped/logged).
const TASK_NEEDS = { water: ['water_due', 'no_history'], feed: ['fertilize'], check: ['pest', 'overwintering'] }

export function taskCounts(rows) {
  const out = { water: 0, feed: 0, check: 0 }
  for (const r of rows || []) {
    for (const [task, needs] of Object.entries(TASK_NEEDS)) if (needs.includes(r && r.need)) out[task]++
  }
  return out
}

// The chips live NOW: section present, and a counted chip above zero. `counts` carries every counted chip's
// number (protect comes from its slice, S5; absent reads 0).
export function liveChips(present, counts) {
  const on = new Set(present || [])
  return CHIP_ORDER.filter((c) => on.has(CHIPS[c].section) && (!CHIPS[c].counted || (counts?.[c] || 0) > 0))
}

// The chips SHOWN: the set held at the ready point plus any that went live since, in the fixed order.
export function shownChips(held, live) {
  const h = new Set(held || [])
  const l = new Set(live || [])
  return CHIP_ORDER.filter((c) => h.has(c) || l.has(c))
}

// The visible text of a chip, which is also its accessible name (WCAG 2.5.3: the name contains the label).
export function chipText(key, count) {
  const c = CHIPS[key]
  if (!c) return ''
  if (!c.counted) return c.label
  return count > 0 ? `${c.label} ${count}` : `${c.label} · done`
}
