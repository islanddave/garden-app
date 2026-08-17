// useWhatsNew — V4-WHATSNEW-001. Fetches releases.json, derives whether the newest release is
// unseen vs the last-seen version, and stays in sync across instances (header dot + More-tab dot)
// via the SEEN_EVENT. First run writes the current version (no cold-start dot).
//
// V4-WHATSNEW-002 / V4-USERPREFS-001 — last-seen is now PER-USER and cross-device. whatsNew.js's
// header used to say this sync was "deferred to V4-WHATSNEW-002"; this is it.
//
// localStorage REMAINS, as the synchronous local layer: readSeen() is what lets the dot resolve on
// the first frame instead of flashing on while a prefs GET is in flight. The server is the
// cross-device layer on top.
//
// MAX WINS, not union and not last-write. The effective seen version is the NEWER of local and
// server (cmpVersion), because "I already read the 4.31 notes on my laptop" must clear the dot on
// the phone, while a STALE server value must never re-raise a dot the user already dismissed here.
// Taking the max is the only merge with both properties.
import { useEffect, useState, useCallback } from 'react'
import { readSeen, writeSeen, isUnseen, cmpVersion, SEEN_EVENT } from '../lib/whatsNew.js'
import { useApiFetch } from '../lib/api.js'
import { fetchNotificationPrefs, saveWhatsNewSeen } from '../lib/notificationPrefsClient.js'

export function useWhatsNew() {
  const [latest, setLatest] = useState(null)
  const [unseen, setUnseen] = useState(false)
  const { getToken } = useApiFetch()

  useEffect(() => {
    let on = true
    // Both reads in flight together — the prefs GET must not delay the dot decision, and a failed
    // or absent prefs read (returns null, never throws) simply leaves the local answer standing.
    Promise.all([
      fetch('/releases.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null),
      fetchNotificationPrefs({ getToken }).catch(() => null),
    ]).then(([d, prefs]) => {
      if (!on) return
      const v = Array.isArray(d) && d[0] && d[0].version ? d[0].version : null
      setLatest(v)

      const local = readSeen()
      const remote = typeof prefs?.whats_new_last_seen === 'string' ? prefs.whats_new_last_seen : null
      // Max of the two. Either may be null/'' (never set on that side).
      let seen = local
      if (remote && (!seen || cmpVersion(remote, seen) > 0)) {
        seen = remote
        writeSeen(remote)   // cache the newer answer locally so the next cold start is instant
      }

      if (seen == null || seen === '') {
        // First run on this identity anywhere: mark current as seen so there is no cold-start dot,
        // and push it so a second device does not then show one.
        writeSeen(v)
        if (v) saveWhatsNewSeen({ getToken, version: v })
        setUnseen(false)
      } else {
        setUnseen(isUnseen(v, seen))
        // Local was ahead of the server (dismissed here while offline, or before this shipped) —
        // push it up so the other device stops dotting. Fire-and-forget.
        if (local && (!remote || cmpVersion(local, remote) > 0)) saveWhatsNewSeen({ getToken, version: local })
      }
    })
    const onSeen = () => setUnseen(false)
    if (typeof window !== 'undefined') window.addEventListener(SEEN_EVENT, onSeen)
    return () => { on = false; if (typeof window !== 'undefined') window.removeEventListener(SEEN_EVENT, onSeen) }
  }, [getToken])

  const markSeen = useCallback(() => {
    if (!latest) return
    writeSeen(latest)             // local first, synchronously — the dot must clear on this tap
    saveWhatsNewSeen({ getToken, version: latest })
    setUnseen(false)
  }, [latest, getToken])

  return { unseen, latest, markSeen }
}
