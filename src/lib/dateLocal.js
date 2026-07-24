// Local-calendar date helpers (WS-A4). The app's "today" must be the user's LOCAL
// calendar day, not UTC — `new Date().toISOString().slice(0,10)` rolls the date forward
// after ~8pm ET, filing events/projects on tomorrow. These use the local Date getters so
// the result is the viewer's wall-clock day. Consolidates the ad-hoc copies that were
// scattered per-component (CareNeeded, ProjectDetail, etc.).

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
