// todayV2Flag — the per-DEVICE switch between the current Today and the redesign (V5-TODAYREDESIGN-001 S2).
//
// OFF BY DEFAULT: no key = the current Today. The only writer is the Debug & smoke row "New Today (preview)
// on this phone", visible to both users; the only reader that matters is TodayRoute, which reads it
// SYNCHRONOUSLY on its first render (plan-v2 §6.4), so the chosen page paints first time with no flash of
// the other. useSyncExternalStore rather than a read at mount, so a flip in another tab (storage event) or
// on the Debug page lands the next time /today renders without a reload.
//
// Per device, and scrubbed at sign-out (clientPrefs.js CLIENT_PREF_KEYS): the next person to sign in on a
// shared phone starts on the default page, not on the previous person's preview choice.
import { useSyncExternalStore } from 'react'

export const TODAY_V2_FLAG_KEY = 'garden.todayV2'

const listeners = new Set()

export function readTodayV2Flag() {
  try { return localStorage.getItem(TODAY_V2_FLAG_KEY) === '1' } catch { return false }
}

// true → '1'; false → the key removed (off is the absence of a choice, so sign-out's scrub and "off" agree).
export function writeTodayV2Flag(on) {
  try {
    if (on) localStorage.setItem(TODAY_V2_FLAG_KEY, '1')
    else localStorage.removeItem(TODAY_V2_FLAG_KEY)
  } catch { /* storage blocked: the switch simply does not stick on this device */ }
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
  return useSyncExternalStore(subscribe, readTodayV2Flag, () => false)
}
