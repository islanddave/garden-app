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
//   - [SUPERSEDED 2026-08-06 by Slice 3a] This block used to say the popstate listener was gated on
//     GATE-A because "whether Android delivers Back as a history traversal or as a CloseWatcher
//     close-request is an unverified platform claim". That specific question was RESOLVED FROM
//     SOURCE, not deferred: this app constructs no CloseWatcher, registers no beforeunload, uses no
//     native <dialog>/showModal() and no popover attribute — all modal surfaces are role="dialog"
//     divs. Chrome only routes a close-request to CloseWatcher when one of those exists, so within
//     this app Back can only arrive as a history traversal -> popstate. The listener now lives
//     below. GATE-A survives as a PROMOTE gate (tests/device/GATE-A.md) covering the four things
//     jsdom structurally cannot express: Back at history index 0 in an installed PWA, predictive-
//     back timing, edge-swipe vs 3-button reachability, and service-worker bundle skew.
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
import { LAYER, resolveTopmost, decideDismiss } from '../lib/dismissLayers.js'
import { DISMISS_REGISTRY_ENABLED, BACKNAV_ENABLED } from '../lib/featureFlags.js'
import {
  MARKER_KEY, MARKER_VERSION, readMarker, readAnyMarker,
  decideBack, hasArmable, MAX_CONSECUTIVE_BLOCKS,
} from '../lib/backNav.js'

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

  // Latest entries, readable from the popstate listener WITHOUT making `entries` a dep of it.
  // Assigned in an effect, never during render: a ref written during a render React discards would
  // leave a stale or future value under concurrent rendering.
  const entriesRef = useRef(entries)
  useEffect(() => { entriesRef.current = entries }, [entries])

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

  // THE single Escape listener. Topmost-only, exactly one dismissal per press.
  //
  // ESCAPE-VS-BACK PARITY IS ACHIEVED AS OF SLICE 3a (2026-08-06). Both gestures now resolve
  // through this registry: Escape via decideDismiss below, Back via decideBack in the popstate
  // listener further down. They pick the same target by construction, pinned by the parity
  // assertion in BackNav.history.test.jsx.
  //
  // The ONE deliberate divergence: a kind:'route' overlay. Escape closes it (decideDismiss does not
  // consult kind) while Back returns NONE and lets the router own it — the router already holds a
  // real history entry for that surface, so arming a second one would produce two adjacent entries
  // for the same URL and a Back that visibly does nothing.
  useEffect(() => {
    if (!DISMISS_REGISTRY_ENABLED) return
    if (typeof document === 'undefined') return
    function onKey(e) {
      if (e.key !== 'Escape') return
      // A DESCENDANT ALREADY CONSUMED THIS KEY. React 18 delegates synthetic handlers to the root
      // container, which is a descendant of `document`, so a surface that handles Escape for its
      // own sub-state still lets the event reach us. Without this guard one Escape does two things:
      // VarietyPicker steps its create stage back (VarietyPicker.jsx:293/304/322 — all
      // preventDefault, none stopPropagation) AND we close the Sheet it is sitting in. That was
      // live in v3.103.0; DismissDefaultPrevented.test.jsx pins it and fails without this line.
      //
      // defaultPrevented is the right signal rather than a registry field: it covers descendants
      // nobody has enumerated, it is what "I handled this" already means in the DOM, and it costs
      // one comparison. Call sites should ALSO stopPropagation — that is belt and braces, but this
      // is what makes the class unreachable. Deliberately AFTER the key check so an unrelated
      // preventDefault on some other key can never make Escape inert.
      if (e.defaultPrevented) return
      const d = decideDismiss(entries, { blockOnBusy: true })
      if (d.action === 'NONE') return          // nothing registered — let the event through
      // BLOCKED: a write is in flight. Swallow the key rather than discarding the surface. Enabled
      // in Slice 2 because it is the only way to register the two surfaces that ALREADY hand-rolled
      // this guard (SpaceAttachPicker suppresses Escape while saving; FacebookShareSheet disables
      // its Close while posting — the one surface in the app with a non-idempotent in-flight
      // action) without regressing them. It is inert for every surface that does not set `busy`,
      // which is all the rest, so turning it on is not a blanket behaviour change.
      e.preventDefault()
      if (d.action === 'BLOCKED') return
      d.target.cbRef?.current?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [entries])

  // ─── V4-BACKNAV-001 Slice 3a — the system Back, arbitrated by THIS registry ────────────────────
  //
  // ONE provider-owned marker for the whole modal session, not one per surface. Per-surface arming
  // had a case it could not fix: if a LOWER surface closed first, its entry was stranded MID-STACK
  // and no browser API can remove it — permanently consuming a Back. With one marker there is no
  // per-surface entry to strand. It also cuts history churn from O(modal depth) to O(1).
  const armedRef = useRef(null)      // seq of the marker we pushed, or null
  const markerSeqRef = useRef(0)
  const selfPopRef = useRef(false)   // set while WE call back(), to swallow the resulting popstate
  const blockedRef = useRef(0)       // consecutive BLOCKED refusals (bounded — see MAX_CONSECUTIVE_BLOCKS)

  // Scalar, NOT the entries array. Keying the arm effect on the array would push/pop history on
  // every keystroke that flips `dirty` — far worse than a render loop. Depth is handled by the
  // re-arm inside the popstate handler, not by this effect.
  const armable = hasArmable(entries)

  const arm = useCallback(() => {
    if (armedRef.current != null) return                   // never two markers
    if (typeof window === 'undefined' || !window.history) return
    const seq = ++markerSeqRef.current
    // MERGE, never replace. react-router owns {usr, key, idx} and its own source warns that writing
    // state directly "will result in bugs"; clobbering `idx` desyncs the router's index from the
    // real stack. Replacing wholesale already shipped one real bug here (LogMany: destroyed
    // `background`, unmounted the overlay, made Undo unreachable for a batch already in the DB).
    window.history.pushState({ ...(window.history.state || {}), [MARKER_KEY]: { v: MARKER_VERSION, seq } }, '')
    armedRef.current = seq
  }, [])

  const disarm = useCallback(() => {
    const seq = armedRef.current
    armedRef.current = null
    blockedRef.current = 0
    if (seq == null) return
    if (typeof window === 'undefined' || !window.history) return
    // GUARDED on the marker still being CURRENT — this guard is ported verbatim from the deleted
    // useBackDismiss, and porting it is not optional. react-router's `replace: true` writes a FRESH
    // {usr, key, idx}; it does NOT merge unrelated top-level keys, so any replace-navigation while
    // armed silently DELETES our marker. Ten such call sites exist. Calling back() unguarded would
    // then walk the user backward off the page they were on.
    const cur = readMarker(window.history.state)
    if (cur && cur.seq === seq) {
      selfPopRef.current = true
      window.history.back()
    }
  }, [])

  // BOOT RECONCILIATION. `location.reload()` PRESERVES history.state, and registerSW's
  // controllerchange→reload fires with NO user action on a post-deploy resume. After that reload
  // React state is gone (nothing registered) but our marker is still the current entry AND still
  // validates, because the same bundle wrote it. Without this, the first Back after any auto-reload
  // is eaten by a dead entry. Strip it with replaceState — never back(), which would walk the user
  // off the page they just loaded.
  useEffect(() => {
    if (!BACKNAV_ENABLED || !DISMISS_REGISTRY_ENABLED) return
    if (typeof window === 'undefined' || !window.history) return
    const stale = readAnyMarker(window.history.state)
    if (!stale) return
    const { [MARKER_KEY]: _drop, ...rest } = window.history.state || {}
    window.history.replaceState(rest, '')
  }, [])

  useEffect(() => {
    if (!BACKNAV_ENABLED || !DISMISS_REGISTRY_ENABLED) return
    if (!armable) return
    arm()
    return () => disarm()
  }, [armable, arm, disarm])

  // THE single popstate listener. Bound ONCE ([] deps) reading entriesRef, so it never rebinds on a
  // keystroke.
  //
  // useEffect, NEVER useLayoutEffect. BrowserRouter binds its own popstate handler in a
  // useLayoutEffect, and React runs ALL layout effects in a commit before ANY passive effect — so a
  // passive-effect listener registers AFTER the router regardless of nesting, and the router has
  // already committed its navigation by the time we run. Switching this to useLayoutEffect would
  // invert that and let us act on a tree the router has not yet updated.
  useEffect(() => {
    if (!BACKNAV_ENABLED || !DISMISS_REGISTRY_ENABLED) return
    if (typeof window === 'undefined') return
    function onPop() {
      if (selfPopRef.current) { selfPopRef.current = false; return }
      if (armedRef.current == null) return          // not ours — the router or the app owns this Back
      const cur = readMarker(window.history.state)
      if (cur && cur.seq === armedRef.current) return  // still standing on ours: not our gesture
      armedRef.current = null                       // our marker was just consumed

      const d = decideBack(entriesRef.current, { blockOnBusy: true })
      if (d.action === 'NONE') return

      if (d.action === 'BLOCKED') {
        // Refuse by re-pushing — the only way to "cancel" a non-cancelable popstate. BOUNDED: after
        // MAX_CONSECUTIVE_BLOCKS the Back is allowed through undismissed, because a `busy` that
        // never clears would otherwise make Back stop exiting the app entirely.
        if (blockedRef.current < MAX_CONSECUTIVE_BLOCKS) { blockedRef.current += 1; arm() }
        else blockedRef.current = 0
        return
      }
      blockedRef.current = 0

      if (d.action === 'INTERCEPT') {
        // Call FIRST, arm only on success. Arming before and un-setting the ref on decline left the
        // pushed entry stranded on the stack — a dead press on the next Back. The intercept is
        // synchronous, so there is no window in which we are unarmed while still open.
        if (d.target.interceptRef?.current?.()) { arm(); return }
        // Declined — fall through and dismiss.
      }

      d.target.cbRef?.current?.()
      // RE-ARM for the surfaces still open. This is what makes stacked modals work: `armable` never
      // went false, so the arm effect will not re-run, and without this the SECOND Back would have
      // no marker and would exit the installed PWA with a sheet still open.
      if (hasArmable(entriesRef.current.filter((e) => e !== d.target))) arm()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [arm])

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
export function useDismissable({
  open, onDismiss, dirty = false, busy = false, layer = LAYER.SHEET,
  // V4-BACKNAV-001 Slice 3a. Both are registration-time constants and therefore safe effect deps.
  //
  // kind: 'route' marks a surface the ROUTER owns (App.jsx's OverlayHost). Back must fall through
  //   to the router for those; Escape still closes them. See decideBack.
  // armsBack: DEFAULT FALSE. Registry membership does not imply Back membership — Sheet calls this
  //   hook once for all 9 <Sheet> render sites, so a default of true would silently enrol
  //   BottomNav's two navigating sheets on the app's most frequent path.
  kind = 'modal', armsBack = false,
  // backIntercept: the topmost surface handling this Back ITSELF (a sub-state step-back) instead of
  //   being dismissed. Read through a REF, never pushed through update(): update()'s shallow
  //   compare is true on every render for an inline closure, which would produce a new entries
  //   array every render and rebind the Escape listener on every keystroke — precisely the failure
  //   the two-context split above exists to prevent. Only the BOOLEAN canIntercept goes into state,
  //   so the pure decider stays exhaustively testable.
  backIntercept = null,
} = {}) {
  const api = useContext(DismissApiContext)
  const top = useContext(DismissTopContext)
  const active = !!(DISMISS_REGISTRY_ENABLED && api && open)

  const cbRef = useRef(onDismiss)
  useEffect(() => { cbRef.current = onDismiss }, [onDismiss])
  const interceptRef = useRef(backIntercept)
  useEffect(() => { interceptRef.current = backIntercept }, [backIntercept])

  const canIntercept = !!backIntercept

  const [id, setId] = useState(null)
  useEffect(() => {
    if (!active) { setId(null); return }
    const newId = api.register({
      layer, cbRef, dirty: !!dirty, busy: !!busy,
      kind, armsBack: !!armsBack, interceptRef, canIntercept: !!canIntercept,
    })
    setId(newId)
    return () => { api.unregister(newId); setId(null) }
    // `api` is identity-stable (see the two-context note above), so this effect keys only on
    // active/layer. dirty/busy are intentionally excluded and pushed via update() below: making
    // them deps would unregister and re-register on every keystroke, reordering the stack
    // mid-interaction so a typing user's sheet would silently become "topmost" over a dialog.
  }, [active, api, layer, kind, armsBack])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active || !id) return
    api.update(id, { dirty: !!dirty, busy: !!busy, canIntercept: !!canIntercept })
  }, [active, api, id, dirty, busy, canIntercept])

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
