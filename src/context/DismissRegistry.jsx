// The shared modal registry.
//
// ONE registry owning stack order, Escape arbitration and aria-modal ownership. Sheet.jsx's
// openStack could not be it: its entries are opaque `{}` tokens carrying no onDismiss, so a global
// arbiter reading that stack cannot know what to call. Escape works there only because the handler
// is per-INSTANCE and closes over onCloseRef.
//
// Even with no Back involved it is needed: document keydowns gated on NOTHING fire every open
// surface's onClose on one Escape, and two focus traps on the same Tab keydown fight over focus()
// by listener-registration order.
//
// The popstate listener below is not gated on any platform question: this app constructs no
// CloseWatcher, registers no beforeunload, uses no native <dialog>/showModal() and no popover
// attribute — all modal surfaces are role="dialog" divs. Chrome only routes a close-request to
// CloseWatcher when one of those exists, so within this app Back can only arrive as a history
// traversal -> popstate. tests/device/GATE-A.md stays as a PROMOTE gate for what jsdom cannot
// express: Back at history index 0 in an installed PWA, predictive-back timing, edge-swipe vs
// 3-button reachability, and service-worker bundle skew.
//
// WHAT THIS DELIBERATELY DOES NOT DO:
//   - No `inert` on the app root. jsdom's inert support is reflection-level, so a test asserting
//     focus is actually blocked would FALSE-PASS. It also adds a second no-in-app-recovery failure
//     mode.
//   - No behaviour change to dirty/busy. See decideDismiss's defaults in lib/dismissLayers.js.
//
// SCROLL LOCK STAYS IN Sheet.jsx. The registry closes a surface by calling the consumer's OWN
// onDismiss, which flips the consumer's `open` state, which runs Sheet's [open] effect cleanup,
// which releases the refcounted lock. Any path that closed a Sheet by unmounting AROUND it would
// strand that lock and brick body scrolling until reload — the worst failure mode in the program.
// Going through the owner's setter is what makes that unreachable.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { resolveTopmost, decideDismiss } from '../lib/dismissLayers.js'
import {
  MARKER_KEY, MARKER_VERSION, readMarker, readAnyMarker,
  decideBack, hasArmable, MAX_CONSECUTIVE_BLOCKS,
} from '../lib/backNav.js'
import ConfirmSheet from '../components/ConfirmSheet.jsx'
import { DismissApiContext, DismissTopContext } from './dismissContext.js'

export { useDismissable, useDismissStackCount } from './dismissContext.js'

// How long a return to our marker (history.go(1), see stepBackOn) may take to land before we stop
// believing we are armed. A traversal lands in a frame or two; this only has to outlast a slow one.
const RETURN_LANDS_WITHIN_MS = 400

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

  // ─── The CONFIRM consumer branch ────────────────────────────────────────────────────────────────
  //
  // CONFIRM is neither NONE nor BLOCKED, so without this branch both switches below would fall
  // through to cbRef and dismiss silently: flipping the confirmOnDirty booleans alone changes
  // nothing on any surface, and the pure-decider tests stay green.
  //
  // PROVIDER-OWNED, not consumer-owned, for three reasons that are not style: only the arbiter can
  // see the whole stack (the confirm must outrank surfaces the consumer cannot know about); the
  // return and resolve-once bookkeeping has to sit next to armedRef/blockedRef/selfPopRef; and a
  // consumer-rendered confirm is just the per-surface window.confirm patch again, once per host.
  //
  // pendingConfirm is BOTH state (to render) and a ref (readable from the popstate listener, which
  // is bound once with [] deps and must not rebind on every keystroke).
  const [pendingConfirm, setPendingConfirm] = useState(null)
  const pendingConfirmRef = useRef(null)

  const raiseConfirm = useCallback((entry) => {
    if (pendingConfirmRef.current) return false      // one question at a time
    if (!entry) return false
    // A surface may say its question differently for the state it is in right now (confirmCopy
    // below). Read here, when the question is raised, and each word falls back to the registered
    // one, so a surface that passes none is asked exactly what it always was.
    const live = entry.copyRef?.current || null
    const next = {
      id: entry.id,
      title: live?.title ?? entry.confirmTitle, body: live?.body ?? entry.confirmBody,
      confirmLabel: live?.confirmLabel ?? null, cancelLabel: live?.cancelLabel ?? null,
    }
    pendingConfirmRef.current = next
    setPendingConfirm(next)
    return true
  }, [])

  // Resolve EXACTLY ONCE. The target is looked up by id at resolution time rather than captured:
  // if the surface unmounted while the question was up, there is nothing to dismiss and calling a
  // stale cbRef would setState into a dead tree.
  const resolveConfirm = useCallback((accepted) => {
    const p = pendingConfirmRef.current
    pendingConfirmRef.current = null
    setPendingConfirm(null)
    if (!accepted || !p) return
    entriesRef.current.find((e) => e.id === p.id)?.cbRef?.current?.()
  }, [])

  // A consumer's own labelled Close, routed through the arbiter (dismissLayers.js's header has
  // always named "a labelled Close routed here" as in scope). Without this, deleting the two shipped
  // window.confirm patches would REGRESS their X button: Escape and Back would confirm while the
  // visible Close discarded silently. Returns true only when it took ownership of the gesture; the
  // caller falls back to its own onDismiss otherwise, so this is provably inert for the 24 surfaces
  // that never opt in.
  const requestDismiss = useCallback((id) => {
    const e = entriesRef.current.find((x) => x.id === id)
    if (!e || !e.confirmOnDirty || !e.dirty) return false
    return raiseConfirm(e)
  }, [raiseConfirm])

  // THE single Escape listener. Topmost-only, exactly one dismissal per press.
  //
  // ESCAPE-VS-BACK PARITY: both gestures resolve through this registry: Escape via decideDismiss
  // below, Back via decideBack in the popstate listener further down. They pick the same target by
  // construction, pinned by the parity assertion in BackNav.history.test.jsx.
  //
  // The ONE deliberate divergence: a kind:'route' overlay. Escape closes it (decideDismiss does not
  // consult kind) while Back returns NONE and lets the router own it — the router already holds a
  // real history entry for that surface, so arming a second one would produce two adjacent entries
  // for the same URL and a Back that visibly does nothing.
  useEffect(() => {
    if (typeof document === 'undefined') return
    function onKey(e) {
      if (e.key !== 'Escape') return
      // A DESCENDANT ALREADY CONSUMED THIS KEY. React 18 delegates synthetic handlers to the root
      // container, which is a descendant of `document`, so a surface that handles Escape for its
      // own sub-state still lets the event reach us. Without this guard one Escape does two things:
      // VarietyPicker steps its create stage back (preventDefault, no stopPropagation) AND we
      // close the Sheet it is sitting in. DismissDefaultPrevented.test.jsx pins it and fails
      // without this line.
      //
      // defaultPrevented is the right signal rather than a registry field: it covers descendants
      // nobody has enumerated, it is what "I handled this" already means in the DOM, and it costs
      // one comparison. Call sites should ALSO stopPropagation — that is belt and braces, but this
      // is what makes the class unreachable. Deliberately AFTER the key check so an unrelated
      // preventDefault on some other key can never make Escape inert.
      if (e.defaultPrevented) return
      const d = decideDismiss(entries, { blockOnBusy: true, confirmOnDirty: true })
      if (d.action === 'NONE') return          // nothing registered — let the event through
      // BLOCKED: a write is in flight. Swallow the key rather than discarding the surface. It is
      // the only way to register the two surfaces that ALREADY hand-roll this guard
      // (SpaceAttachPicker suppresses Escape while saving; FacebookShareSheet disables its Close
      // while posting — the one surface with a non-idempotent in-flight action) without
      // regressing them. It is inert for every surface that does not set `busy`.
      e.preventDefault()
      if (d.action === 'BLOCKED') return
      // CONFIRM: ask instead of discarding. No marker bookkeeping on this path — Escape consumes no
      // history entry, so the surface underneath keeps whatever it armed.
      if (d.action === 'CONFIRM') { raiseConfirm(d.target); return }
      d.target.cbRef?.current?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [entries, raiseConfirm])

  // ─── The system Back, arbitrated by THIS registry ──────────────────────────────────────────────
  //
  // ONE provider-owned marker for the whole modal session, not one per surface. Per-surface arming
  // had a case it could not fix: if a LOWER surface closed first, its entry was stranded MID-STACK
  // and no browser API can remove it — permanently consuming a Back. With one marker there is no
  // per-surface entry to strand. It also cuts history churn from O(modal depth) to O(1).
  const armedRef = useRef(null)      // seq of the marker we pushed, or null
  const markerSeqRef = useRef(0)
  const selfPopRef = useRef(false)   // set while WE call back(), to swallow the resulting popstate
  const blockedRef = useRef(0)       // consecutive BLOCKED refusals (bounded — see MAX_CONSECUTIVE_BLOCKS)
  const returningRef = useRef(null)  // { seq, at } while a return to our marker is in flight (stepBackOn)

  // Scalar, NOT the entries array. Keying the arm effect on the array would push/pop history on
  // every keystroke that flips `dirty` — far worse than a render loop. Depth is handled by the
  // return to the marker inside the popstate handler (stepBackOn), not by this effect.
  const armable = hasArmable(entries)

  const arm = useCallback(() => {
    if (armedRef.current != null) return                   // never two markers
    if (typeof window === 'undefined' || !window.history) return
    const seq = ++markerSeqRef.current
    // MERGE, never replace. react-router owns {usr, key, idx} and its own source warns that writing
    // state directly "will result in bugs"; clobbering `idx` desyncs the router's index from the
    // real stack. Replacing wholesale destroys `background`, which unmounts a route overlay.
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

  // STAND ON OUR MARKER AGAIN WITHOUT CREATING AN ENTRY.
  //
  // A Back we answer without closing everything (a refusal while busy, the discard question, a
  // panel stepping back, the top of a stack closing) leaves a surface open, so the next Back must
  // be ours too. Re-arming from inside the popstate handler would be a pushState with no tap behind
  // it: Chrome on Android marks an entry made that way "skip on the Back button", and a Back press
  // itself clears whatever tap came before it, so the SECOND Back, with no touch between, would
  // have nowhere to go and would close the installed app.
  //
  // So the entry that Back consumed, still there one step FORWARD, is reused. A traversal the page
  // makes creates nothing, needs no tap and is never skipped. NEVER pushState inside onPop.
  //
  // The landing is one more popstate, and it needs no flag of its own: armedRef is set to the marker's
  // seq before we leave, so onPop's "still standing on ours" line swallows it.
  const stepBackOn = useCallback((seq) => {
    if (typeof window === 'undefined' || !window.history) return
    armedRef.current = seq
    const mine = { seq, at: Date.now() }
    returningRef.current = mine
    window.history.go(1)
    // A return that never lands (a push in the same tick cut the forward entry off) must not leave us
    // believing we are armed. Compared by identity, not seq: two refusals in a row return to the SAME
    // seq, and the first one's timer must not close the second one's window.
    setTimeout(() => {
      if (returningRef.current !== mine) return
      returningRef.current = null
      if (typeof window === 'undefined' || !window.history) return
      if (readMarker(window.history.state)?.seq !== seq && armedRef.current === seq) armedRef.current = null
    }, RETURN_LANDS_WITHIN_MS)
  }, [])

  // BOOT RECONCILIATION. `location.reload()` PRESERVES history.state, and registerSW's
  // controllerchange→reload fires with NO user action on a post-deploy resume. After that reload
  // React state is gone (nothing registered) but our marker is still the current entry AND still
  // validates, because the same bundle wrote it. Without this, the first Back after any auto-reload
  // is eaten by a dead entry. Strip it with replaceState — never back(), which would walk the user
  // off the page they just loaded.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.history) return
    const stale = readAnyMarker(window.history.state)
    if (!stale) return
    const { [MARKER_KEY]: _drop, ...rest } = window.history.state || {}
    window.history.replaceState(rest, '')
  }, [])

  useEffect(() => {
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
    if (typeof window === 'undefined') return
    function onPop() {
      if (selfPopRef.current) { selfPopRef.current = false; return }
      const cur = readMarker(window.history.state)
      if (armedRef.current == null) {
        if (!cur) return                            // not ours — the router or the app owns this Back
        // ORPHAN STEP-OFF — boot reconciliation's runtime twin. We are standing on a marker nobody
        // holds: a return that landed after its sheet had closed in the meantime (disarm() found no
        // marker under it and popped nothing). Left alone it is a dead press on the next Back. If
        // something armable is open after all, the marker is exactly what it needs: adopt it.
        returningRef.current = null
        if (hasArmable(entriesRef.current)) { armedRef.current = cur.seq; return }
        selfPopRef.current = true
        window.history.back()
        return
      }
      // Still standing on ours: not our gesture. This is also where a return LANDS.
      if (cur && cur.seq === armedRef.current) { returningRef.current = null; return }
      // A RETURN IN FLIGHT LANDED SOMEWHERE ELSE. We called go(1) and, before it landed, something
      // else traversed: a second Back racing the return. That press has already navigated; it must
      // not ALSO dismiss, or two fast presses would close two surfaces (or discard past a refusal).
      // Unarm and decide nothing. A record for a marker we no longer hold is stale, not a return.
      const returning = returningRef.current
      returningRef.current = null
      if (returning && returning.seq === armedRef.current) { armedRef.current = null; return }
      const seq = armedRef.current
      armedRef.current = null                       // our marker was just consumed

      const d = decideBack(entriesRef.current, { blockOnBusy: true, confirmOnDirty: true })
      if (d.action === 'NONE') return

      if (d.action === 'BLOCKED') {
        // Refuse by RETURNING to the marker — the only way to "cancel" a non-cancelable popstate
        // without creating an entry (see stepBackOn). BOUNDED: after MAX_CONSECUTIVE_BLOCKS the Back
        // is allowed through undismissed, because a `busy` that never clears would otherwise make
        // Back stop exiting the app entirely.
        if (blockedRef.current < MAX_CONSECUTIVE_BLOCKS) { blockedRef.current += 1; stepBackOn(seq) }
        else blockedRef.current = 0
        return
      }
      blockedRef.current = 0

      // CONFIRM — the return is the point.
      //
      // The Back already consumed our marker, and the surface is NOT closing, so without the return
      // here the dirty sheet is left with no marker and the user's SECOND Back exits the installed
      // PWA with a half-filled form still on screen. Same shape as the BLOCKED branch, minus the
      // bound: a confirm is a question the user answers, not a refusal that could loop forever.
      // Return unconditionally, even in the (unreachable — ConfirmSheet outranks everything) case
      // where a question is already up, so no path can fall through and discard the surface.
      if (d.action === 'CONFIRM') {
        raiseConfirm(d.target)
        stepBackOn(seq)
        return
      }

      if (d.action === 'INTERCEPT') {
        // Call FIRST, return only on success. Standing on the marker before the call and leaving it
        // there on decline left a dead press on the next Back. The intercept is synchronous, so
        // there is no window in which we are unarmed while still open.
        if (d.target.interceptRef?.current?.()) { stepBackOn(seq); return }
        // Declined — fall through and dismiss.
      }

      d.target.cbRef?.current?.()
      // RETURN for the surfaces still open. This is what makes stacked modals work: `armable` never
      // went false, so the arm effect will not re-run, and without this the SECOND Back would have
      // no marker and would exit the installed PWA with a sheet still open.
      if (hasArmable(entriesRef.current.filter((e) => e !== d.target))) stepBackOn(seq)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [stepBackOn, raiseConfirm])

  // Stable for the life of the provider — never re-runs a consumer's registration effect.
  const api = useMemo(
    () => ({ register, unregister, update, requestDismiss }),
    [register, unregister, update, requestDismiss],
  )
  const top = useMemo(() => ({ topmostId, count: entries.length }), [topmostId, entries.length])

  return (
    <DismissApiContext.Provider value={api}>
      <DismissTopContext.Provider value={top}>
        {children}
        {/* INSIDE both providers, so it registers in the same stack it is arbitrating, and AFTER
            children so the equal-layer tiebreak is never load-bearing (SYSTEM already outranks
            every other layer). Mounted at the app root, so it paints above every route. */}
        <ConfirmSheet
          open={!!pendingConfirm}
          title={pendingConfirm?.title || undefined}
          body={pendingConfirm?.body || undefined}
          confirmLabel={pendingConfirm?.confirmLabel || undefined}
          cancelLabel={pendingConfirm?.cancelLabel || undefined}
          onConfirm={() => resolveConfirm(true)}
          onCancel={() => resolveConfirm(false)}
        />
      </DismissTopContext.Provider>
    </DismissApiContext.Provider>
  )
}
