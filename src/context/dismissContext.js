// The dismiss registry's two contexts and the hooks that read them. Split out of DismissRegistry.jsx
// so ConfirmSheet (which the provider renders) can call useDismissable without importing the
// provider back: provider -> ConfirmSheet -> this file is a line, not a cycle. DismissRegistry.jsx
// re-exports the hooks, so every other importer keeps its path.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { LAYER } from '../lib/dismissLayers.js'
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
export const DismissApiContext = createContext(null)
export const DismissTopContext = createContext(null)

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
  // BUG-DIRTYDISMISSGAP-001 — the per-surface CONFIRM opt-in, and three more registration-time
  // constants. DEFAULT FALSE for the same reason armsBack is: Sheet calls this hook once for all 18
  // of its render sites, so a default of true would silently enrol every one of them, including the
  // three overlay routes whose content already survives a dismiss via a real draft stash.
  //
  // SCALARS, NOT A COPY OBJECT. These are effect deps (registration-time constants, unlike
  // dirty/busy), and an inline `confirmCopy={{...}}` literal has a fresh identity every render — it
  // would unregister and re-register on every keystroke, reordering the stack mid-typing. That is
  // exactly the failure the dirty/busy exclusion below exists to prevent, so the copy travels as
  // strings, which compare by value.
  confirmOnDirty = false, confirmTitle = null, confirmBody = null,
  // confirmCopy (V5-SEEDLOTADDITION-001): the question's words for the state the surface is in RIGHT
  //   NOW, when they differ from the registered ones: { title, body, confirmLabel, cancelLabel }, any
  //   of them, or null. Read through a REF when the question is raised, never registered and never
  //   pushed through update(), for backIntercept's reason: an inline literal is new every render, and
  //   as a dep it would unregister and re-register the surface (and re-arm its Back entry) each time
  //   its state moved. Whether a question is asked at all is still `dirty` and `confirmOnDirty`.
  confirmCopy = null,
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
  const copyRef = useRef(confirmCopy)
  useEffect(() => { copyRef.current = confirmCopy }, [confirmCopy])

  const canIntercept = !!backIntercept

  const [id, setId] = useState(null)
  // Mirrored synchronously so requestDismiss below can read it from an event handler without a
  // render's lag and without becoming an unstable callback.
  const idRef = useRef(null)
  useEffect(() => {
    if (!active) { setId(null); idRef.current = null; return }
    const newId = api.register({
      layer, cbRef, dirty: !!dirty, busy: !!busy,
      kind, armsBack: !!armsBack, interceptRef, canIntercept: !!canIntercept,
      confirmOnDirty: !!confirmOnDirty, confirmTitle, confirmBody, copyRef,
    })
    setId(newId)
    idRef.current = newId
    return () => { api.unregister(newId); setId(null); idRef.current = null }
    // `api` is identity-stable (see the two-context note above), so this effect keys only on
    // active/layer. dirty/busy are intentionally excluded and pushed via update() below: making
    // them deps would unregister and re-register on every keystroke, reordering the stack
    // mid-interaction so a typing user's sheet would silently become "topmost" over a dialog.
  }, [active, api, layer, kind, armsBack, confirmOnDirty, confirmTitle, confirmBody])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active || !id) return
    api.update(id, { dirty: !!dirty, busy: !!busy, canIntercept: !!canIntercept })
  }, [active, api, id, dirty, busy, canIntercept])

  // A consumer's own labelled Close/Cancel control, arbitrated. Escape and Back already route
  // through the provider; a Close button that called onDismiss directly would be the one gesture
  // that bypassed the confirm, which is a data-loss hole rather than an inconsistency. Identity is
  // stable (it reads idRef/cbRef, never `id`/`onDismiss`), so it is safe in a consumer's deps.
  // Falls back to onDismiss whenever the provider declines ownership — so for the surfaces that
  // never opt in, and for an unprovided/flag-off render, this is byte-identical to calling onDismiss.
  const requestDismiss = useCallback(() => {
    const cur = idRef.current
    if (cur && api?.requestDismiss?.(cur)) return
    cbRef.current?.()
  }, [api])

  const registered = active && !!id
  return {
    registered,
    isTopmost: registered ? top?.topmostId === id : true,
    requestDismiss,
  }
}

// Test/diagnostic read of the live stack depth. Not used by production code paths.
export function useDismissStackCount() {
  const top = useContext(DismissTopContext)
  return top ? top.count : 0
}
