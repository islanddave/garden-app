import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { P } from '../../../lib/constants.js'
import { T } from '../../forms/formStyles.js'
import FilterChipRow from '../../forms/FilterChipRow.jsx'
import Icon from '../../Icon.jsx'
import { skipMany, unskipMany } from '../careStore.js'
import { FeedSuppressedList } from '../CareNeeded.jsx'
import { buildModel, productGroups, TASKS, TASK_LABEL, TASK_ETYPE, OUTSIDE } from '../../../lib/todayV2/spots.js'
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

export default function NeedsCare({ care, record, update, announce, planDate, userId, filterIntent }) {
  const c = record?.care || null
  const { actions } = care
  const setCare = useCallback((fn) => update((r) => ({ ...r, care: fn(r.care || {}) })), [update])

  // ── filters (§2.6): one axis per row, OR within a row, empty = all; per session; never re-sort ─────────────
  const fKey = filtersKey(userId)
  const [filters, setFilters] = useState(() => readFilters(fKey, planDate))
  const setAndSave = useCallback((next) => { setFilters(next); writeFilters(fKey, planDate, next) }, [fKey, planDate])
  // S3's jump bar writes the chip's task into the visit record (`filter`); a new intent REPLACES the task row.
  const seenIntent = useRef(JSON.stringify(filterIntent ?? null))
  useEffect(() => {
    const sig = JSON.stringify(filterIntent ?? null)
    if (sig === seenIntent.current) return
    seenIntent.current = sig
    const t = typeof filterIntent === 'string' ? filterIntent : (filterIntent?.task || (Array.isArray(filterIntent?.tasks) ? filterIntent.tasks[0] : null))
    if (TASKS.includes(t)) setAndSave({ ...filters, tasks: [t] })
  }, [filterIntent, filters, setAndSave])

  const presentTasks = TASKS.filter((t) => care.rows.some((r) => r.task === t))
  const tasks = filters.tasks.filter((t) => presentTasks.includes(t))
  const spotsPresent = useMemo(() => {
    const m = new Map()
    for (const r of care.rows) if (!tasks.length || tasks.includes(r.task)) { if (!m.has(r.spotKey)) m.set(r.spotKey, { value: r.spotKey, label: r.spotName }) }
    return [...m.values()]
  }, [care.rows, tasks])
  const spotSel = filters.spots.filter((k) => spotsPresent.some((s) => s.value === k))

  const model = useMemo(() => buildModel(care.rows, { held: c?.order, tasks, spots: spotSel, bedWait: care.bedWait }), [care.rows, c?.order, tasks, spotSel, care.bedWait])
  const feedOnly = tasks.length === 1 && tasks[0] === 'feed'

  // ── run bookkeeping ─────────────────────────────────────────────────────────────────────────────────────
  const [busy, setBusy] = useState(null)       // { scope: 'spot'|'group'|'product', key, done, total }
  const [undoing, setUndoing] = useState(null) // batch id or row key
  const [focusId, setFocusId] = useState(null)
  const rootRef = useRef(null)
  useEffect(() => {
    if (!focusId || !rootRef.current) return
    const el = rootRef.current.querySelector(`[data-focus-id="${focusId.replace(/"/g, '\\"')}"]`)
    if (el) el.focus({ preventScroll: true })
    setFocusId(null)
  }, [focusId, record])

  const batches = c?.batches || {}
  const rowsDone = c?.rowsDone || {}
  const failed = c?.failed || {}
  const spotBatches = (key) => Object.entries(batches).filter(([, b]) => b.spots?.includes(key))

  const markFailed = (keys, on) => setCare((cc) => {
    const f = { ...(cc.failed || {}) }
    for (const k of keys) { if (on) f[k] = true; else delete f[k] }
    return { ...cc, failed: f }
  })

  const run = useCallback(async ({ scope, key, name, etype, keys, bodyEventType, spotsOf }) => {
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
    setCare((cc) => ({
      ...cc,
      batches: { ...(cc.batches || {}), [bid]: { scope, target: key, name, kind, created: res.created, spots: spotsOf(res.created), at: Date.now() } },
      failed: { ...(cc.failed || {}), ...Object.fromEntries(res.failed.map((k) => [k, true])) },
    }))
    const fails = res.failed.length
    announce(`${kind === 'watered' ? 'Watered' : 'Logged'} ${res.created.length} in ${name}.` + (fails ? ` ${fails} not logged — Retry is on each.` : ''))
    setFocusId(fails ? null : (scope === 'group' ? 'group:' + key : 'spot:' + key))
    return res
  }, [actions, announce, care.logKey, setCare])

  const spotsOfCreated = (created) => [...new Set(created.map((x) => care.allEnriched.find((r) => r.key === x.key)?.spotKey).filter(Boolean))]

  const waterSpot = (spot) => run({ scope: 'spot', key: spot.key, name: spot.name, etype: 'watering', keys: spot.candidates, spotsOf: () => [spot.key] })
  const waterGroup = (group) => run({ scope: 'group', key: group.key, name: group.key.toLowerCase(), etype: 'watering', keys: group.candidates, spotsOf: spotsOfCreated })
  const feedProduct = (pg) => run({ scope: 'product', key: pg.key, name: pg.product, etype: 'fertilizing', keys: new Set(pg.rows.map((r) => r.key)), spotsOf: () => [] })

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
        return { ...cc, batches: n }
      })
      announce(`Undone: ${undone.length} ${b.kind === 'watered' ? 'waterings' : 'logs'} in ${b.name}.` + (stuck.length ? ` ${stuck.length} could not be undone — those logs are still saved.` : ''))
    }
    setUndoing(null)
  }

  // ── per-plant actions (D11): the one-tap chip, Moist, Skip — each leaves a done line in place ──────────────
  const plantRun = async (row, bodyEventType) => {
    const res = await actions.runBulk(row.eventType, new Set([row.key]), { concurrency: 1, excludeInFlight: true, bodyEventType })
    if (res.created.length) {
      addLogged(care.logKey, [row.key])
      const kind = KIND_OF[bodyEventType || row.eventType] || 'logged'
      setCare((cc) => {
        const f = { ...(cc.failed || {}) }; delete f[row.key]
        return { ...cc, failed: f, rowsDone: { ...(cc.rowsDone || {}), [row.key]: { kind, created: res.created[0], spot: row.spotKey } } }
      })
      announce(`${row.name}: ${kind}.`)
      setFocusId('row:' + row.key)
    } else if (res.failed.length) {
      markFailed([row.key], true)
      announce(`${row.name} not logged. Retry is on the row.`)
    }
  }
  const rowProps = {
    onLog: (row) => plantRun(row, undefined),
    onMoist: (row) => plantRun(row, MOISTURE_CHECK_EVENT),
    onRetry: (row) => plantRun(row, undefined),
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

  const doneText = (bs) => {
    const counts = {}
    for (const [, b] of bs) counts[b.kind] = (counts[b.kind] || 0) + (b.kind === 'not-today' ? 0 : b.created.length)
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

  const renderSpot = (spot) => {
    const bs = spotBatches(spot.key)
    const own = bs.filter(([, b]) => b.scope === 'spot' || b.scope === 'nottoday')
    const handled = Object.values(rowsDone).some((d) => d.spot === spot.key)
    const partial = bs.length && spot.rows.length ? doneText(bs) : null
    const open = (c?.open || []).includes(spot.key)
    return (
      <SpotRow key={spot.key} spot={spot} open={open} onToggle={() => toggleIn('open', spot.key)}
        busy={busy && busy.scope === 'spot' && busy.key === spot.key ? busy : null} groupBusy={groupBusy === spot.group ? groupBusy : null}
        handled={handled} partial={partial ? partial.replace(/^./, (x) => x.toUpperCase()) : null}
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
    const own = bs.filter(([, b]) => b.scope === 'spot' || b.scope === 'nottoday')
    const last = own[own.length - 1]
    const stuck = last && last[1].undoFailed
    return (
      <SpotDoneLine key={key} spotKey={key} name={name} text={doneText(bs)} note={[rowNotes(key), stuck ? `${stuck} could not be undone` : null].filter(Boolean).join(' · ')}
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
    const held = c?.order?.spots?.[g.key] || []
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
  const heldGroups = [...(c?.order?.groups || []), ...groupsToShow.map((g) => g.key).filter((k) => !(c?.order?.groups || []).includes(k))]

  return (
    <div ref={rootRef} data-testid="today-care" style={{ display: 'flex', flexDirection: 'column', gap: T.space.sm }}>
      {presentTasks.length > 1 && (
        <FilterChipRow aria-label="Show tasks" data-testid="care-filter-tasks"
          options={presentTasks.map((t) => ({ value: t, label: TASK_LABEL[t] }))}
          selected={new Set(tasks)}
          onToggle={(v) => { const n = new Set(tasks); if (n.has(v)) n.delete(v); else n.add(v); setAndSave({ ...filters, tasks: [...n] }) }}
          onClear={tasks.length ? () => setAndSave({ ...filters, tasks: [] }) : undefined} />
      )}
      {spotsPresent.length > 1 && !feedOnly && (
        <FilterChipRow aria-label="Show spots" data-testid="care-filter-spots"
          options={spotsPresent} selected={new Set(spotSel)} pinned={(c?.pinned || []).filter((k) => spotsPresent.some((s) => s.value === k))}
          onToggle={(v) => { const n = new Set(spotSel); if (n.has(v)) n.delete(v); else n.add(v); setAndSave({ ...filters, spots: [...n] }) }}
          onClear={spotSel.length ? () => setAndSave({ ...filters, spots: [] }) : undefined} />
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
