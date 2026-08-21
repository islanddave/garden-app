// src/lib/seasonRetro.js — V4-SEASONRETRO-001, Track B / B13.
//
// A copy-out draft summarising the grow year: how much was picked, what the range of it was, when
// the peak was, what came in first, and what only ever showed up once. It is the "storification"
// counterpart to the per-batch composer in harvestPost.js — that one says what happened tonight,
// this one says what happened all year.
//
// WHY IT NEEDS NOTHING NEW. Every figure below comes from the aggregates block that
// GET /api/harvests?timeframe=season:YYYY&include=aggregates already returns, unpaginated over the
// full range (the ENTRIES side is keyset-paged at 50 and would have needed ~16 round trips for a
// 796-pick season; the aggregates side has no cursor and no limit by design). No new column, no new
// endpoint, no Meta dependency, and nothing to capture that Dave is not already logging.
//
// The non-obvious enabler: `serializeUnits` emits a per-unit `count`, which is an EVENT count, not a
// quantity. So picks-per-variety is `sum(units[].count) + unquantified` and the "showed up once"
// line is computable client-side. Without that field this file would have needed a Lambda change,
// a deploy and a promote to say anything about varieties.
//
// TWO THINGS THIS FILE REFUSES TO DO, both because it is a PUBLIC-OUTPUT surface:
//
//   1. It never claims the season is over. Measured on prod 2026-08-21: the season's last pick IS
//      today, because it is August and the garden is still producing. A retrospective that opened
//      "This season we grew..." would be writing an obituary for a garden mid-harvest. When the last
//      pick is recent the copy says "so far"; only a genuinely finished season gets past tense.
//   2. It never publishes a name carrying identification uncertainty. Same `isUncertainName`
//      predicate the composer uses, imported rather than copied — prod really does hold
//      "Onion — scallion-type (thick blue-green, ID pending)", and a year-end summary is the worst
//      possible place to assert an ID nobody has actually made.
//
// FIRSTS COME FROM `first_pick[]`, NEVER FROM THE `first_harvest` EVENT TYPE. This looks like a
// detail and is the difference between a feature and an empty list: prod carries 796 harvest events
// of which exactly FIVE are typed `first_harvest`, against 87+ plantings that were actually picked.
// The marker is something Dave sets by hand and mostly does not. `first_pick[]` is derived server-
// side as min(day_key) per planting, which is the honest answer to "when did this start". The
// harvests aggregate already made this choice (design §3b); this file inherits it rather than
// re-deriving it, and says so here because "use the event named first_harvest" is the obvious wrong
// move for the next person.

import { normalizeVarietyName, pluralizeCrop, isUncertainName } from './harvestPost.js'

// A season still counts as running if something was picked within this many days of "today". Chosen
// from Dave's own cadence rather than a round number: the longest gap between consecutive harvest
// days in the 2026 season to date is under a week, so 14 days is comfortably past "he just hasn't
// been out lately" and well short of declaring a running garden finished.
export const IN_PROGRESS_DAYS = 14

// Below this, "N varieties" is not a fact worth printing — it is a list, and the list is shorter.
export const MIN_VARIETIES_TO_COUNT = 3

// How many crops the headline breakdown names before it stops. Past this the tail is single-pick
// crops that the "showed up once" line already covers.
export const TOP_CROPS = 5

const DAY = 86400000

/** Event count for one aggregate node. `units[].count` is a row count; `unquantified` is the rest. */
function picksOf(node) {
  const fromUnits = (node?.units ?? []).reduce((n, u) => n + (Number(u.count) || 0), 0)
  return fromUnits + (Number(node?.unquantified) || 0)
}

function toDate(ymd) {
  if (!ymd) return null
  const t = Date.parse(`${ymd}T12:00:00`)   // noon: no DST edge can move the calendar day
  return Number.isFinite(t) ? t : null
}

/** "June 4" / "Aug 21" — month abbreviated past May, matching how Dave writes dates in his posts. */
export function formatDay(ymd) {
  const t = toDate(ymd)
  if (t == null) return ''
  const d = new Date(t)
  const long = ['January', 'February', 'March', 'April', 'May', 'June']
  const short = ['July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']
  const m = d.getMonth()
  return `${m < 6 ? long[m] : short[m - 6]} ${d.getDate()}`
}

/**
 * Reduce a harvests `aggregates` block into the facts a retrospective states.
 * Pure. Returns null when there is nothing to say rather than an empty shell — a caller rendering
 * "0 picks across 0 crops" is worse than a caller rendering nothing.
 *
 * @param {object} aggregates  the `aggregates` object from GET /api/harvests
 * @param {{today?: string}} [opts]  `today` as YYYY-MM-DD; defaults to the real current date
 */
export function summarizeSeason(aggregates, { today } = {}) {
  const weekly = aggregates?.weekly ?? []
  const cropsIn = aggregates?.crops ?? []
  const firstPick = aggregates?.first_pick ?? []
  const totalPicks = weekly.reduce((n, w) => n + (Number(w.count) || 0), 0)
  if (!totalPicks) return null

  const crops = cropsIn.map((c) => {
    const cw = c.weekly ?? []
    const varieties = (c.varieties ?? []).filter((v) => v.variety_id != null)
    return {
      slug: c.crop_type_slug,
      name: c.crop_name || c.crop_type_slug,
      picks: picksOf(c),
      // Distinct varieties, uncertain names INCLUDED: the count is a fact about the garden, and
      // only the NAMES are unsafe to print. Dropping them from the count would understate the
      // season to protect a string that is never rendered.
      varietyCount: varieties.length,
      firstWeek: cw.length ? cw[0].week_start : null,
      lastWeek: cw.length ? cw[cw.length - 1].week_start : null,
      varieties,
    }
  }).sort((a, b) => b.picks - a.picks || a.name.localeCompare(b.name))

  // Firsts, in the order they actually happened. Uncertain and nameless plantings are dropped HERE
  // rather than filtered upstream, so a season whose firsts are all unnamed yields an empty list and
  // the renderer simply omits the section — it never prints a first with a blank where a name goes.
  const firsts = firstPick
    .filter((f) => f.planting_name && !isUncertainName(f.planting_name))
    .map((f) => ({
      name: normalizeVarietyName(f.planting_name),
      slug: f.crop_type_slug ?? null,
      date: f.first_pick_date,
    }))
    .filter((f) => f.name)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))

  const oneOff = []
  for (const c of crops) {
    for (const v of c.varieties) {
      if (picksOf(v) !== 1) continue
      const name = normalizeVarietyName(v.variety_name)
      // Counted even when unprintable, for the same reason as varietyCount above; the renderer
      // decides how many it can name and reports the remainder as a number.
      oneOff.push({ name: isUncertainName(v.variety_name) ? '' : name, crop: c.name })
    }
  }

  const peak = weekly.reduce((best, w) => (best && best.count >= w.count ? best : w), null)
  const firstDay = firsts.length ? firsts[0].date : (weekly[0]?.week_start ?? null)
  const lastWeek = weekly.length ? weekly[weekly.length - 1].week_start : null

  // "In progress" is measured from the last WEEK bucket, not the last pick date, because the week is
  // the finest grain the aggregate exposes. That biases toward calling a season live — the right
  // direction for a mistake here, since the cost of a premature "this season we grew" is a public
  // post that reads as though the garden is done.
  const todayMs = toDate(today) ?? Date.now()
  const lastMs = toDate(lastWeek)
  const inProgress = lastMs == null ? true : (todayMs - lastMs) <= IN_PROGRESS_DAYS * DAY

  return {
    totalPicks,
    cropCount: crops.length,
    varietyCount: crops.reduce((n, c) => n + c.varietyCount, 0),
    crops,
    firsts,
    oneOff,
    peakWeek: peak ? { weekStart: peak.week_start, count: peak.count } : null,
    firstDay,
    lastWeek,
    inProgress,
  }
}

/**
 * Render the model as a copy-out draft. Plain text, no markdown — it is going into a Facebook or
 * Instagram composer via navigator.share, where markdown renders as literal asterisks.
 *
 * @param {object} model            from summarizeSeason
 * @param {{maxFirsts?: number, maxOneOff?: number, title?: string}} [opts]
 */
export function renderSeasonRetro(model, { maxFirsts = 8, maxOneOff = 6, title } = {}) {
  if (!model) return ''
  const L = []
  const tense = model.inProgress ? 'so far this season' : 'this season'

  L.push(title || (model.inProgress ? 'The garden so far' : 'The season in numbers'))
  L.push('')

  const span = model.firstDay ? ` since ${formatDay(model.firstDay)}` : ''
  L.push(`${model.totalPicks} harvests${span}, across ${model.cropCount} ${model.cropCount === 1 ? 'crop' : 'crops'}` +
    (model.varietyCount >= MIN_VARIETIES_TO_COUNT ? ` and ${model.varietyCount} varieties.` : '.'))

  const top = model.crops.slice(0, TOP_CROPS).filter((c) => c.picks > 0)
  if (top.length) {
    L.push('')
    for (const c of top) {
      const v = c.varietyCount >= MIN_VARIETIES_TO_COUNT ? ` across ${c.varietyCount} varieties` : ''
      L.push(`${pluralizeCrop(c.name, c.picks)}: ${c.picks}${v}`)
    }
  }

  if (model.peakWeek) {
    L.push('')
    L.push(`Busiest week: ${formatDay(model.peakWeek.weekStart)}, ${model.peakWeek.count} picks.`)
  }

  if (model.firsts.length) {
    L.push('')
    L.push(`First off the plant${model.firsts.length > maxFirsts ? ` (first ${maxFirsts} of ${model.firsts.length})` : ''}:`)
    for (const f of model.firsts.slice(0, maxFirsts)) L.push(`  ${formatDay(f.date)} — ${f.name}`)
  }

  const nameable = model.oneOff.filter((o) => o.name)
  if (model.oneOff.length) {
    L.push('')
    // The count is of ALL one-pick varieties; the names are only the ones safe to print. Stating
    // both keeps the number honest without publishing an ID nobody made.
    const shown = nameable.slice(0, maxOneOff).map((o) => o.name)
    const line = `${model.oneOff.length} ${model.oneOff.length === 1 ? 'variety' : 'varieties'} gave exactly one pick${tense === 'this season' ? '' : ' so far'}`
    L.push(shown.length ? `${line}: ${shown.join(', ')}${nameable.length > shown.length || nameable.length < model.oneOff.length ? ', and others' : '.'}` : `${line}.`)
  }

  return L.join('\n').trim()
}
