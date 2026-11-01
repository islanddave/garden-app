// householdView.js — the household view ("the rest of the household's care") as ONE switch and ONE
// naming rule, shared by every reader.
//
// ONE KEY, ONE READER. localStorage 'garden.today.showOthers' = '1' is the per-device switch. Today
// reads it (useShowOthers) and its writer is the Settings › Controls row. The household view stays
// opt-in per person, so one person's page never gains the other's care unless they turned it on.
// Best-effort storage: unreadable means off.
import { useSyncExternalStore } from 'react'

export const SHOW_OTHERS_KEY = 'garden.today.showOthers'

export function readShowOthers() {
  try { return localStorage.getItem(SHOW_OTHERS_KEY) === '1' } catch { return false }
}

// The same-tab change event: 'storage' fires only in OTHER tabs, so a write here says so itself.
export const SHOW_OTHERS_EVENT = 'garden:showOthers'

export function writeShowOthers(on) {
  try { localStorage.setItem(SHOW_OTHERS_KEY, on ? '1' : '0') } catch { /* ignore */ }
  try { window.dispatchEvent(new Event(SHOW_OTHERS_EVENT)) } catch { /* ignore */ }
}

// The switch read LIVE: the Settings › Controls row writes
// it, and Today follows a change from this tab or another one without a remount.
function subscribeShowOthers(onChange) {
  const onStorage = (e) => { if (!e || e.key == null || e.key === SHOW_OTHERS_KEY) onChange() }
  window.addEventListener(SHOW_OTHERS_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => { window.removeEventListener(SHOW_OTHERS_EVENT, onChange); window.removeEventListener('storage', onStorage) }
}

export function useShowOthers() {
  return useSyncExternalStore(subscribeShowOthers, readShowOthers, () => false)
}

// Another member's name as Today prints it ("Jen's care today", "(Jen)"): the first word of their roster
// display_name, else 'Someone else'. `members` = the roster (useMembers), `sub` = their user id.
export function memberFirstName(members, sub) {
  const m = (members || []).find(o => o && o.id === sub)
  const n = (m?.display_name || '').trim()
  return n ? n.split(/\s+/)[0] : 'Someone else'
}
