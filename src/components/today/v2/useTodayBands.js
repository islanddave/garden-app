import { useHarvestWatchFeed, watchSelection } from '../../HarvestWatchBand.jsx'
import { useComposeHarvestFeed, composeBatchState } from '../../ComposeHarvestBand.jsx'
import { usePutUpUseSoonFeed, putUpSoonSlice, putUpSoonTitle } from '../../PutUpUseSoonBand.jsx'
import { useCultivationFeed } from '../CultivationLead.jsx'
import { COULD_NOT_CHECK } from '../../AmbientBandNotice.jsx'
import { toLines } from '../../../lib/harvestPost.js'

// useTodayBands — the redesigned Today's PLAN-INDEPENDENT sections, fetched at the page (V5-TODAYREDESIGN-001 S6;
// plan-v2 §1.0 rows 4, 5 and 8, §1.4, §4 "Harvest / Put-Up bodies", §8 S6).
//
// Harvest (the compose band + the watch band), From your Put-Up (the use-soon band) and the Sow link row each come
// from their band's OWN data hook, called here — not inside the bands — because a section's presence and header
// summary are read while its body is unmounted (closed means unmounted, §5.2). The page hands each band the result
// as `data` and renders it `bare`, so a band's rows are exactly what V1 shows, from exactly one request.
//
// Presence follows each band's own "do I render?" (a section with nothing in it renders nothing, R15):
//   Harvest  — a composable batch of the viewer's (composeBatchState, the compose band's three gates), or a
//              watch list with rows or snoozed rows, or a watch fetch that FAILED (the band's "Couldn't check
//              just now" notice: "could not ask" is not "nothing is coming", BUG-READYBANDFETCH-001).
//   Put-Up   — jars in the use-soon slice, or a failed fetch (same notice).
// Header summaries NAME what the band lists — never a count (Reward UX; plan §10 item 4; finish plan D-6, which
// dropped "20 picks · logged an hour ago"): "Ready to post · Worth checking: Radicchio, Beets, Red Acre Cabbage +2"
// (the compose band's batch, named by crop — "Ready to post: Tomato, Okra" — when the watch band lists nothing;
// then the watch band's own selection); "Summer Squash (past date) ·
// Plum · Basil ×2" (the use-soon slice, a repeated jar named once, D-7). A failed band reads COULD_NOT_CHECK there
// (the AmbientBandNotice voice).
//
// `settled`: every band has answered once (ok or failed) — the page's ready point waits on it, capped by the same
// 300 ms window as the prefs wait (TodayV2), so a remembered-open Harvest is open at the visit's start and nothing
// below Needs care moves when the bands land. `sowLines` false (the 2027 sowing freeze) asks for no sow lines.
export function useTodayBands({ viewerId, sowLines }) {
  const watch = useHarvestWatchFeed()
  const compose = useComposeHarvestFeed()
  const soon = usePutUpUseSoonFeed()
  const sow = useCultivationFeed({ enabled: !!sowLines })

  const settled = (watch.data != null || watch.failed) && compose.settled && (soon.data != null || soon.failed) && sow.settled

  const sel = watchSelection(watch.data)
  const watchFailed = !!watch.failed && !watch.data
  const post = composeBatchState(compose.data, viewerId)
  const harvest = {
    present: !!post || watchFailed || sel.all.length > 0 || sel.snoozed.length > 0,
    summary: harvestSummary(post, sel, watchFailed),
  }
  const soonFailed = !!soon.failed && !soon.data
  const putup = {
    present: soonFailed || (Array.isArray(soon.data) && soon.data.length > 0),
    summary: soonFailed ? COULD_NOT_CHECK : putUpSummary(soon.data),
  }
  return { settled, watch, compose, soon, sow, harvest, putup }
}

const watchName = (r) => r.name || r.crop_display_name || 'Planting' // the watch band's own row name
// The first three names, then "+N" for the rest (as Resting's summary reads).
function firstNames(names, shown = 3) {
  const head = names.slice(0, shown).join(', ')
  return names.length > shown ? `${head} +${names.length - shown}` : head
}

// The compose band's batch, by crop: its postable lines' crops, each once, in the batch's order.
function postCrops(post) {
  const seen = new Set()
  for (const l of toLines(post?.batch?.items)) if (l.postable && l.crop) seen.add(l.crop)
  return [...seen]
}

export function harvestSummary(post, sel, watchFailed) {
  const parts = []
  // The batch's crops only when the watch band has nothing to name — both lists on one band ran to three lines.
  const watchNames = !watchFailed && sel.all.length > 0
  if (post) {
    const crops = postCrops(post)
    parts.push(crops.length && !watchNames ? 'Ready to post: ' + firstNames(crops) : 'Ready to post')
  }
  if (watchFailed) parts.push(COULD_NOT_CHECK)
  else if (sel.all.length) {
    // The band's own display order first (its visible rows), then the rest it holds.
    const vis = sel.visible || []
    parts.push('Worth checking: ' + firstNames([...vis, ...sel.all.filter((r) => !vis.includes(r))].map(watchName)))
  }
  else if (sel.snoozed.length) parts.push('Snoozed: ' + firstNames(sel.snoozed.map(watchName)))
  return parts.join(' · ') || null
}

export function putUpSummary(items) {
  const { shown, more } = putUpSoonSlice(items)
  if (!shown.length) return null
  // A jar named twice reads once with "×2", in its first place.
  const named = []
  for (const it of shown) {
    const t = putUpSoonTitle(it) + (it.use_by_status === 'past_use_by' ? ' (past date)' : '')
    const hit = named.find((x) => x.t === t)
    if (hit) hit.n++
    else named.push({ t, n: 1 })
  }
  const names = named.map((x) => (x.n > 1 ? `${x.t} ×${x.n}` : x.t)).join(' · ')
  return more > 0 ? `${names} +${more}` : names
}
