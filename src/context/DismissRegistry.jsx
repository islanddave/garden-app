// V4-BACKNAV-001 Slice 1 — the shared modal registry (decision V200 §3).
//
// ONE registry owning stack order, Escape arbitration and aria-modal ownership. The crucible's Q1
// answer: the question was never "global popstate arbiter vs per-surface handling" — it was "what is
// the shared registry". Sheet.jsx's openStack could not be it: its entries are opaque `{}` tokens
// carrying no onDismiss, so a global arbiter reading that stack literally cannot know what to call.
// Escape works there only because the handler is per-INSTANCE and closes over onCloseRef.
//
// WHAT THIS REPAIRS TODAY, with no Back involved: Lightbox.jsx binds a document keydown gated on
// NOTHING, so with PlantingDetail's Details Sheet open under a Lightbox one Escape fires BOTH
// onCloses. Same for CritterFactsPopover. Two focus traps also run on the same Tab keydown and
// whichever calls focus() last wins by listener-registration order. That is why Slice 1 is worth
// shipping even if back-nav is dropped entirely.
//
// WHAT THIS DELIBERATELY DOES NOT DO (yet):
//   - No popstate/history listener. That is Slice 3, gated on GATE-A (the device probe), because
//     whether Android delivers Back as a history traversal or as a CloseWatcher close-request is an
//     unverified platform claim and must not become load-bearing before it is tested on the device.
//   - No `inert` on the app root. jsdom's inert support is reflection-level, so a test asserting
//     focus is actually blocked would FALSE-PASS — the exact class the verification plan exists to
//     catch. It also adds a second no-in-app-recovery failure mode. Deferred with the confirm slice.
//   - No behaviour change to dirty/busy. See decideDismiss's defaults in lib/dismissLayers.js.
//
// SCROLL LOCK STAYS IN Sheet.jsx. The registry closes a surface by calling the consumer's OWN
// onDismiss, which flips the consumer's `open` state, which runs Sheet's [open] effect cleanup,
// which releases the refcounted lock. Any path that closed a Sheet by unmounting AROUND it would
// strand that lock and brick body scrolling until reload — the worst failure mode in the program.
// Going through the owner's setter is what makes that unreachable.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { LAYER, resolveTopmost } from '../lib/dismissLayers.js'
import { DISMISS_REGISTRY_ENABLED } from '../lib/featureFlags.js'

// TWO contexts, deliberately. The API context holds register/unregister/update, all of which are
// useCallback([]) — so its identity is stable FOREVER. The value context holds topmostId, which
// changes on every push/pop.
//
// They cannot be one object. A single context value carrying both would change identity whenever
// topmostId changed; useDismissable's registration effect depends on the API, so it would tear down
// and re-register on every stack change — which itself changes the stack. That is an infinite
// render loop, and it is not theoretical: the first cut of this file shipped it and hung the test
// run with zero output. Splitting the stable API from the reactive value is what breaks the cycle.
const DismissApiContext = createContext(null)
const DismissTopContext = createContext(null)

export function DismissRegistryProvider({ children }) {
  // Entries are React state (not a ref) because `isTopmost` must be reactive — Sheet and Lightbox
  // read it to decide aria-modal ownership and whether their own key handlers may act.
  const [entries, setEntries] = useState([])
  const seqRef = useRef(0)

  const register = useCallback((rec) => {
    const seq = ++seqRef.current
    const id = 'dsm-' + seq
    // The entry carries a REF to the callback, never the callback itself: consumers pass inline
    // closures recreated every render, and storing those in state would re-render every open modal
    // on every keystroke in a form.
    setEntries((es) => [...es, { ...rec, id, seq }])
    return id
  }, [])

  const unregister = useCallback((id) => {
    setEntries((es) => es.filter((e) => e.id !== id))
  }, [])

  const update = useCallback((id, patch) => {
    setEntries((es) => {
      let changed = false
      const next = es.map((e) => {
        if (e.id !== id) return e
        for (const k of Object.keys(patch)) if (e[k] !== patch[k]) changed = true
        return changed ? { ...e, ...patch } : e
      })
      return changed ? next : es   // identity-stable when nothing moved: no wasted render
    })
  }, [])

  const topmost = resolveTopmost(entries)
  const topmostId = topmost ? topmost.id : null

  // THE single Escape listener. Topmost-only, exactly one dismissal per press — which is also the
  // answer to the spec's open "Escape-vs-Back parity" question: Back will route through this same
  // resolution path with a different trigger, so the two cannot drift.
  useEffect(() => {
    if (!DISMISS_REGISTRY_ENABLED) return
    if (typeof document === 'undefined') return
    function onKey(e) {
      if (e.key !== 'Escape') return
      const target = resolveTopmost(entries)
      if (!target) return                      // nothing registered — let the event through
      e.preventDefault()
      target.cbRef?.current?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [entries])

  // Stable for the life of the provider — never re-runs a consumer's registration effect.
  const api = useMemo(() => ({ register, unregister, update }), [register, unregister, update])
  const top = useMemo(() => ({ topmostId, count: entries.length }), [topmostId, entries.length])

  return (
    <DismissApiContext.Provider value={api}>
      <DismissTopContext.Provider value={top}>{children}</DismissTopContext.Provider>
    </DismissApiContext.Provider>
  )
}

// Register a dismissable surface. Returns:
//   registered — true only when the flag is ON *and* a provider is present. Consumers key their
//                LEGACY per-instance Escape handler on `!registered`, so this hook is safe in
//                isolated unit tests that render a Sheet with no provider (registered=false → the
//                component behaves byte-identically to before this slice).
//   isTopmost  — drives aria-modal ownership and arrow-key gating. Defaults TRUE when unregistered,
//                again so the un-provided case is unchanged.
export function useDismissable({ open, onDismiss, dirty = false, busy = false, layer = LAYER.SHEET } = {}) {
  const api = useContext(DismissApiContext)
  const top = useContext(DismissTopContext)
  const active = !!(DISMISS_REGISTRY_ENABLED && api && open)

  const cbRef = useRef(onDismiss)
  useEffect(() => { cbRef.current = onDismiss }, [onDismiss])

  const [id, setId] = useState(null)
  useEffect(() => {
    if (!active) { setId(null); return }
    const newId = api.register({ layer, cbRef, dirty: !!dirty, busy: !!busy })
    setId(newId)
    return () => { api.unregister(newId); setId(null) }
    // `api` is identity-stable (see the two-context note above), so this effect keys only on
    // active/layer. dirty/busy are intentionally excluded and pushed via update() below: making
    // them deps would unregister and re-register on every keystroke, reordering the stack
    // mid-interaction so a typing user's sheet would silently become "topmost" over a dialog.
  }, [active, api, layer])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active || !id) return
    api.update(id, { dirty: !!dirty, busy: !!busy })
  }, [active, api, id, dirty, busy])

  const registered = active && !!id
  return {
    registered,
    isTopmost: registered ? top?.topmostId === id : true,
  }
}

// Test/diagnostic read of the live stack depth. Not used by production code paths.
export function useDismissStackCount() {
  const top = useContext(DismissTopContext)
  return top ? top.count : 0
}
