// stats-kit/registry — section id -> how Season stats draws it. The server's envelope is keyed by
// section id (plan D4); the page walks STATS_SECTION_ORDER and asks getRenderer(id) for each. An id
// with no entry here renders nothing — a section the server adds before this client knows it is
// skipped, never shown raw.
//
// Each entry: title, Body (React component taking { section }), table(section) -> the numbers under
// the card (one table or an array of them; StatCard's NumbersTable).
import {
  RibbonBody, SourcesBody, HeatClockBody, HeatLadderBody, TomatoKeepBody, LongestBody, SepSizeBody, SeedLotsBody,
} from './charts/SectionBodies.jsx'
import { KEEP_WORD } from './charts/TomatoKeepChart.jsx'
import { seedCountText } from '../../components/stats/SeedLotCard.jsx'
import {
  fmtInt, fmtLb, fmtPct, monthDay, kindWord, HEAT_BAND_LABEL, CARE_KINDS, CARE_LABEL, num, isNum, capitalize,
} from './format.js'

const blank = (x) => (x == null || x === '' ? '—' : x)

export const STATS_REGISTRY = {
  ribbon: {
    title: 'The season at a glance',
    Body: RibbonBody,
    table: (s) => [
      {
        caption: 'Days with each kind of care',
        columns: ['Care', 'Days'], numeric: [false, true],
        rows: CARE_KINDS.filter((k) => isNum(s?.meta?.care_day_totals?.[k])).map((k) => [CARE_LABEL[k], fmtInt(s.meta.care_day_totals[k])]),
      },
      {
        caption: 'Week by week',
        columns: ['Week of', 'Heat units', 'Nights under 55°F', 'Rain (in)', 'Tomato fruit', 'Pepper pods'],
        numeric: [false, true, true, true, true, true],
        rows: (s?.series?.weeks ?? []).map((w) => [monthDay(w.week_start), fmtInt(num(w.heat_units)), fmtInt(num(w.cool_nights)), fmtLb(num(w.rain_in), 2), fmtInt(num(w.tomato_fruit)), fmtInt(num(w.pepper_pods))]),
      },
    ],
  },
  sources: {
    title: 'Where your plants came from',
    Body: SourcesBody,
    table: (s) => ({
      columns: ['Source', 'Kind', 'lb', 'Plantings', 'Picked', 'Lost', 'Saved lots'],
      numeric: [false, false, true, true, true, true, true],
      rows: (s?.series?.cards ?? []).map((c) => [
        c.source_id == null ? 'No source recorded' : c.name, blank(kindWord(c.kind)), fmtLb(num(c.lb)),
        fmtInt(num(c.plantings)), blank(fmtInt(c.picked)), blank(fmtInt(c.lost)), fmtInt(num(c.saved_lots)),
      ]),
    }),
  },
  heat_clock: {
    title: 'Heat clock',
    Body: HeatClockBody,
    table: (s) => [
      {
        caption: 'First pick of each crop',
        columns: ['Crop', 'First pick', 'Heat units banked'], numeric: [false, false, true],
        rows: (s?.series?.by_crop ?? []).map((r) => [r.crop_name, monthDay(r.first_pick), fmtInt(r.heat_units)]),
      },
      {
        caption: 'Planting out to first pick',
        columns: ['Cultivar', 'Crop', 'Planted out', 'First pick', 'Days', 'Heat units'],
        numeric: [false, false, false, false, true, true],
        rows: (s?.series?.by_cultivar ?? []).map((r) => [r.cultivar, capitalize(r.crop_slug ?? ''), monthDay(r.transplanted_at), monthDay(r.first_pick), fmtInt(r.days), fmtInt(r.heat_units)]),
      },
    ],
  },
  heat_ladder: {
    title: 'Pepper heat ladder',
    Body: HeatLadderBody,
    table: (s) => [
      {
        caption: 'By heat band',
        columns: ['Band', 'Plantings', 'Plants', 'Pods', 'lb'], numeric: [false, true, true, true, true],
        rows: (s?.series?.bands ?? []).map((b) => [b.label ?? HEAT_BAND_LABEL[b.band], fmtInt(b.plantings), fmtInt(b.plants), fmtInt(b.pods), fmtLb(num(b.lb), 2)]),
      },
      {
        caption: 'Single-plant peppers',
        columns: ['Cultivar', 'Band', 'Pods', 'lb'], numeric: [false, false, true, true],
        rows: (s?.series?.best ?? []).map((r) => [r.cultivar, HEAT_BAND_LABEL[r.band] ?? r.band, fmtInt(num(r.pods)), fmtLb(num(r.lb), 2)]),
      },
    ],
  },
  tomato_keep: {
    title: 'Tomato keep list',
    Body: TomatoKeepBody,
    table: (s) => ({
      columns: ['Cultivar', 'lb', 'Fruit', 'g each', 'Bag', 'Weighed', '× typical', 'Call'],
      numeric: [false, true, true, true, false, true, true, false],
      rows: (s?.series?.rows ?? []).map((r) => [
        r.cultivar, fmtLb(r.lb, 2), fmtInt(r.fruit), fmtInt(r.g_per_fruit), blank(r.container_size), fmtPct(r.measured_share),
        isNum(r.x_median) ? `${r.x_median.toFixed(1)}×` : '—', KEEP_WORD[r.verdict] ?? blank(r.verdict),
      ]),
    }),
  },
  longest: {
    title: 'The longest-giving plants',
    Body: LongestBody,
    table: (s) => ({
      columns: ['Cultivar', 'Crop', 'Plants', 'First pick', 'Last pick', 'Days', 'Picking days', 'lb', 'lb a plant a week'],
      numeric: [false, false, true, false, false, true, true, true, true],
      rows: (s?.series?.rows ?? []).map((r) => [
        r.cultivar, r.crop_name, fmtInt(r.plants), monthDay(r.first_pick), `${monthDay(r.last_pick)}${r.still_picking ? ' (still picking)' : ''}`,
        fmtInt(r.window_days), fmtInt(Array.isArray(r.pick_days) ? r.pick_days.length : 0), fmtLb(r.lb), fmtLb(r.lb_per_plant_week, 2),
      ]),
    }),
  },
  sep_size: {
    title: 'September fruit size',
    Body: SepSizeBody,
    table: (s) => ({
      columns: ['Cultivar', 'Aug g', 'Sep g', 'Aug fruit', 'Sep fruit', 'Sep ÷ Aug'],
      numeric: [false, true, true, true, true, true],
      rows: (s?.series?.rows ?? []).map((r) => [r.cultivar, fmtInt(r.aug_g), fmtInt(r.sep_g), fmtInt(r.aug_n), fmtInt(r.sep_n), isNum(r.ratio) ? `${r.ratio.toFixed(2)}×` : '—']),
    }),
  },
  seed_lots: {
    title: 'Saved seed',
    Body: SeedLotsBody,
    table: (s) => ({
      columns: ['Cultivar', 'Seeds', 'Saved', 'From your planting', 'Source'],
      numeric: [false, true, false, false, false],
      rows: (s?.series?.rows ?? []).map((l) => [l.cultivar, blank(seedCountText(l)), monthDay(l.saved_on), blank(l.parent?.name), blank(l.source?.name)]),
    }),
  },
}

export const STATS_SECTION_ORDER = ['ribbon', 'sources', 'heat_clock', 'heat_ladder', 'tomato_keep', 'longest', 'sep_size', 'seed_lots']

export function getRenderer(id) {
  return Object.hasOwn(STATS_REGISTRY, id) ? STATS_REGISTRY[id] : null
}

// The ids the page will draw for an envelope, in page order: known ids first (registry order), then
// nothing else — unknown ids are dropped here.
export function drawableSectionIds(stats) {
  const sections = stats?.sections
  if (!sections || typeof sections !== 'object') return []
  return STATS_SECTION_ORDER.filter((id) => sections[id] && typeof sections[id] === 'object' && getRenderer(id))
}
