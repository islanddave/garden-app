// src/lib/cropLogLedger.js
// V4-CROPLISTORDER-001 (BD-010) — client-side rolling ledger of crop log activity, the ranking
// source for PlantingSelect's crop-chip band order. The client has NO last-event data on the
// picker surface (list /api/plants carries no event timestamps; EventNew fetches no events), so
// ranking is fed from where the client already remembers what was just logged: the same save
// moments that write logone.lastPlant / lastHarvestUnit:<slug>. Zero server change.
//
// STATISTIC — distinct-log-days per crop, read over a trailing window (default 60d). The WRITE
// SHAPE makes distinct-log-days the ONLY representable statistic: one day-key per (slug, day),
// idempotent, so batch skew is unreintroducible by construction — 30 events logged on 2 days can
// never outrank 5 events spread over 5 days. Raw event counts were disqualified in the consult:
// the batch path emits one row per planting per batch, which measures planting count, not
// attention.
//
// LogMany is DELIBERATELY EXCLUDED from ledger writes, for two independent reasons:
//   1. Mechanical — LogMany's batch scope carries no crop_type_slug; there is nothing to record.
//   2. Semantic — batches are the watering runs: a 40-planting watering pass would mark every
//      crop in the garden "recently logged" and flatten the ranking into noise. The ledger ranks
//      what Dave deliberately singles out, which is exactly what the picker needs surfaced.
//
// Storage: localStorage 'croprank.v1' —
//   { v: 1, days: { [crop_type_slug]: ['YYYY-MM-DD', ...] /* newest first, ≤ MAX_DAYS_PER_SLUG */ } }
// Retention: ≤20 day-keys per slug, and anything older than PRUNE_DAYS is dropped on every write,
// so worst case (~80 slugs × 20 keys) stays ~17KB. try/catch everywhere (house convention —
// EventNew's readLastHarvestUnit): a throwing/absent localStorage degrades silently to cold-start
// ranking (pins + alphabetical), never to an error on the save path. A corrupt or wrong-version
// store is discarded wholesale rather than half-trusted.
//
// Phase 2 (explicitly NOT v1): entity_memory.last_event_at LEFT JOINed into the plants list
// SELECTs — read the BUG-HEROLISTPERF-001 rationale (lambda/plants/index.js:884-905) first if
// that is ever attempted.
import { etDay, addDays } from './harvestSummary.js'

const KEY = 'croprank.v1'
const MAX_DAYS_PER_SLUG = 20
const PRUNE_DAYS = 90
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function readStore() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.v !== 1 || typeof parsed.days !== 'object' ||
        parsed.days === null || Array.isArray(parsed.days)) return null
    return parsed
  } catch { return null } // unavailable OR corrupt — both read as "no ledger yet"
}

function writeStore(store) {
  try { localStorage.setItem(KEY, JSON.stringify(store)) }
  catch { /* quota/unavailable — ranking degrades to cold-start, the save path never fails */ }
}

// Record one distinct-day mark per DISTINCT slug. `dayKey` is normalized through etDay
// (America/New_York — harvestSummary.js) so callers may pass a bare 'YYYY-MM-DD', a
// datetime-local string, or a Date; anything unresolvable is a silent no-op. `now` is injectable
// for deterministic tests (the harvestSummary discipline) and drives the >PRUNE_DAYS sweep that
// runs across the WHOLE store on every write.
export function recordCropLogs(slugs, dayKey, now = new Date()) {
  const day = etDay(dayKey)
  if (!day || !DAY_RE.test(day)) return
  const distinct = [...new Set((Array.isArray(slugs) ? slugs : []).filter(s => typeof s === 'string' && s))]
  if (distinct.length === 0) return
  const store = readStore() ?? { v: 1, days: {} }
  const today = etDay(now)
  const pruneCutoff = today ? addDays(today, -PRUNE_DAYS) : null
  for (const slug of distinct) {
    const prior = Array.isArray(store.days[slug]) ? store.days[slug] : []
    const valid = prior.filter(d => typeof d === 'string' && DAY_RE.test(d))
    if (!valid.includes(day)) valid.push(day) // idempotent per (slug, day)
    store.days[slug] = valid
  }
  // Prune pass — every slug, not just the written ones, so the store cannot grow unboundedly
  // from crops that stop being logged. Newest-first order is (re)normalized here.
  for (const slug of Object.keys(store.days)) {
    const kept = store.days[slug]
      .filter(d => (pruneCutoff ? d >= pruneCutoff : true))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)) // newest first
      .slice(0, MAX_DAYS_PER_SLUG)
    if (kept.length === 0) delete store.days[slug]
    else store.days[slug] = kept
  }
  writeStore(store)
}

// Single-slug convenience — the shape the three save sites use.
export function recordCropLog(slug, dayKey, now = new Date()) {
  recordCropLogs([slug], dayKey, now)
}

// Map<slug, { days: number, last: 'YYYY-MM-DD' }> over the trailing window. `days` counts
// DISTINCT log days; `last` is the most recent in-window day (the rank tie-break). Window
// semantics: the `windowDays` calendar days ending today (ET) — a day exactly windowDays+1 ago
// is out. Empty Map on any failure: cold start and broken storage are the same, deliberately.
export function readCropRank({ windowDays = 60, now = new Date() } = {}) {
  const out = new Map()
  const store = readStore()
  if (!store) return out
  const today = etDay(now)
  if (!today) return out
  const cutoff = addDays(today, -windowDays) // in-window: day > cutoff (today + 59 prior = 60)
  for (const [slug, arr] of Object.entries(store.days)) {
    if (!Array.isArray(arr)) continue
    const days = arr.filter(d => typeof d === 'string' && DAY_RE.test(d) && d > cutoff)
    if (days.length === 0) continue
    const last = days.reduce((a, b) => (a > b ? a : b))
    out.set(slug, { days: days.length, last })
  }
  return out
}
