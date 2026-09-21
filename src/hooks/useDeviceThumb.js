// src/hooks/useDeviceThumb.js — BUG-SEEDTHUMBSOFFLINE-001. A row's thumb, if this phone already
// holds it (src/lib/deviceThumb.js has the why).
//
// Returns:
//   undefined — still looking (a few ms of Cache API). The caller must NOT start a mint yet, or it
//               spends the round trip this exists to save.
//   string    — a URL the service worker answers from photos-v1, with no network.
//   null      — not on the phone (or no key, or no Cache API): mint as before.
// Pass a null key for a row that is not drawing its thumb (outside the image window): nothing is
// looked up until the row actually needs a picture.
import { useEffect, useState } from 'react'
import { deviceThumbUrl, deviceThumbLookupPossible } from '../lib/deviceThumb.js'

export default function useDeviceThumb(key) {
  const possible = deviceThumbLookupPossible()
  const [found, setFound] = useState({ key: null, url: null })

  useEffect(() => {
    if (!key || !possible) return undefined
    let live = true
    deviceThumbUrl(key).then((url) => { if (live) setFound({ key, url }) })
    return () => { live = false }
  }, [key, possible])

  if (!key || !possible) return null
  return found.key === key ? found.url : undefined
}
