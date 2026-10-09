import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { P } from '../../../lib/constants.js'
import { T } from '../../forms/formStyles.js'
import { rainSplit, waitingLine, coveredLine, RAIN_HOLD_AUTO_SHOW } from '../../../lib/rainHold.js'
import PlantCareRow from './PlantCareRow.jsx'
import { removeLogged } from './needsCareStore.js'

// RainHold — what rain did to today's watering, in the glance card's OPEN state (BUG-DEFERNOSTRESSOVERRIDE-001,
// Design A; Dave 2026-10-09: a held plant he finds dry, he waters on the spot). Two lines, never one:
//   "Waiting for rain · N"  [Show / Hide]   the plantings the engine holds on a FORECAST, each a PlantCareRow
//                                           with the ordinary Water chip — no Skip, no Moist;
//   "Rain covered M — it already fell."     the ones rain that fell took care of. No control.
// A line whose count is 0 is omitted (the waiting line stays while a row watered this visit keeps its done
// line and Undo under it). The list shows itself at RAIN_HOLD_AUTO_SHOW or fewer; a Show / Hide tap is the
// visit's from then on (record.rain.shown).
//
// The rows and the write path are the page's (useNeedsCare → useCareActions, V2 options): Water here is
// NeedsCare.jsx's one-tap plantRun over the same hook, so it posts the same `watering` body, takes the same
// in-flight and today-logged guards, and leaves the same done line, "Not logged" + Retry, and Undo. What this
// adds is the visit's — record.rain { shown, rowsDone, failed } — and nothing here raises a toast: results
// speak through the page's one status region.
//
// With no `care` (the card drawn without the page's care state) the two lines print from the plan alone.
const NOOP = () => {}
const css = (s) => String(s).replace(/"/g, '\\"')
const plural = (n) => n + ' planting' + (n === 1 ? '' : 's')

export default function RainHold({ plan, care = null, record = null, update = NOOP, announce = NOOP, writesHeld = false }) {
  const listId = useId()
  const rootRef = useRef(null)
  const split = useMemo(() => rainSplit(plan), [plan])
  const st = record?.rain || null
  const setRain = useCallback((fn) => update((r) => ({ ...r, rain: fn(r.rain || {}) })), [update])
  const [undoing, setUndoing] = useState(null)
  const [focusId, setFocusId] = useState(null)
  // A Water chip that became a done line, or a Retry, took the focused node with it: focus follows (§5.5).
  useEffect(() => {
    if (!focusId || !rootRef.current) return
    const [kind, ...rest] = focusId.split(':')
    const el = kind === 'row-retry'
      ? rootRef.current.querySelector(`[data-key="${css(rest.join(':'))}"] button[aria-label^="Retry"]`)
      : rootRef.current.querySelector(`[data-focus-id="${css(focusId)}"]`)
    if (el) el.focus({ preventScroll: true })
    setFocusId(null)
  }, [focusId, record])

  const rain = care?.rain || null
  const rowsDone = st?.rowsDone || {}
  const failed = st?.failed || {}
  const drawn = rain ? rain.rows.filter((r) => rain.live.has(r.key) || rowsDone[r.key]) : []
  const n = rain ? rain.live.size : split.waiting.length
  const covered = split.covered
  if (!n && !drawn.length && !covered) return null
  // Until the visit has its record there is nowhere to keep a done line: the rows wait, inert.
  const held = writesHeld || !record
  const shown = typeof st?.shown === 'boolean' ? st.shown : (rain ? rain.rows.length : n) <= RAIN_HOLD_AUTO_SHOW

  const water = async (row) => {
    if (held) return
    const res = await care.actions.runBulk(row.eventType, new Set([row.key]), { concurrency: 1, excludeInFlight: true, ...care.claim })
    if (res.created.length) {
      setRain((cc) => {
        const f = { ...(cc.failed || {}) }; delete f[row.key]
        return { ...cc, failed: f, rowsDone: { ...(cc.rowsDone || {}), [row.key]: { kind: 'watered', created: res.created[0] } } }
      })
      announce(`${row.name}: watered.`)
      setFocusId('row:' + row.key)
    } else if (res.failed.length) {
      setRain((cc) => ({ ...cc, failed: { ...(cc.failed || {}), [row.key]: true } }))
      announce(`${row.name} not logged. Retry is on the row.`)
      setFocusId('row-retry:' + row.key)
    }
  }
  const undo = async (row) => {
    const d = rowsDone[row.key]
    if (!d) return
    setUndoing(row.key)
    const { undone } = await care.actions.undoMany([d.created], { concurrency: 1 })
    if (!undone.length) { setUndoing(null); announce(`Couldn’t undo ${row.name} — the log is still saved.`); return }
    removeLogged(care.logKey, [row.key])
    setRain((cc) => { const m = { ...(cc.rowsDone || {}) }; delete m[row.key]; return { ...cc, rowsDone: m } })
    setUndoing(null)
    announce(`Undone: ${row.name}.`)
  }

  return (
    <div ref={rootRef} data-testid="care-rain-note" style={{ display: 'flex', flexDirection: 'column', gap: T.space.xs }}>
      {(n > 0 || drawn.length > 0) && (
        <div data-testid="rain-waiting">
          <div style={waitLine}>
            <span data-testid="rain-waiting-line" style={{ flex: 1, minWidth: 0 }}>{waitingLine(n)}</span>
            {drawn.length > 0 && (
              <button type="button" data-testid="rain-waiting-toggle" aria-expanded={shown} aria-controls={shown ? listId : undefined}
                aria-label={(shown ? 'Hide the ' : 'Show the ') + plural(drawn.length) + ' waiting for rain'}
                onClick={() => setRain((cc) => ({ ...cc, shown: !shown }))} style={textLink}>
                {shown ? 'Hide' : 'Show'}
              </button>
            )}
          </div>
          {shown && drawn.length > 0 && (
            <div id={listId} style={listCard}>
              <div role="list" style={{ marginTop: -1 }}>
                {drawn.map((r) => (
                  <PlantCareRow key={r.key} row={r} testid="rain-wait-row" reason={r.reason}
                    done={!rain.live.has(r.key) ? rowsDone[r.key] : null} failed={!!failed[r.key]}
                    pending={care.actions.pendingKeys.has(r.key)} undoBusy={!!undoing} writesHeld={held}
                    onLog={water} onRetry={water} onUndo={undo} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {covered > 0 && <p data-testid="rain-covered-line" style={coveredStyle}>{coveredLine(covered)}</p>}
    </div>
  )
}

const waitLine = { display: 'flex', alignItems: 'center', gap: T.space.sm, minHeight: T.buttonMinHeight, fontSize: T.type.sm, color: P.mid }
const textLink = { flexShrink: 0, minHeight: T.buttonMinHeight, minWidth: T.buttonMinHeight, padding: '0 10px', background: 'none', border: 'none', color: P.green, fontWeight: 600, fontSize: T.type.sm, cursor: 'pointer', fontFamily: 'inherit' }
// One card around the rows (SpotRow's); the first row's own top hairline is tucked under its border.
const listCard = { background: P.white, border: '1px solid ' + P.border, borderRadius: T.radiusCard, overflow: 'clip' }
const coveredStyle = { margin: 0, fontSize: T.type.sm, color: P.mid }
