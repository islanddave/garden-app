// Local-calendar date helpers (WS-A4). The app's "today" must be the user's LOCAL
// calendar day, not UTC — `new Date().toISOString().slice(0,10)` rolls the date forward
// after ~8pm ET, filing events/projects on tomorrow. These use the local Date getters so
// the result is the viewer's wall-clock day. Consolidates the ad-hoc copies that were
// scattered per-component (CareNeeded, ProjectDetail, etc.).

// A DATE column arrives bare ("2026-04-10") or as the Lambda serialises the driver's Date
// ("2026-04-10T00:00:00.000Z"). Both are a calendar day with no instant behind them, and
// `new Date()` reads the second as the evening before everywhere west of Greenwich.
export const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0+)?(?:Z|[+-]00:?00))?$/

// A calendar day becomes LOCAL midnight of that day; anything with a real time of day is an
// instant and is parsed as one, so it still renders in the viewer's zone. null when unreadable.
export function parseDayOrInstant(value) {
  if (!value) return null
  const m = typeof value === 'string' ? CALENDAR_DAY.exec(value) : null
  if (!m) {
    const d = new Date(value)
    return isNaN(d.getTime()) ? null : d
  }
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null
}

// Format a Date as local `YYYY-MM-DD` (never shifts across the UTC boundary).
export function toLocalISO(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Today's local calendar date as `YYYY-MM-DD`.
export function todayLocalISO() {
  return toLocalISO(new Date())
}
