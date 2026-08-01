import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/react'
import App from './App.jsx'
import { registerServiceWorker } from './lib/registerSW.js'
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

registerServiceWorker()

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
