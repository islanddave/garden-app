// todayV2Flag — the per-DEVICE switch between the redesigned Today and the old one (V5-TODAYREDESIGN-001 S2;
// default flipped at S8b / L7).
//
// ON BY DEFAULT since S8b: no key = featureFlags TODAY_V2_DEFAULT (true = the redesign). '1' = this phone chose
// the redesign, '0' = this phone chose the old page; anything else reads as no choice. The only writer is the
// Debug & smoke row "New Today on this phone", visible to both users; the only reader that matters is TodayRoute,
// which reads it SYNCHRONOUSLY on its first render (plan-v2 §6.4), so the chosen page paints first time with no
// flash of the other. useSyncExternalStore rather than a read at mount, so a flip in another tab (storage event)
// or on the Debug page lands the next time /today renders without a reload.
//
// Per device, and scrubbed at sign-out (clientPrefs.js CLIENT_PREF_KEYS): the next person to sign in on a
// shared phone starts on the default page, not on the previous person's choice. A bundle from before S8b reads
// only '1' as on, so '0' and no key both give it the old page: a forward undo or an older cached bundle agrees
// with what this phone chose wherever it chose the old page.
import { useSyncExternalStore } from 'react'
import { TODAY_V2_DEFAULT } from './featureFlags.js'

export const TODAY_V2_FLAG_KEY = 'garden.todayV2'

export function readTodayV2Flag() {
  try {
    const v = localStorage.getItem(TODAY_V2_FLAG_KEY)
    if (v === '1') return true
    if (v === '0') return false
  } catch { /* storage blocked: no choice can be read, so the default */ }
  return TODAY_V2_DEFAULT
}

const listeners = new Set()

// Both answers are stored ('1' / '0'), so a choice survives a later change of the default; sign-out's scrub
// removes the key, which is "no choice".
export function writeTodayV2Flag(on) {
  try { localStorage.setItem(TODAY_V2_FLAG_KEY, on ? '1' : '0') } catch { /* storage blocked: the switch simply does not stick on this device */ }
  for (const fn of [...listeners]) fn()
}

function subscribe(fn) {
  listeners.add(fn)
  const onStorage = (e) => { if (!e || e.key === null || e.key === TODAY_V2_FLAG_KEY) fn() }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(fn)
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

export function useTodayV2Flag() {
  return useSyncExternalStore(subscribe, readTodayV2Flag, () => TODAY_V2_DEFAULT)
}
