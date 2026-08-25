// useHandedness — V4-HANDEDNESSCONTROLS-001 (BD-054). The React seam over src/lib/handedness.js.
//
// TWO HOOKS, DELIBERATELY SPLIT, and the split is the whole design:
//
//   useHandedness()      — LOCAL ONLY. No auth, no network, no provider. Ten layout surfaces call
//                          this, including PlantingSelect and NumberPad, whose tests do not wrap in
//                          a ClerkProvider. Putting useApiFetch in here would have made a layout
//                          primitive require an auth context and broken every one of those suites.
//   useHandednessSync()  — the ONE-SHOT server adopt. Takes getToken as an argument rather than
//                          reaching for useApiFetch itself, so its caller keeps owning the auth
//                          seam that its own tests already mock (api.js:258-263).
//
// The sync is latched at MODULE scope, not per-component: the value is global, so a second consumer
// mounting must not fire a second GET. Same reasoning as HarvestWatchBand's `hwModule` cache.
//
// SERVER WINS, LAST-WRITE-WINS — not a merge. This is a single stated preference, like
// log_many_all_selected and unlike the append-only skip set, so there is nothing to union.
// `handedness` absent or null means "this user has never set it anywhere": keep the local answer
// rather than stomping it with a default (ScopeChecklist.jsx:78 makes the same distinction, and for
// the same reason — an unset server value is not a choice).
//
// PRE-MIGRATION BEHAVIOUR IS SAFE BY CONSTRUCTION. user_notification_prefs.handedness does not
// exist yet (migrations/v4-handednesscontrols-001, authored, NOT applied). Until it does the GET
// simply has no such field, so the adopt is a no-op; and saveHandedness's PATCH carries only that
// one key, so the critter Lambda's HAS_UPDATABLE check (validators.js:102) rejects it with a 400 —
// which notificationPrefsClient turns into a silent null, never a throw. The setting works
// per-device today and gains cross-device sync the moment the column lands, with no client change.
import { useEffect, useState } from 'react'
import { fetchNotificationPrefs } from '../lib/notificationPrefsClient.js'
import { HANDEDNESS_EVENT, HANDS, readHand, writeHand } from '../lib/handedness.js'

let adopted = null   // Promise | null — the module-scope once-latch.

export function useHandedness() {
  const [hand, setHand] = useState(readHand)
  useEffect(() => {
    const onChange = () => setHand(readHand())
    window.addEventListener(HANDEDNESS_EVENT, onChange)
    // Another tab on the same device (Dave keeps the app open on a laptop and a phone).
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener(HANDEDNESS_EVENT, onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])
  return hand
}

export function useHandednessSync(getToken) {
  useEffect(() => {
    if (adopted || typeof getToken !== 'function') return
    adopted = (async () => {
      const prefs = await fetchNotificationPrefs({ getToken })
      const v = prefs?.handedness
      // Not a truthiness check: an unknown string must not be adopted either, and normalizeHand
      // inside writeHand would silently rewrite it to 'right' — which would look like a real
      // choice on the next read. Only a known hand is worth writing.
      if (!HANDS.includes(v)) return
      if (v !== readHand()) writeHand(v)     // dispatches HANDEDNESS_EVENT → every surface turns over
    })()
  }, [getToken])
}

// Test seam only. The latch is module state and vitest does not reset modules between cases in a
// file; without this a suite's second case would silently skip the adopt it means to exercise.
export function __resetHandednessSync() { adopted = null }
