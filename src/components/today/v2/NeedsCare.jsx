import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { P } from '../../../lib/constants.js'
import { T } from '../../forms/formStyles.js'
import FilterChipRow from '../../forms/FilterChipRow.jsx'
import Icon from '../../Icon.jsx'
import { skipMany, unskipMany } from '../careStore.js'
import { FeedSuppressedList } from '../CareNeeded.jsx'
import { buildModel, productGroups, filterResult, filterAnnouncement, TASKS, TASK_LABEL, TASK_ETYPE, OUTSIDE } from '../../../lib/todayV2/spots.js'
import { MOISTURE_CHECK_EVENT } from '../../../lib/careNeeded.js'
import SpotRow, { SpotDoneLine, tinted } from './SpotRow.jsx'
import SpotBody from './SpotBody.jsx'
import PlantCareRow, { outlineBtn } from './PlantCareRow.jsx'
import { addLogged, removeLogged, filtersKey, readFilters, writeFilters } from './needsCareStore.js'

// NeedsCare — the body of the redesigned Today's Needs care section (V5-TODAYREDESIGN-001 S4). Dave's
// D3 (a spot is logged whole, then its exceptions), D6 (spot Not today), D7 (Outside, Stable and House are
// separate groups, each with its own Water all; rain and bed-wait apply to Outside only), D9 (spot chips as a
// filter row), D10 (a logged spot shrinks to a done line with Undo, held for the visit; the group version is
// ONE line, one Undo), D11 (Skip / Moist on the few, then "Water the other N"; per-plant one-tap Water kept),
// D12 (under the Feed filter, one row per product across the garden with "Feed all"), and the boss pass:
// MF3 (the group Water all's result), SF2, SF7, SF8, SF12, Simplify 1.
//
// State: the care rows and write paths are the page's (useNeedsCare → useCareActions, V2 options); what this
// body adds is the VISIT's — which spots and cohorts are open, the done lines, the failed rows, the runs'
// created ids for Undo — kept in the visit record (useTodayVisit, record.care) so a Back from a planting
// restores it exactly. Filters are per session (needsCareStore). Nothing here raises a toast (§11.1 C2):
// results speak through the page's one status region (§5.6) and sit on the done lines.
const RUN = { concurrency: 4, excludeInFlight: true }
const KIND_OF = { watering: 'watered', fertilizing: 'fed', observation: 'checked', moisture_check: 'moist' }

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
// §5.6 "Redbor Kale, Beets and 1 more": two names, then the rest counted.
const nameList = (names) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`)
const css = (s) => String(s).replace(/"/g, '\\"')

export default function NeedsCare({ care, record, update, announce, planDate, userId, filterIntent }) {
  const c = record?.care || null
  const { actions } = care
  const setCare = useCallback((fn) => update((r) => ({ ...r, care: fn(r.care || {}) })), [update])

  // ── filters (§2.6): one axis per row, OR within a row, empty = all; per session; never re-sort ─────────────
  const fKey = filtersKey(userId)
  const [filters, setFilters] = useState(() => readFilters(fKey, planDate))
  const setAndSave = useCallback((next) => { setFilters(next); writeFilters(fKey, planDate, next) }, [fKey, planDate])
  // §2.6 / §5.6 (S4g): a filter change — a chip, a Clear, a jump chip's pre-select — says its result ONCE through the
  // page's one status region ("Needs care: Water, 168 in 8 spots."), from the change itself, never from a render.
  const changeFilters = useCallback((next) => {
    setAndSave(next)
    announce(filterAnnouncement(filterResult(care.rows, next)))
  }, [setAndSave, announce, care.rows])
  // S3's jump bar writes the chip's task into the visit record (record.filter.care = { tasks: [task], n }, n
  // counting the visit's chip taps); each NEW n REPLACES the task row once. The last n applied is kept on the
  // visit record (care.intentN), not in a ref: a chip tap on a CLOSED Needs care mounts this body with the
  // intent already written, and must still apply; a Back return or a close and re-open remounts it with an
  // intent already applied, and must not undo a filter chosen by hand since.
  const intentN = Number(filterIntent?.n) || 0
  const appliedN = Number(c?.intentN) || 0
  useEffect(() => {
    if (!intentN || intentN === appliedN) return
    setCare((cc) => ({ ...cc, intentN }))
    const t = Array.isArray(filterIntent?.tasks) ? filterIntent.tasks[0] : filterIntent?.task
    if (TASKS.includes(t)) changeFilters({ ...filters, tasks: [t] })
  }, [intentN, appliedN, filterIntent, filters, changeFilters, setCare])

  const presentTasks = TASKS.filter((t) => care.rows.some((r) => r.task === t))
  const tasks = filters.tasks.filter((t) => presentTasks.includes(t))
  const spotsPresent = useMemo(() => {
    const m = new Map()
    for (const r of care.rows) if (!tasks.length || tasks.includes(r.task)) { if (!m.has(r.spotKey)) m.set(r.spotKey, { value: r.spotKey, label: r.spotName }) }
    return [...m.values()]
  }, [care.rows, tasks])
  const spotSel = filters.spots.filter((k) => spotsPresent.some((s) => s.value === k))

  // The visit's held group + spot order (taken at the ready point): every render — the model and the done
  // lines alike — follows it, so a log never re-ranks the spots under Dave's thumb (BD-036).
  const heldOrder = c?.order
  // A failed row is retried only by a Retry (MF3), never folded into a fresh Water all: out of every bulk count.
  const failedMap = c?.failed
  const failedKeys = useMemo(() => new Set(Object.keys(failedMap || {})), [failedMap])
  const model = useMemo(() => buildModel(care.rows, { held: heldOrder, tasks, spots: spotSel, bedWait: care.bedWait, exclude: failedKeys }), [care.rows, heldOrder, tasks, spotSel, care.bedWait, failedKeys])
  const feedOnly = tasks.length === 1 && tasks[0] === 'feed'

  // ── run bookkeeping ─────────────────────────────────────────────────────────────────────────────────────
  const [busy, setBusy] = useState(null)       // { scope: 'spot'|'group'|'product', key, done, total }
  const [undoing, setUndoing] = useState(null) // batch id or row key
  const [focusId, setFocusId] = useState(null)
  const rootRef = useRef(null)
  // A focus target by data-focus-id, or (§5.5) "first-retry:<group>" — the first spot Retry in that group after
  // a run with failures — or "row-retry:<rowKey>" — the Retry a failed one-tap write leaves on its row in place
  // of the control that had focus (a removed focused node must never drop focus to BODY).
  useEffect(() => {
    if (!focusId || !rootRef.current) return
    const [kind, ...rest] = focusId.split(':')
    const arg = css(rest.join(':'))
    const el = kind === 'first-retry' ? rootRef.current.querySelector(`[data-testid="care-group"][data-group="${arg}"] [data-focus-id^="retry:"]`)
      : kind === 'row-retry' ? rootRef.current.querySelector(`[data-key="${arg}"] button[aria-label^="Retry"]`)
        : rootRef.current.querySelector(`[data-focus-id="${css(focusId)}"]`)
    if (el) el.focus({ preventScroll: true })
    setFocusId(null)
  }, [focusId, record])

  const batches = c?.batches || {}
  const rowsDone = c?.rowsDone || {}
  // A write that failed stays on the list as "Not logged" with a Retry (§6.6; MF3 "per spot"). Each failed key
  // records WHAT failed — { bid, etype, body }: the run it belonged to (none for a one-tap row) and the types it
  // posted — so a Retry re-runs exactly that. Truthy either way, so every `failed[k]` reader is unchanged.
  const failed = c?.failed || {}
  const spotBatches = (key) => Object.entries(batches).filter(([, b]) => b.spots?.includes(key))
  const spotOfKey = useMemo(() => new Map(care.allEnriched.map((r) => [r.key, r.spotKey])), [care.allEnriched])
  const spotsOfCreated = (created) => [...new Set(created.map((x) => spotOfKey.get(x.key)).filter(Boolean))]

  // Lands a run on the visit record: its created ids in batch `bid` — a Retry ADDS to the batch it completes, so
  // the run's done line counts them and its ONE Undo deletes them — each id that failed marked with what failed,
  // and every id that landed cleared of an older failure. A batch's spots follow its created ids.
  const settle = (bid, fresh, res, what) => setCare((cc) => {
    const prev = cc.batches?.[bid]
    const created = [...(prev ? prev.created : []), ...res.created]
    const b = { ...(prev || fresh), created }
    b.spots = b.scope === 'spot' ? [b.target] : b.scope === 'group' ? spotsOfCreated(created) : []
    const f = { ...(cc.failed || {}) }
    for (const x of res.created) delete f[x.key]
    for (const k of res.failed) f[k] = { bid, ...what }
    return { ...cc, batches: { ...(cc.batches || {}), [bid]: b }, failed: f }
  })
  const rowNames = (keys) => keys.map((k) => care.allEnriched.find((r) => r.key === k)?.name).filter(Boolean)
  const notLoggedText = (keys, name) => `${keys.length} not logged in ${name}: ${nameList(rowNames(keys))}. Retry is on each.`

  const run = async ({ scope, key, name, etype, keys, bodyEventType }) => {
    const total = keys.size
    if (!total) return null
    const bid = newId()
    setBusy({ scope, key, done: 0, total })
    announce(`${etype === 'watering' ? 'Watering' : 'Logging'} ${total} in ${name}…`)
    let lastSpoken = Date.now()
    const res = await actions.runBulk(etype, keys, {
      ...RUN, bodyEventType,
      onProgress: (p) => {
        setBusy({ scope, key, done: p.done, total: p.total })
        if (Date.now() - lastSpoken >= 5000) { lastSpoken = Date.now(); announce(`${p.done} of ${p.total} logged in ${name}.`) }
      },
    })
    setBusy(null)
    addLogged(care.logKey, res.created.map((x) => x.key))
    const kind = KIND_OF[bodyEventType || etype] || 'logged'
    settle(bid, { scope, target: key, name, kind, at: Date.now() }, res, { etype, body: bodyEventType || null })
    const fails = res.failed.length
    announce(`${kind === 'watered' ? 'Watered' : 'Logged'} ${res.created.length} in ${name}.` + (fails ? ' ' + notLoggedText(res.failed, name) : ''))
    // §5.5: a partial failure puts focus on the first Retry (the spot's own, or the group's first failed spot's).
    setFocusId(fails ? (scope === 'group' ? 'first-retry:' + key : scope === 'spot' ? 'retry:' + key : null) : (scope === 'group' ? 'group:' + key : 'spot:' + key))
    return res
  }

  const waterSpot = (spot) => run({ scope: 'spot', key: spot.key, name: spot.name, etype: 'watering', keys: spot.candidates })
  const waterGroup = (group) => run({ scope: 'group', key: group.key, name: group.key.toLowerCase(), etype: 'watering', keys: group.candidates })
  const feedProduct = (pg) => run({ scope: 'product', key: pg.key, name: pg.product, etype: 'fertilizing', keys: new Set(pg.rows.map((r) => r.key)) })

  // MF3: the spot row's Retry — every failed row of the spot in view, re-run as it failed. A run's failures
  // complete THEIR run (same batch: the spot's, or the group's, whose one line and one Undo then cover them); a
  // one-tap row's failure re-runs that row with its own type, leaving the done line the tap would have left.
  // Focus lands once, after: on the Retry while anything still fails, else the done line the spot shrank to,
  // else the spot row itself (other tasks' rows remain).
  const retrySpot = async (spot) => {
    const runs = new Map()
    const singles = []
    for (const r of spot.rows) {
      const f = failed[r.key]
      if (!f) continue
      if (f.bid && batches[f.bid]) {
        if (!runs.has(f.bid)) runs.set(f.bid, { etype: f.etype || r.eventType, body: f.body || undefined, keys: new Set() })
        runs.get(f.bid).keys.add(r.key)
      } else singles.push([r, f])
    }
    const landed = new Set()
    let still = 0
    for (const [bid, g] of runs) {
      const total = g.keys.size
      setBusy({ scope: 'spot', key: spot.key, done: 0, total, retry: true })
      announce(`Retrying ${total} in ${spot.name}…`)
      const res = await actions.runBulk(g.etype, g.keys, { ...RUN, bodyEventType: g.body, onProgress: (p) => setBusy({ scope: 'spot', key: spot.key, done: p.done, total: p.total, retry: true }) })
      setBusy(null)
      addLogged(care.logKey, res.created.map((x) => x.key))
      const kind = KIND_OF[g.body || g.etype] || 'logged'
      settle(bid, { scope: 'spot', target: spot.key, name: spot.name, kind, at: Date.now() }, res, { etype: g.etype, body: g.body || null })
      for (const x of res.created) landed.add(x.key)
      still += res.failed.length
      announce(`${kind === 'watered' ? 'Watered' : 'Logged'} ${res.created.length} in ${spot.name}.` + (res.failed.length ? ' ' + notLoggedText(res.failed, spot.name) : ''))
    }
    for (const [r, f] of singles) {
      const ok = await plantRun(r, f.body || undefined, { focus: false })
      if (ok) landed.add(r.key); else still++
    }
    setFocusId(still ? 'retry:' + spot.key : spot.rows.every((r) => landed.has(r.key)) ? 'spot:' + spot.key : 'spotrow:' + spot.key)
  }

  const notToday = (spot) => {
    const keys = spot.rows.map((r) => r.key)
    if (!keys.length) return
    skipMany(keys, care.getToken)
    const bid = newId()
    setCare((cc) => ({ ...cc, batches: { ...(cc.batches || {}), [bid]: { scope: 'nottoday', target: spot.key, name: spot.name, kind: 'not-today', skipped: keys, spots: [spot.key], at: Date.now() } } }))
    announce(`${spot.name}: not today — ${plural(keys.length, 'plant', 'plants')} skipped.`)
    setFocusId('spot:' + spot.key)
  }

  const undoBatch = async (bid) => {
    const b = batches[bid]
    if (!b) return
    setUndoing(bid)
    if (b.kind === 'not-today') {
      unskipMany(b.skipped, care.getToken)
      setCare((cc) => { const n = { ...(cc.batches || {}) }; delete n[bid]; return { ...cc, batches: n } })
      announce(`Undone: ${b.name} is back on today’s list.`)
    } else {
      const { undone, failed: stuck } = await actions.undoMany(b.created, { concurrency: 4 })
      removeLogged(care.logKey, undone.map((x) => x.key))
      setCare((cc) => {
        const n = { ...(cc.batches || {}) }
        if (stuck.length) n[bid] = { ...b, created: stuck, undoFailed: stuck.length }
        else delete n[bid]
        // An undone run leaves nothing to retry: its rows are simply due again, not "Not logged".
        const f = { ...(cc.failed || {}) }
        if (!stuck.length) for (const [k, v] of Object.entries(f)) if (v && v.bid === bid) delete f[k]
        return { ...cc, batches: n, failed: f }
      })
      announce(`Undone: ${undone.length} ${b.kind === 'watered' ? 'waterings' : 'logs'} in ${b.name}.` + (stuck.length ? ` ${stuck.length} could not be undone — those logs are still saved.` : ''))
    }
    setUndoing(null)
  }

  // ── per-plant actions (D11): the one-tap chip, Moist, Skip — each leaves a done line in place ──────────────
  // A failure stays on the row as "Not logged" + Retry, recording the type it posted; returns whether it landed.
  const plantRun = async (row, bodyEventType, { focus = true } = {}) => {
    const res = await actions.runBulk(row.eventType, new Set([row.key]), { concurrency: 1, excludeInFlight: true, bodyEventType })
    if (res.created.length) {
      addLogged(care.logKey, [row.key])
      const kind = KIND_OF[bodyEventType || row.eventType] || 'logged'
      setCare((cc) => {
        const f = { ...(cc.failed || {}) }; delete f[row.key]
        return { ...cc, failed: f, rowsDone: { ...(cc.rowsDone || {}), [row.key]: { kind, created: res.created[0], spot: row.spotKey } } }
      })
      announce(`${row.name}: ${kind}.`)
      if (focus) setFocusId('row:' + row.key)
      return true
    }
    if (res.failed.length) {
      setCare((cc) => ({ ...cc, failed: { ...(cc.failed || {}), [row.key]: { etype: row.eventType, body: bodyEventType || null } } }))
      announce(`${row.name} not logged. Retry is on the row.`)
      if (focus) setFocusId('row-retry:' + row.key)
    }
    return false
  }
  const rowProps = {
    onLog: (row) => plantRun(row, undefined),
    onMoist: (row) => plantRun(row, MOISTURE_CHECK_EVENT),
    // The row's Retry re-posts what failed — a failed Moist retries as Moist, never as the row's watering.
    onRetry: (row) => plantRun(row, failed[row.key]?.body || undefined),
    onSkip: (row) => {
      skipMany([row.key], care.getToken)
      setCare((cc) => ({ ...cc, rowsDone: { ...(cc.rowsDone || {}), [row.key]: { kind: 'skipped', spot: row.spotKey } } }))
      announce(`Skipped ${row.name} for today.`)
      setFocusId('row:' + row.key)
    },
    onUndo: async (row) => {
      const d = rowsDone[row.key]
      if (!d) return
      setUndoing(row.key)
      if (d.kind === 'skipped') unskipMany([row.key], care.getToken)
      else {
        const { undone } = await actions.undoMany([d.created], { concurrency: 1 })
        if (!undone.length) { setUndoing(null); announce(`Couldn’t undo ${row.name} — the log is still saved.`); return }
        removeLogged(care.logKey, [row.key])
      }
      setCare((cc) => { const n = { ...(cc.rowsDone || {}) }; delete n[row.key]; return { ...cc, rowsDone: n } })
      setUndoing(null)
      announce(`Undone: ${row.name}.`)
    },
    undoBusy: false,
  }

  const toggleIn = (field, key) => setCare((cc) => {
    const cur = new Set(cc[field] || [])
    if (cur.has(key)) cur.delete(key); else cur.add(key)
    return { ...cc, [field]: [...cur] }
  })

  // ── render ────────────────────────────────────────────────────────────────────────────────────────────
  const spotAllByKey = useMemo(() => {
    const m = new Map()
    for (const r of care.allEnriched) { if (!m.has(r.spotKey)) m.set(r.spotKey, []); m.get(r.spotKey).push(r) }
    return m
  }, [care.allEnriched])
  const groupBusy = busy && busy.scope === 'group' ? busy.key : null

  // A spot's done text counts ITS share of a group run (MF3: each touched spot shrinks to its own done line —
  // "Bag Area · watered 97", not the group's 154).
  const doneText = (bs, spotKey) => {
    const counts = {}
    for (const [, b] of bs) {
      const n = b.kind === 'not-today' ? 0 : (spotKey && b.scope === 'group' ? b.created.filter((x) => spotOfKey.get(x.key) === spotKey).length : b.created.length)
      counts[b.kind] = (counts[b.kind] || 0) + n
    }
    const parts = []
    for (const k of ['watered', 'fed', 'checked']) if (counts[k]) parts.push(`${k} ${counts[k]}`)
    if ('not-today' in counts) parts.push('not today')
    return parts.join(' · ')
  }
  const rowNotes = (spotKey) => {
    const n = { moist: 0, skipped: 0 }
    for (const d of Object.values(rowsDone)) if (d.spot === spotKey && n[d.kind] != null) n[d.kind]++
    return [n.moist ? `${n.moist} moist` : null, n.skipped ? `${n.skipped} skipped` : null].filter(Boolean).join(' · ')
  }

  // A batch an Undo can act on: a Not today, or a run that created something (a run whose every write failed
  // leaves an empty batch for its Retry to complete — there is nothing in it to undo).
  const undoable = ([, b]) => (b.scope === 'spot' || b.scope === 'nottoday') && (b.kind === 'not-today' || b.created.length > 0)

  const renderSpot = (spot) => {
    const bs = spotBatches(spot.key)
    const own = bs.filter(undoable)
    const handled = Object.values(rowsDone).some((d) => d.spot === spot.key)
    const partial = bs.length && spot.rows.length ? doneText(bs, spot.key) : null
    const open = (c?.open || []).includes(spot.key)
    const failedN = spot.rows.filter((r) => failed[r.key]).length
    return (
      <SpotRow key={spot.key} spot={spot} open={open} onToggle={() => toggleIn('open', spot.key)}
        busy={busy && busy.scope === 'spot' && busy.key === spot.key ? busy : null} groupBusy={groupBusy === spot.group ? groupBusy : null}
        handled={handled} partial={partial ? partial.replace(/^./, (x) => x.toUpperCase()) : null}
        failedN={failedN} onRetry={() => retrySpot(spot)}
        onNotToday={() => notToday(spot)} onWater={() => waterSpot(spot)}>
        <SpotBody spot={spot} spotAll={spotAllByKey.get(spot.key) || []} exceptions={c?.exceptions?.[spot.key] ?? null}
          done={rowsDone} failed={failed} pendingKeys={actions.pendingKeys}
          cohortOpen={(c?.cohort || []).includes(spot.key)} cohortAll={!!c?.shown?.[spot.key]}
          onCohort={() => toggleIn('cohort', spot.key)}
          onShowAll={() => setCare((cc) => ({ ...cc, shown: { ...(cc.shown || {}), [spot.key]: 'all' } }))}
          rowProps={{ ...rowProps, undoBusy: !!undoing }}
          waterOther={spot.candidates.size > 0 && (
            <button type="button" onClick={() => waterSpot(spot)} style={filledCommit} aria-label={`Water the other ${spot.candidates.size} in ${spot.name}`}>
              {`Water the other ${spot.candidates.size}`}
            </button>
          )} />
        {own.length > 0 && spot.rows.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 6px 6px' }}>
            <button type="button" onClick={() => undoBatch(own[own.length - 1][0])} style={outlineBtn}>Undo</button>
          </div>
        )}
      </SpotRow>
    )
  }

  const renderDoneSpot = (key, groupKey) => {
    const bs = spotBatches(key)
    if (!bs.length) return null
    const name = bs[bs.length - 1][1].name && bs[bs.length - 1][1].scope !== 'group' ? bs[bs.length - 1][1].name : (spotAllByKey.get(key)?.[0]?.spotName || 'Spot')
    const own = bs.filter(undoable)
    const last = own[own.length - 1]
    const stuck = last && last[1].undoFailed
    return (
      <SpotDoneLine key={key} spotKey={key} name={name} text={doneText(bs, key)} note={[rowNotes(key), stuck ? `${stuck} could not be undone` : null].filter(Boolean).join(' · ')}
        onUndo={last ? () => undoBatch(last[0]) : null} undoBusy={undoing === (last && last[0])}
        undoLabel={last ? `Undo: ${name} ${last[1].kind === 'not-today' ? 'not today' : doneText([last])}` : undefined} />
    )
  }

  const groupLine = (g) => {
    const gb = Object.entries(batches).filter(([, b]) => b.scope === 'group' && b.target === g.key)
    if (!gb.length) return null
    const [bid, b] = gb[gb.length - 1]
    return (
      <div data-testid="care-group-done" data-group={g.key} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 48 }}>
        <Icon name="action.check" size={16} decorative style={{ color: P.green }} />
        <span tabIndex={-1} data-focus-id={'group:' + g.key} style={{ flex: 1, fontSize: T.type.sm, outline: 'none' }}>
          <span style={{ fontWeight: 600, color: P.dark }}>{g.key}</span>
          <span style={{ color: P.mid }}>{` · watered ${b.created.length}`}{b.undoFailed ? ` · ${b.undoFailed} could not be undone` : ''}</span>
        </span>
        <button type="button" onClick={() => undoBatch(bid)} disabled={undoing === bid} aria-label={`Undo: ${g.key} watered ${b.created.length}`} style={outlineBtn}>Undo</button>
      </div>
    )
  }

  const heldSpots = (g) => {
    const held = heldOrder?.spots?.[g.key] || []
    const inModel = new Map(g.spots.map((s) => [s.key, s]))
    const keys = [...held, ...g.spots.map((s) => s.key).filter((k) => !held.includes(k))]
    return keys.map((k) => {
      if (spotSel.length && !spotSel.includes(k)) return null
      const s = inModel.get(k)
      if (s && s.rows.length) return renderSpot(s)
      return renderDoneSpot(k, g.key)
    })
  }

  const groupsToShow = model.groups.length ? model.groups : []
  const heldGroups = [...(heldOrder?.groups || []), ...groupsToShow.map((g) => g.key).filter((k) => !(heldOrder?.groups || []).includes(k))]

  return (
    <div ref={rootRef} data-testid="today-care" style={{ display: 'flex', flexDirection: 'column', gap: T.space.sm }}>
      {presentTasks.length > 1 && (
        <FilterChipRow aria-label="Show tasks" data-testid="care-filter-tasks"
          options={presentTasks.map((t) => ({ value: t, label: TASK_LABEL[t] }))}
          selected={new Set(tasks)}
          onToggle={(v) => { const n = new Set(tasks); if (n.has(v)) n.delete(v); else n.add(v); changeFilters({ ...filters, tasks: [...n] }) }}
          onClear={tasks.length ? () => changeFilters({ ...filters, tasks: [] }) : undefined} />
      )}
      {spotsPresent.length > 1 && !feedOnly && (
        <FilterChipRow aria-label="Show spots" data-testid="care-filter-spots"
          options={spotsPresent} selected={new Set(spotSel)} pinned={(c?.pinned || []).filter((k) => spotsPresent.some((s) => s.value === k))}
          onToggle={(v) => { const n = new Set(spotSel); if (n.has(v)) n.delete(v); else n.add(v); changeFilters({ ...filters, spots: [...n] }) }}
          onClear={spotSel.length ? () => changeFilters({ ...filters, spots: [] }) : undefined} />
      )}
      {feedOnly && care.substrate && (
        <div data-testid="today-substrate-note" style={substrateNote}>
          <Icon name="lifecycle.sprout" size={15} decorative style={{ marginRight: 6, verticalAlign: '-0.15em' }} />{care.substrate}
        </div>
      )}

      {feedOnly ? (
        <ul style={list}>
          {productGroups(care.rows.filter((r) => !spotSel.length || spotSel.includes(r.spotKey))).map((pg) => {
            const open = (c?.products || []).includes(pg.key)
            const n = pg.rows.length
            const b = busy && busy.scope === 'product' && busy.key === pg.key ? busy : null
            return (
              <li key={pg.key} data-testid="care-product" style={cardLi}>
                <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
                  <button type="button" aria-expanded={open} onClick={() => toggleIn('products', pg.key)} style={productHit}>
                    <span style={{ display: 'block', fontSize: T.type.base, fontWeight: 600, color: P.dark }}>{pg.product}</span>
                    <span style={{ display: 'block', fontSize: T.type.xs, color: P.mid }}>{[pg.method ? pg.method[0].toUpperCase() + pg.method.slice(1) : null, plural(n, 'plant', 'plants')].filter(Boolean).join(' · ')}</span>
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', paddingRight: 6 }}>
                    <button type="button" onClick={b ? undefined : () => feedProduct(pg)} aria-disabled={b ? 'true' : undefined} aria-label={b ? `Feeding ${b.done} of ${b.total}…` : `${n === 1 ? 'Feed 1' : 'Feed all ' + n} with ${pg.product}`} style={tinted}>
                      {b ? `Feeding ${b.done} of ${b.total}…` : (n === 1 ? 'Feed 1' : `Feed all ${n}`)}
                    </button>
                  </div>
                </div>
                {open && (
                  <div role="list" style={{ borderTop: '1px solid ' + P.border }}>
                    {pg.rows.map((r) => <PlantCareRow key={r.key} row={r} testid="care-row" reason={r.spotName} failed={!!failed[r.key]} pending={actions.pendingKeys.has(r.key)} {...rowProps} undoBusy={!!undoing} />)}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      ) : heldGroups.map((gk) => {
        const g = groupsToShow.find((x) => x.key === gk) || { key: gk, spots: [], candidates: new Set(), spotsWithWater: 0 }
        const items = heldSpots(g).filter(Boolean)
        if (!items.length && !groupLine(g)) return null
        const gBusy = busy && busy.scope === 'group' && busy.key === g.key ? busy : null
        const named = gk !== null && care.locationsOk
        return (
          <div key={gk} data-testid="care-group" data-group={gk} style={{ display: 'flex', flexDirection: 'column', gap: T.space.xs }}>
            {named && (groupLine(g) || (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: g.spotsWithWater >= 2 ? 48 : 24 }}>
                <h3 style={groupLabel}>{gk}</h3>
                {g.spotsWithWater >= 2 && g.candidates.size > 0 && (
                  <button type="button" data-testid="care-group-bulk" data-group={gk}
                    onClick={gBusy ? undefined : () => waterGroup(g)} aria-disabled={gBusy ? 'true' : undefined}
                    aria-label={gBusy ? `Watering ${gBusy.done} of ${gBusy.total}…` : `Water all ${g.candidates.size} ${gk === OUTSIDE ? 'outside' : 'in ' + gk}`}
                    style={{ ...tinted, marginLeft: 'auto' }}>
                    {gBusy ? `Watering ${gBusy.done} of ${gBusy.total}…` : `Water all ${g.candidates.size}`}
                  </button>
                )}
              </div>
            ))}
            <ul style={list}>{items}</ul>
          </div>
        )
      })}

      <FeedSuppressedList plan={care.plan} />
    </div>
  )
}

const list = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: T.space.xs }
const cardLi = { listStyle: 'none', background: P.white, border: '1px solid ' + P.border, borderRadius: T.radiusCard, overflow: 'clip' }
const groupLabel = { margin: 0, paddingLeft: 2, fontSize: T.type.xs, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: P.mid }
const productHit = { flex: 1, minWidth: 0, minHeight: 48, padding: `6px ${T.space.sm}px`, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }
const filledCommit = { display: 'block', width: 'calc(100% - 20px)', margin: '6px 10px', minHeight: T.buttonMinHeight, background: P.green, color: P.white, border: 'none', borderRadius: T.radiusButton, fontWeight: 700, fontSize: T.type.sm, cursor: 'pointer', fontFamily: 'inherit' }
const substrateNote = { fontSize: T.type.sm, color: P.mid, lineHeight: 1.45, background: P.greenPale, border: `1px solid ${P.greenLight}`, borderRadius: T.radiusCard, padding: '10px 12px' }
