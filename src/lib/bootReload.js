// V4-COLDSTART-001 — the retry affordance for the `unknown` identity state.
//
// A FULL DOCUMENT RELOAD IS THE ONLY RETRY THAT EXISTS. IsomorphicClerk hot-loads clerk-js exactly
// once (loadClerkJS is called from its constructor path and there is no public re-load/retry API),
// and on failure it emits status 'error' and returns. Nothing short of a new document can produce
// an identity after that, so a "try again" button that did anything cleverer would be a button that
// does nothing.
//
// Its own module, following the useAppUpdate/registerSW house idiom, for two reasons: the injected
// `win` keeps it assertable without stubbing jsdom's non-configurable window.location, and it keeps
// BootSkeleton.jsx importing nothing that could reach identity.
export function reloadApp(win = typeof window !== 'undefined' ? window : null) {
  try { if (win && win.location) win.location.reload() } catch { /* noop */ }
}
