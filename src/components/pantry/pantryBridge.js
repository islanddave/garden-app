// src/components/pantry/pantryBridge.js
// Put-Up B′ release 2 (V4 §2.5 "Rename bridge") — one inline dismissible line at the top of the Pantry:
// "What's put up is now the Pantry — same jars, plus things you buy". Retired on dismiss or after 2
// visits. PER VIEWER: the key carries the signed-in person's id, so Jen's visits never retire Dave's
// line on a shared phone. Every storage access is try/catch'd and a failure reads as "show it" on the
// first visit and never throws — a lost counter costs one extra showing, a crash costs the page.
export const BRIDGE_TEXT = 'What’s put up is now the Pantry — same jars, plus things you buy'
export const BRIDGE_PREFIX = 'garden:pantry-bridge:v1:'
export const BRIDGE_MAX_VISITS = 2

export function bridgeKey(sub) {
  return `${BRIDGE_PREFIX}${sub || 'anon'}`
}

function storage() {
  try { return typeof window !== 'undefined' ? window.localStorage ?? null : null } catch { return null }
}

export function readBridge(sub) {
  const s = storage()
  if (!s) return { visits: 0, dismissed: false }
  try {
    const rec = JSON.parse(s.getItem(bridgeKey(sub)) ?? 'null')
    if (!rec || typeof rec !== 'object') return { visits: 0, dismissed: false }
    const visits = Number.isInteger(rec.visits) && rec.visits >= 0 ? rec.visits : 0
    return { visits, dismissed: rec.dismissed === true }
  } catch { return { visits: 0, dismissed: false } }
}

function writeBridge(sub, rec) {
  const s = storage()
  if (!s) return
  try { s.setItem(bridgeKey(sub), JSON.stringify(rec)) } catch { /* non-fatal */ }
}

// Counts ONE visit and answers whether the line shows on it: visits 1 and 2 show it, the third does
// not, and a dismissal retires it for good.
export function noteBridgeVisit(sub) {
  const cur = readBridge(sub)
  if (cur.dismissed) return false
  const visits = cur.visits + 1
  writeBridge(sub, { visits, dismissed: false })
  return visits <= BRIDGE_MAX_VISITS
}

export function dismissBridge(sub) {
  const cur = readBridge(sub)
  writeBridge(sub, { visits: cur.visits, dismissed: true })
}
