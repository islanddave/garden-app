// V4-HARVSURFACE-001 Slice 1 — the "worth checking" WATCH LIST (Section 2 of the two-section Today
// harvest surface; design `harvest-two-section-design-V100-20260811.md` §3).
//
// THE VOICE RULE IS THE FEATURE. Every string this module and its component produce is in the CHECK
// form — "start checking X", "look for Y" — and never in the assertion form ("X is ready", "your
// window opened"). That is not politeness. Ripeness estimates here are 11.8% calibrated with a −22d
// median error, so an assertion is wrong most of the time; a wrong check-prompt costs one glance,
// a wrong readiness claim costs trust in the whole surface (§3.1, unanimous panel + Dave-approved).
// A row may therefore be wrong about TIMING and still be exactly right about WHAT TO LOOK AT — which
// is why its value does not depend on the calibration number at all.
//
// PURE, like harvestReadiness.js: no `new Date()` anywhere. `watching_since` arrives from the server
// as a reporting-zone date string and is formatted by string surgery, never through a Date object
// (`new Date('2026-08-04')` parses as midnight UTC and renders Aug 3 in America/New_York — L-107).

// §3.5: "Cap the visible group at 5 — a nine-row declarative group is an inventory again."
export const MAX_WATCH_ROWS = 5

// PANEL Q2 (harvest-panel-decisions-20260812.md): "Cap any one project at 2 of the 5 visible slots"
// — a DISPLAY device over slot allocation, NOT grouping. One 56-plant pepper project must not
// monopolize the band; its overflow stays reachable through the tail. Hard cap by design: when one
// project is all there is, two rows plus an honest tail count IS the device working — backfilling
// the slots would reintroduce the monoculture the cap exists to prevent.
export const WATCH_PROJECT_SLOT_CAP = 2

// Slot allocation for the collapsed band. Walks the RANKED list: a row takes a slot unless its
// project already holds WATCH_PROJECT_SLOT_CAP of them; everything else — capped-out rows and rows
// past the last slot — lands in `overflow` in rank order, where the tail renders it.
export function selectWatchDisplay(ranked, maxRows = MAX_WATCH_ROWS, perProjectCap = WATCH_PROJECT_SLOT_CAP) {
  const visible = []
  const overflow = []
  const byProject = new Map()
  for (const c of Array.isArray(ranked) ? ranked : []) {
    const key = c?.project_id ?? `plant:${c?.plant_id}` // a projectless row can never monopolize
    const held = byProject.get(key) ?? 0
    if (visible.length < maxRows && held < perProjectCap) {
      byProject.set(key, held + 1)
      visible.push(c)
    } else {
      overflow.push(c)
    }
  }
  return { visible, overflow }
}

const _MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "Aug 22" from a YYYY-MM-DD, by string surgery — never through a Date object (L-107: a date-only
// string parsed as UTC renders one day early for the whole US day). Used for suppressed_until.
export function monthDayLabel(iso) {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return ''
  const mi = Number(m[2]) - 1
  if (mi < 0 || mi > 11) return ''
  return `${_MONTHS[mi]} ${Number(m[3])}`
}

// PANEL Q4 tail mechanics, shared by BOTH bands: above this many hidden rows the tail reveals in
// steps rather than all at once — a 40-row single-tap expansion is browsing, which is the complaint
// one level down. At or below it, one tap shows everything.
export const TAIL_REVEAL_STEP = 20
export const TAIL_REVEAL_ALL_AT_OR_BELOW = 25
export function revealStep(hidden) {
  const n = Number(hidden)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > TAIL_REVEAL_ALL_AT_OR_BELOW ? TAIL_REVEAL_STEP : n
}

// PANEL Q4: expanded tail order — overflow rows grouped by location, then project subgroups, then
// the Snoozed subgroup (rendered by the band from the payload's `snoozed` list). Locations appear
// in rank order of their first row; within a location, rows sharing a project cluster into ONE
// subgroup at the position of that project's first row when the project has 2+ rows there.
// Label fallback 'Other' matches careNeeded.js's location grouping.
export function groupWatchOverflow(rows) {
  const groups = []
  const groupByLoc = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.plant_id == null) continue
    const loc = row.location_name || 'Other'
    if (!groupByLoc.has(loc)) {
      const g = { key: loc, label: loc, entries: [], _projects: new Map() }
      groupByLoc.set(loc, g)
      groups.push(g)
    }
    const g = groupByLoc.get(loc)
    const pid = row.project_id
    if (pid != null && g._projects.has(pid)) {
      g._projects.get(pid).rows.push(row)
    } else if (pid != null) {
      const sub = { type: 'project', key: pid, rows: [row] }
      g._projects.set(pid, sub)
      g.entries.push(sub)
    } else {
      g.entries.push({ type: 'row', row })
    }
  }
  // Flatten: a single-row "project subgroup" is just a row; a real subgroup gets a crop-named label.
  for (const g of groups) {
    g.entries = g.entries.map(e => {
      if (e.type !== 'project' || e.rows.length < 2) {
        return { type: 'row', row: e.type === 'project' ? e.rows[0] : e.row }
      }
      const crops = [...new Set(e.rows.map(r => r.crop_display_name).filter(Boolean))]
      return { type: 'project', key: e.key, label: crops.join(' / ') || 'Same planting group', rows: e.rows }
    })
    delete g._projects
  }
  return groups
}

// §3.5: "Show 'checking since Aug 4' rather than a freshness badge." A freshness badge implies a
// transition just happened; a since-date states a STANDING watch, which is the honest grammar for a
// calendar-inferred row. No year — the queue drains at frost, so every row is this season.
export function watchingSinceLabel(iso) {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return ''
  const mi = Number(m[2]) - 1
  if (mi < 0 || mi > 11) return ''
  return `Checking since ${_MONTHS[mi]} ${Number(m[3])}`
}

// Newest first (§3.5). ISO date strings sort lexicographically, so no Date object is needed for the
// comparison either. Ties break on name so ordering is deterministic across renders.
//
// A row with no `plant_id` is dropped rather than rendered keyless: the dismissal writes against
// plant_id, so an id-less row would present a control that cannot do anything.
export function rankWatchCandidates(candidates) {
  if (!Array.isArray(candidates)) return []
  return candidates
    .filter(c => c && c.plant_id != null)
    .slice()
    .sort((a, b) =>
      String(b.watching_since ?? '').localeCompare(String(a.watching_since ?? '')) ||
      String(a.name ?? '').localeCompare(String(b.name ?? '')))
}

// THE OBSERVABLE (§3.2 — "the unlock"). The row must name the specific thing Dave's eyes and fingers
// check, because naming a perceptual target reduces an open-ended "is this ready?" into a yes/no
// perceptual judgment — and the open-ended question is exactly what produces walk-out-and-freeze.
//
// We take the FIRST window point's `at` — the name of the state at which the window OPENS, which is
// precisely what "start checking" targets. Deliberately NOT `look` (median ~200 chars) or
// `ripe_vs_unripe` (median 543): a five-row declarative group carrying five essays is the 28-row
// inventory Dave rejected, wearing different clothes. The full window already renders on the planting
// card (CropCard's HarvestWindow) one navigation away; this surface is the DIFF, not the reference.
//
// PROVENANCE IS LABELLED, NEVER IMPLIED (colour-window canon §4/§9: "a labelled derivation is not a
// confident claim"). Two cases get a short qualifier instead of the record's full 374-char caveat,
// which would not survive on a compact row:
//   - crop-level fallback  → the mechanic for the crop, not this cultivar's colour sequence
//   - confidence 'low'     → cultivar record derived from its market class
// Same grain rule as CropCard: the cultivar record wins when present, the crop mechanic fills in.
export function observableFrom(resolved) {
  const rec = resolved?.cultivar ?? resolved?.crop ?? null
  if (!rec) return null
  const pts = Array.isArray(rec.window) ? rec.window : []
  const at = typeof pts[0]?.at === 'string' ? pts[0].at.trim() : ''
  if (!at) return null
  const fromCrop = !resolved.cultivar
  const qualifier = fromCrop
    ? 'general guidance for this crop, not this variety'
    : (rec.confidence === 'low' ? 'derived from the variety type' : null)
  return { at, qualifier }
}
