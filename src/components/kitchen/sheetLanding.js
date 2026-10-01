// src/components/kitchen/sheetLanding.js
// Put-Up UX pass R1 (prep) — THE LANDING, shared. Moved here unchanged from StartBatchSheet.jsx, where it
// was written, because more than one sheet now hands over to the page after it closes.
//
// THE RULE. A caller inside an armed <Sheet armsBack> that wants the host to navigate closes the sheet
// FIRST, waits for the sheet's own Android-Back entry to be consumed, and only THEN calls on. So the host
// may push OR replace freely in `then`: a push lands as [page, page?batch=] and a replace can take the
// entry UNDER the sheet — neither strands a dead Back entry mid-stack (the SheetRowLink hazard). If no
// Back entry was armed (flags off, no provider) `then` runs at once.
//
// `then` runs ONCE: on the popstate that consumes the entry, or on the fallback timer if nothing does.
import { readMarker } from '../../lib/backNav.js'

// How long to wait for the sheet's own Back entry to be consumed before landing anyway. The popstate
// normally arrives within a frame or two; the ceiling only matters if nothing consumes the entry.
export const LAND_FALLBACK_MS = 1000

// close first, let the sheet's own Back entry be consumed, then call `then`.
export function landAfterClose(close, then, fallbackMs = LAND_FALLBACK_MS) {
  const armed = typeof window !== 'undefined' && !!readMarker(window.history?.state)
  let done = false
  let timer = null
  const finish = () => {
    if (done) return
    done = true
    window.removeEventListener('popstate', finish)
    if (timer) clearTimeout(timer)
    then?.()
  }
  if (armed) {
    window.addEventListener('popstate', finish)
    timer = setTimeout(finish, fallbackMs)
  }
  close?.()
  if (!armed) finish()
}
