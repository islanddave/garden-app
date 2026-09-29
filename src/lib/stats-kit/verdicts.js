// stats-kit/verdicts — the sentence at the top of each Season stats card and its "Limits" line, written
// here from the section's meta + series. The server sends numbers and limit CODES only (plan D4).
//
// Plain words: no jargon, no status words ("failed", "dead", "harvested"); a planting that did not
// make it is "lost" (house rule: events never speak in status words). A limit code this file has no
// sentence for is left out rather than shown raw.
import {
  fmtInt, fmtLb, fmtPct, monthDay, dayNum, countOf, plural, listWords, num, isNum, HEAT_BAND_LABEL, CARE_LABEL,
} from './format.js'

const LIMIT_TEXT = {
  weather_from: (l) => `Weather records start ${monthDay(l.date)}, so heat before then isn't counted.`,
  care_counted_in_days: () => 'Care is counted in days: three waterings on one day count as one.',
  archived_included: () => 'Plantings you have since archived are included, so totals can run higher than the Harvests page.',
  no_source_lb: (l) => `${fmtLb(num(l.lb))} lb came from plantings with no source recorded, so the list isn't complete.`,
  excluded_approx_tp: () => 'Plantings with only a rough planting-out date are left out.',
  excluded_rescued_gift_swap: () => 'Rescued, gifted and swapped plants are left out, since their age when they arrived is unknown.',
  excluded_under_21d: () => 'Plantings picked within three weeks of going out are left out; they were likely fruiting already.',
  heat_is_catalogue_ceiling: () => "Heat is each variety's catalogue top rating, not a measured pod.",
  single_plant_only: () => 'Only plantings of a single plant are ranked, so one plant is compared with one plant.',
  measured_share_min: (l) => `Only plants with at least ${fmtPct(num(l.share))} of their picks weighed are included.`,
  so_far: () => 'So far: the season is still running, and an arrow marks a plant that is still being picked.',
  measured_counts_only: () => 'Only fruit that was both counted and weighed is used.',
  min_fruit_per_month: (l) => `A tomato needs at least ${fmtInt(num(l.n))} fruit in each month to be shown.`,
  chain_stops_at_nursery: () => 'The trail stops at the nursery: nothing records who grew the seed behind a nursery start.',
}

export function limitLines(section) {
  const limits = Array.isArray(section?.meta?.limits) ? section.meta.limits : []
  return limits.map((l) => (l && LIMIT_TEXT[l.code] ? LIMIT_TEXT[l.code](l) : null)).filter(Boolean)
}

export function limitsText(section) {
  return limitLines(section).join(' ')
}

const lbText = (n) => `${fmtLb(num(n))} lb`

function ribbon(s) {
  const pins = s?.meta?.pins ?? {}
  const care = s?.meta?.care_day_totals ?? {}
  const parts = []
  if (pins.hottest?.date && isNum(pins.hottest.tmax_f)) parts.push(`The hottest day was ${monthDay(pins.hottest.date)} at ${Math.round(pins.hottest.tmax_f)}°F`)
  if (pins.wettest?.date && isNum(pins.wettest.precip_in)) parts.push(`the wettest ${monthDay(pins.wettest.date)} with ${pins.wettest.precip_in.toFixed(2)} in of rain`)
  let out = parts.length ? `${parts.join(', and ')}.` : ''
  const busiest = Object.entries(care).filter(([, n]) => isNum(n)).sort((a, b) => b[1] - a[1])[0]
  if (busiest) out += ` ${CARE_LABEL[busiest[0]] ?? busiest[0]} was the most common care, on ${countOf(busiest[1], 'day')}.`
  const weeks = s?.series?.weeks ?? []
  if (weeks.length) {
    let hi = weeks[0]
    let top = weeks[0]
    for (const w of weeks) {
      if (num(w.heat_units) > num(hi.heat_units)) hi = w
      if (num(w.tomato_fruit) > num(top.tomato_fruit)) top = w
    }
    if (num(top.tomato_fruit) > 0 && top.week_start > hi.week_start) {
      const gap = Math.round((num(dayNum(top.week_start)) - num(dayNum(hi.week_start))) / 7)
      out += ` The hottest week started ${monthDay(hi.week_start)}; tomato picks peaked ${countOf(gap, 'week')} later, the week of ${monthDay(top.week_start)} (${fmtInt(top.tomato_fruit)} fruit).`
    }
  }
  return out.trim()
}

function sources(s) {
  const cards = s?.series?.cards ?? []
  const total = num(s?.meta?.total_lb)
  const named = cards.filter((c) => c?.source_id != null).sort((a, b) => num(b.lb) - num(a.lb))
  const none = cards.find((c) => c?.source_id == null)
  const out = []
  const top = named[0]
  if (top && num(top.lb) > 0) {
    const share = total > 0 ? ` (${fmtPct(num(top.lb) / total)} of ${lbText(total)})` : ''
    out.push(`${top.name} gave the most: ${lbText(top.lb)} from ${countOf(num(top.plantings), 'planting')}${share}.`)
    const second = named[1]
    if (second && num(second.lb) > 0) out.push(`Next was ${second.name} at ${lbText(second.lb)}.`)
  }
  if (none && num(none.lb) > 0) out.push(`${lbText(none.lb)} came from plantings with no source recorded.`)
  return out.join(' ')
}

function heatClock(s) {
  const med = s?.meta?.median_heat ?? {}
  const rows = s?.series?.by_cultivar ?? []
  const out = []
  const firstCrop = [...(s?.series?.by_crop ?? [])].filter((r) => r?.first_pick).sort((a, b) => (a.first_pick < b.first_pick ? -1 : 1))[0]
  if (firstCrop) out.push(`${firstCrop.crop_name} came in first, on ${monthDay(firstCrop.first_pick)}.`)
  const crops = ['tomato', 'pepper'].filter((k) => isNum(med[k]))
  if (crops.length) {
    const [a, b] = crops
    out.push(`From planting out to first pick, the typical ${a} took ${fmtInt(med[a])} heat units${b ? ` and the typical ${b} ${fmtInt(med[b])}` : ''}.`)
  }
  const tom = rows.filter((r) => r?.crop_slug === 'tomato' && isNum(r.heat_units)).sort((a, b) => a.heat_units - b.heat_units)
  if (tom.length >= 2) out.push(`Tomatoes ran from ${tom[0].cultivar} at ${fmtInt(tom[0].heat_units)} to ${tom[tom.length - 1].cultivar} at ${fmtInt(tom[tom.length - 1].heat_units)}.`)
  return out.join(' ')
}

function heatLadder(s) {
  const bands = (s?.series?.bands ?? []).filter((b) => isNum(b?.pods))
  const best = s?.series?.best ?? []
  const out = []
  const top = [...bands].sort((a, b) => b.pods - a.pods)[0]
  if (top && top.pods > 0) out.push(`${top.label ?? HEAT_BAND_LABEL[top.band]} peppers gave the most pods: ${fmtInt(top.pods)} from ${countOf(num(top.plantings), 'planting')}.`)
  const leaders = bands
    .map((b) => best.filter((r) => r?.band === b.band && num(r.pods) > 0).sort((x, y) => num(y.pods) - num(x.pods))[0])
    .filter(Boolean)
  if (leaders.length) {
    out.push(`Best in each band: ${leaders.map((r) => `${(HEAT_BAND_LABEL[r.band] ?? r.band).toLowerCase()}, ${r.cultivar} (${fmtInt(r.pods)})`).join('; ')}.`)
  }
  return out.join(' ')
}

function tomatoKeep(s) {
  const rows = (s?.series?.rows ?? []).filter((r) => isNum(r?.lb)).sort((a, b) => b.lb - a.lb)
  const med = s?.meta?.median_lb
  if (!rows.length) return ''
  const out = []
  if (isNum(med)) out.push(`The typical single tomato plant gave ${fmtLb(med, 2)} lb.`)
  const again = rows.filter((r) => r.verdict === 'grow_again')
  if (again.length) {
    const named = again.slice(0, 5).map((r) => `${r.cultivar} ${fmtLb(r.lb)}`)
    out.push(`${countOf(again.length, 'plant')} earned a grow-again: ${listWords(named)}.`)
  }
  const rethink = rows.filter((r) => r.verdict === 'rethink')
  if (rethink.length) {
    const late = rethink.filter((r) => Array.isArray(r.flags) && r.flags.includes('late_aug')).length
    out.push(`${countOf(rethink.length, 'plant')} ${plural(rethink.length, 'is', 'are')} worth a rethink${late ? `, ${fmtInt(late)} of ${plural(late, 'it', 'them')} set out late in August` : ''}.`)
  }
  return out.join(' ')
}

function longest(s) {
  const rows = s?.series?.rows ?? []
  if (!rows.length) return ''
  const out = []
  const top = [...rows].sort((a, b) => num(b.window_days) - num(a.window_days))[0]
  const picks = Array.isArray(top.pick_days) ? top.pick_days.length : 0
  out.push(`${top.cultivar} has been giving for ${countOf(num(top.window_days), 'day')}, with picks on ${fmtInt(picks)} of them.`)
  const rate = [...rows].filter((r) => isNum(r.lb_per_plant_week)).sort((a, b) => b.lb_per_plant_week - a.lb_per_plant_week)[0]
  if (rate) out.push(`${rate.cultivar} gave the most for its size: ${fmtLb(rate.lb_per_plant_week, 2)} lb a plant each week.`)
  const still = rows.filter((r) => r.still_picking).length
  if (still) out.push(`${fmtInt(still)} of ${fmtInt(rows.length)} ${plural(still, 'is', 'are')} still picking.`)
  return out.join(' ')
}

function sepSize(s) {
  const rows = (s?.series?.rows ?? []).filter((r) => isNum(r?.ratio))
  if (!rows.length) return ''
  const smaller = rows.filter((r) => r.ratio < 1)
  const held = rows.filter((r) => r.ratio >= 1)
  const ratio = s?.meta?.fruit_weighted_ratio
  const out = []
  let lead = `${fmtInt(smaller.length)} of ${fmtInt(rows.length)} tomatoes picked smaller fruit in September than in August`
  if (isNum(ratio) && ratio < 1) lead += `, about ${fmtPct(1 - ratio)} lighter overall`
  // The example is the biggest drop, not the busiest row: a cherry's "5 g → 5 g" says nothing.
  const ex = [...smaller].sort((a, b) => a.ratio - b.ratio)[0]
  if (ex) lead += ` (${ex.cultivar} ${fmtInt(ex.aug_g)} g → ${fmtInt(ex.sep_g)} g)`
  out.push(`${lead}.`)
  if (held.length) out.push(`${listWords(held.slice(0, 3).map((r) => r.cultivar))} held ${plural(held.length, 'its', 'their')} size.`)
  return out.join(' ')
}

function seedLots(s) {
  const rows = s?.series?.rows ?? []
  if (!rows.length) return ''
  const named = rows.filter((r) => r?.source?.name).length
  const fromGarden = rows.filter((r) => r?.parent).length
  const counts = {}
  for (const r of rows) if (r?.source?.name) counts[r.source.name] = (counts[r.source.name] ?? 0) + 1
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  const out = [`You saved ${countOf(rows.length, 'lot')}; ${fmtInt(named)} trace back to a named source and ${fmtInt(fromGarden)} came off your own plants.`]
  if (top && top[1] > 1) out.push(`${fmtInt(top[1])} go back to ${top[0]}.`)
  return out.join(' ')
}

const VERDICTS = {
  ribbon, sources, heat_clock: heatClock, heat_ladder: heatLadder, tomato_keep: tomatoKeep,
  longest, sep_size: sepSize, seed_lots: seedLots,
}

export function verdictFor(id, section) {
  const fn = VERDICTS[id]
  if (!fn || !section) return ''
  try {
    return fn(section) || ''
  } catch {
    return ''
  }
}
