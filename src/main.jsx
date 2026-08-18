import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/react'
import App from './App.jsx'
import { registerServiceWorker } from './lib/registerSW.js'
import { requestPersistence } from './lib/durableStorage.js'
import { warmApiOrigins } from './lib/warmOrigins.js'
import { iconCssVars } from './lib/tokens.js'

const globalStyle = document.createElement('style')
globalStyle.textContent = `
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  a { color: inherit; }
  input, button, textarea, select { font: inherit; }
  /* 0px is the HONEST default: there is no bottom nav until BottomNav mounts, and it only mounts
     when signed in (App.jsx). BottomNav owns this variable and sets it to its real height in a
     layout effect — see BOTTOM_NAV_HEIGHT_PX there. Hardcoding 56px here made every bottom-anchored
     surface reserve space for a nav that wasn't rendered: on the sign-in and public-share screens a
     toast or the update banner floated ~56px above the bottom edge. */
  :root { --bottom-nav-height: 0px; }
  ${iconCssVars()}
`
document.head.appendChild(globalStyle)

// V4-PERFCLERK-001 Option A — tokenless cold-start warm-ping, FIRST network action of the boot.
// Placed here, ahead of everything else in this file, because the ~2.5s of Clerk resolution that
// follows is dead time on the network: the Lambda containers Today needs are cold and nothing has
// asked them for anything. It is synchronous, carries no token, reads no response and swallows
// every failure — see src/lib/warmOrigins.js for the measurements and the four leak invariants.
warmApiOrigins()

registerServiceWorker()

// V4-STORAGEPERSIST-001 — request persistent storage at BOOT, not from a route. The only other call
// site is FieldCapture (/field), reachable solely via the field-mode mic button, so an origin whose
// owner has never opened that route stays BEST-EFFORT — and Chrome Android evicts a best-effort
// origin WHOLESALE under disk pressure, taking the capture queue and every cached tile with it.
// Chrome Android grants this without a prompt for an installed PWA, so boot costs nothing.
// Deliberately ADDITIVE: requestPersistence() short-circuits on an already-persistent origin
// (durableStorage.js), so FieldCapture's call stays where it is rather than being moved.
requestPersistence().catch(() => {})

// beforeinstallprompt is intentionally NOT captured: no install UI consumes a
// deferred prompt, and calling preventDefault() suppressed Chrome's native
// install affordance for nothing (push-P0, 2026-07-22). If P4+ builds an
// in-app install button, capture the event there and consume it via .prompt().

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}>
      <App />
    </ClerkProvider>
  </StrictMode>
)

// V4-RIPENESSCUES-001: idle-time warm import of the lazy colour-window chunk (CropCard loads it on
// demand; see the boundary note there). Warming after boot lands the chunk in the runtime cache
// before field use — the value moment is standing at the plant, where connectivity is worst — so
// first CropCard paint usually resolves without pop-in. INERT ON FAILURE by design: offline or a
// purged old-hash chunk just rejects here, and CropCard's own .catch keeps the card windowless.
const warmHarvestWindows = () => { import('./lib/harvestWindows.js').catch(() => {}) }
if (typeof requestIdleCallback === 'function') requestIdleCallback(warmHarvestWindows, { timeout: 10000 })
else setTimeout(warmHarvestWindows, 3000)
