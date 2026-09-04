// src/components/forms/SourcePicker.jsx
// V4-SOURCEREG-001 (+ V5-SOURCEKIND-001 for the kind mint) — THE shared provenance picker.
//
// It exists because no component in the app did both halves of what this field needs. Two were
// joined rather than one copied:
//   1. PlantingSelect.jsx — the app's WAI-ARIA 1.2 combobox REFERENCE MODEL (its own header, :22).
//      Type-ahead, option identity, aria-activedescendant, measured flip placement, the registry
//      dismissal, the ⌨/🎤/✕ cluster. It has NO create path.
//   2. VarietyEditor's CropTypeField (:176, itself modelled on PutUp's StorageField) — the house
//      pattern for an inline mint beside a Select. It has NO type-ahead.
// The staged in-panel shape of the create path (footer row -> mint form -> steer-to-existing) comes
// from VarietyPicker.jsx:624-808. What is deliberately NOT taken from VarietyPicker is its
// `aria-selected`: it sets false on every row and uses it as a highlight flag. Here, as in
// PlantingSelect, aria-selected means SELECTED (the committed value) and the active row is carried
// by aria-activedescendant.
//
// ONE PICKER, TWO AXES. `plants` and `inventory_items` each carry `source_id` (the ORIGINATOR — who
// grew, bred, packed or gave it) and `acquired_from_source_id` (the SHOP or venue where it changed
// hands, set only when it DIFFERS). Both are FKs to the same `public.source` table, so one
// component serves both and the axis is carried by `label` — which is why `label` drives the
// accessible NAME of the field and nothing else. NULL on the second column means "not recorded or
// not distinct", never "same as the first".
//
// Nothing about keyboard mode, voice, or matching is re-rolled here: all of it comes from
// lib/comboboxInput.js, the homogenization seam (Dave, prod smoke 2026-08-03: "It should act the
// same on every place where I can pick a planting unless we've carved out an exception …
// propagate that everywhere … where there is a type ahead or a type search in addition to a
// chooser"). A new picker that re-derived any of it IS the drift that module exists to prevent.
//
// Prop defaults follow the MAJORITY call site so a dropped prop is a visible diff — the stated
// convention in PlantingSelect.jsx:12.
import React, { useState, useEffect, useMemo, useRef, useCallback, useId } from 'react'
import { P } from '../../lib/constants.js'
import { T, inputChrome } from './formStyles.js'
import { useHandedness } from '../../hooks/useHandedness.js'
import { useInOverlaySurface } from '../../context/OverlayContext.jsx'
import { useDismissable } from '../../context/DismissRegistry.jsx'
import { LAYER } from '../../lib/dismissLayers.js'
import { useSources, useSourceKinds } from '../../hooks/useSources.js'
import Icon from '../Icon.jsx'
import Field from './Field.jsx'
import Input from './Input.jsx'
import Select from './Select.jsx'
import Button from './Button.jsx'
import {
  useComboboxInput, looseKey, looseIncludes,
  kbToggleBtnStyle, micToggleBtnStyle, closeToggleBtnStyle, toggleSlotsPaddingStyle,
} from '../../lib/comboboxInput.js'
// The geometry is IMPORTED, not re-derived. computePlacement is the one piece of picker layout that
// can be verified without a layout engine, it is already exported for exactly that reason, and a
// second copy of the flip arithmetic would be free to disagree with the reference model's after the
// next viewport fix. Same for the chrome insets it subtracts.
import { computePlacement, readChromeInsets } from './PlantingSelect.jsx'

// VarietyPicker precedent: cap VISIBLY (footer row), never truncate silently. 54 live sources today,
// so this is headroom rather than a limit anyone meets.
const MAX_RESULTS = 200
const LIST_MAX_H = 280
// Icon sizes for the ⌨/🎤/✕ slot cluster and the chip's clear control. The registry renders SVG at
// these box sizes; the slot GEOMETRY (44px targets, the physical offsets, which edge they take)
// stays owned by comboboxInput.js so this cluster cannot drift from PlantingSelect's.
const ICON_PX = 18
const ICON_SM_PX = 16

// Same guard PlantingSelect's measurePlacement carries: jsdom has no layout engine and no
// visualViewport, so this returns null there and the panel renders the unmeasured default (down,
// 280) rather than exercising a path the suite cannot observe.
function measurePlacement(inputEl, inOverlay, forceFlip) {
  if (!inputEl || typeof inputEl.getBoundingClientRect !== 'function') return null
  const r = inputEl.getBoundingClientRect()
  if (!r || (!r.top && !r.bottom && !r.height)) return null
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  const viewTop = vv ? vv.offsetTop : 0
  const viewBottom = vv ? vv.offsetTop + vv.height
    : (typeof window !== 'undefined' ? window.innerHeight : 0)
  if (!viewBottom) return null
  const chrome = readChromeInsets(inputEl, inOverlay)
  return computePlacement({
    rectTop: r.top, rectBottom: r.bottom, viewTop, viewBottom,
    chromeTop: chrome.top, chromeBottom: chrome.bottom, forceFlip,
  })
}

// The secondary line on an option row. Locality is the discriminator that matters — two rows named
// "Agway" are told apart by "Hadley, MA" vs "Greenfield, MA" and by nothing else on the row. The
// kind slug is the fallback so a locality-less row still carries something; it is titleized rather
// than resolved through the kinds vocabulary because that vocabulary is deliberately not fetched
// until the mint panel opens.
const titleizeSlug = s => String(s ?? '').split(/[-_]/).filter(Boolean)
  .map(w => w[0].toUpperCase() + w.slice(1)).join(' ')

export function sourceSubLabel(s) {
  if (!s) return ''
  return s.locality ? String(s.locality) : titleizeSlug(s.kind)
}

export default function SourcePicker({
  value = '',
  // onChange(id: string, source: object|null) — id '' on clear. The row rides along so a call site
  // never needs its own id->row lookup to display or derive from what was just chosen.
  onChange,
  // The AXIS, and the field's accessible name: 'Source' (who it came from) vs 'Acquired from'
  // (where it changed hands). Default is the majority site.
  label = 'Source',
  placeholder,
  required = false,
  disabled = false,
  // A disabled control must say WHY. A silently disabled field is the failure mode PlantingSelect's
  // own disabledHint exists to prevent, and it is the same one here.
  disabledHint,
  id,
  // Off only where minting is genuinely wrong (a read-only surface). Default ON: the whole point of
  // the registry is that provenance can be recorded the moment it is known, and a picker that can
  // only choose from 54 existing rows sends the user to an admin screen to record a new farm stand.
  allowCreate = true,
  // onOpenChange(open) — OPTIONAL, no-op default. A host cannot otherwise know not to paint a
  // competing control (a sticky Save) over the open panel. Fired from ONE effect on `open` so no
  // future close path can forget it.
  onOpenChange,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  'data-testid': dataTestId,
}) {
  const hand = useHandedness()
  const inOverlay = useInOverlaySurface()

  const { sources, loading, createSource } = useSources()
  // LAZY, and latched: kinds are read ONLY inside the mint panel, so a form that never mints never
  // pays for the vocabulary. Latched rather than tracking `stage` directly — closing the mint panel
  // would otherwise flip the flag back and the next open would re-fetch.
  const [kindsWanted, setKindsWanted] = useState(false)
  const { sourceKinds, createSourceKind } = useSourceKinds({ enabled: kindsWanted })

  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [touched, setTouched] = useState(false)
  // null = the listbox | 'mint' = the create form rendered INSTEAD of it. An <input> may not live
  // inside role="listbox", so this is a stage swap, never a nesting.
  const [stage, setStage] = useState(null)
  // Read synchronously by onBlur, which fires in the same tick as the click that opened the mint
  // panel (the mint's autoFocus blurs the combobox). Without a ref the deferred close would race
  // the state update and shut the panel the user just asked for.
  const stageRef = useRef(null)

  const inputRef = useRef(null)
  const changeBtnRef = useRef(null)

  // Namespaced by useId, not a bare prefix: the wiring wave renders TWO of these on one form
  // (source + acquired-from), and duplicate DOM ids would make aria-activedescendant resolve to the
  // other picker's row. ':' is legal in an id but not in a CSS selector, so it is stripped.
  const listboxId = `sp-list-${useId().replace(/:/g, '')}`
  const optionId = useCallback((key) => `${listboxId}-opt-${key}`, [listboxId])
  const chipLabelId = `${listboxId}-chip-label`

  const {
    kbMode, enableKeyboard, disableKeyboard, isDeliberateBlur,
    voiceSupported, voiceState, toggleVoice,
  } = useComboboxInput({
    open,
    inputRef,
    // 'text' — the same default PlantingSelect adopted at V4-PICKERKBDEF-001. This is a field the
    // user almost always arrives at with a name in mind, so the tap that opens it should raise the
    // keyboard; the ⌨ toggle still swaps to browse mode.
    defaultMode: 'text',
    onVoiceText: (t) => { setQuery(t); setOpen(true) },
  })

  const q = query.trim()

  const candidates = useMemo(() => {
    if (!q) return sources
    // The shared matcher, not a local .toLowerCase().includes(): looseKey folds diacritics, drops
    // separators and collapses repeated letters, so "fed co" and "Fedco" agree and a voice
    // transcript matches what a typed query does.
    return sources.filter(s =>
      looseIncludes(s.name, q) ||
      looseIncludes(s.locality, q) ||
      looseIncludes(s.kind, q))
  }, [sources, q])

  const visible = useMemo(() => candidates.slice(0, MAX_RESULTS), [candidates])
  const hiddenCount = candidates.length - visible.length

  const selected = useMemo(
    () => sources.find(s => String(s.id) === String(value)) || null,
    [sources, value],
  )

  // The create row appears when the query CAN change the answer and not otherwise: something typed,
  // and no live source already carrying that name. The fold is looseKey — the same shape the
  // server's match_key collision uses — so "fedco seeds" does not offer to mint a second "Fedco
  // Seeds". It is a capability test, not a volume one: it shows at 1 result exactly as at 0.
  const exactMatch = useMemo(
    () => !!q && sources.some(s => looseKey(s.name) === looseKey(q)),
    [sources, q],
  )
  const showCreateRow = allowCreate && !!q && !exactMatch

  // The create row is a real option and COUNTS here — arrowing past the last source must reach it,
  // or the one row that cannot be got to any other way is keyboard-unreachable.
  const createIndex = showCreateRow ? visible.length : -1
  const navCount = visible.length + (showCreateRow ? 1 : 0)

  const listboxOpen = open && !disabled && stage === null
  const activeIsCreate = listboxOpen && highlight === createIndex && showCreateRow
  const activeSource = listboxOpen && highlight < visible.length ? (visible[highlight] ?? null) : null
  const activeDescendantId = activeIsCreate ? optionId('create')
    : activeSource ? optionId(activeSource.id)
    : undefined

  useEffect(() => { setHighlight(0) }, [query, sources])

  // APG: the active descendant must be scrolled into view. Focus stays on the input (moving it to
  // the option dismisses the Android soft keyboard and kills the typeahead), so the browser will
  // never do this for us. jsdom implements neither scrollIntoView nor layout, hence the optional call.
  useEffect(() => {
    if (!activeDescendantId || typeof document === 'undefined') return
    document.getElementById(activeDescendantId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeDescendantId])

  const closePanel = useCallback(() => {
    setOpen(false)
    setStage(null)
    stageRef.current = null
    setTouched(true)
  }, [])

  // Escape/Back arbitration through the shared registry — the same seam Sheet, Lightbox and
  // PlantingSelect use. NEVER hand-rolled: registering is what ARMS a history entry, and without it
  // Android Back is not routed here at all and discards the half-filled host form instead.
  // LAYER.SHEET because this panel is a DESCENDANT of whatever surface hosts it, so it paints inside
  // that surface's stacking context; the equal-layer tiebreak (later registration wins) is what puts
  // it above the sheet it opened inside.
  const { registered: dismissRegistered } = useDismissable({
    open: open && !disabled, onDismiss: closePanel, layer: LAYER.SHEET, armsBack: true,
  })

  // ONE notification point for `open`, keyed on `open` only and read through a ref — an effect keyed
  // on a caller's inline closure would re-fire on every parent render.
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  useEffect(() => { onOpenChangeRef.current?.(open) }, [open])
  // The panel can unmount while still open (route change, sheet dismiss). Without this the host is
  // left believing a picker is open forever.
  useEffect(() => () => { onOpenChangeRef.current?.(false) }, [])

  // ── Measured placement, with the direction LATCHED per open ────────────────
  // Same contract as PlantingSelect's: the first measurable flip of an open wins and is held until
  // the panel closes, because visualViewport `scroll` fires per compositor frame while the Android
  // keyboard animates and a panel that changes sides mid-gesture cannot be aimed at at all.
  const [placement, setPlacement] = useState(null)
  const flipLatchRef = useRef(null)
  useEffect(() => {
    if (!open || disabled) { flipLatchRef.current = null; setPlacement(null); return }
    let raf = 0
    const apply = () => {
      raf = 0
      const next = measurePlacement(inputRef.current, inOverlay, flipLatchRef.current)
      if (next && flipLatchRef.current === null) flipLatchRef.current = next.flip
      setPlacement(prev =>
        (prev?.flip === next?.flip && prev?.maxHeight === next?.maxHeight) ? prev : next)
    }
    const schedule = () => {
      if (raf) return
      raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(apply) : (apply(), 0)
    }
    apply()
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    vv?.addEventListener('resize', schedule)
    vv?.addEventListener('scroll', schedule)
    window.addEventListener?.('resize', schedule)
    return () => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
      vv?.removeEventListener('resize', schedule)
      vv?.removeEventListener('scroll', schedule)
      window.removeEventListener?.('resize', schedule)
    }
  }, [open, disabled, visible.length, stage, inOverlay])

  // ── The mint stage ─────────────────────────────────────────────────────────
  const [mintName, setMintName] = useState('')
  const [mintKind, setMintKind] = useState('')
  const [mintLocality, setMintLocality] = useState('')
  const [mintBusy, setMintBusy] = useState(false)
  // null | { message, existing } — `existing` present means the server steered us to a row that
  // already covers this name. Adopting it is the CORRECT outcome, so it gets a real button rather
  // than a dead error string.
  const [mintErr, setMintErr] = useState(null)
  const [addingKind, setAddingKind] = useState(false)
  const [kindName, setKindName] = useState('')
  const [kindBusy, setKindBusy] = useState(false)
  const [kindErr, setKindErr] = useState(null)

  const resetMint = useCallback(() => {
    setMintName(''); setMintKind(''); setMintLocality(''); setMintErr(null); setMintBusy(false)
    setAddingKind(false); setKindName(''); setKindErr(null); setKindBusy(false)
  }, [])

  const select = useCallback((s) => {
    onChange?.(s ? String(s.id) : '', s ?? null)
    setOpen(false)
    setStage(null)
    stageRef.current = null
    setQuery('')
    setTouched(true)
    resetMint()
    // Committing swaps this component into chip mode, which does not render the <input> at all — so
    // the focused element is UNMOUNTED and focus falls to <body>, losing the TalkBack cursor
    // mid-form. Move it to the control that survives. The activeElement guard keeps this from
    // stealing focus a host deliberately moved in the same commit; there is no fallback to the
    // input, because a host that does not echo `value` back never enters chip mode and refocusing
    // there would fire onFocus and re-open the panel.
    setTimeout(() => {
      const btn = changeBtnRef.current
      if (!btn || typeof document === 'undefined') return
      const active = document.activeElement
      if (active && active !== document.body && active !== inputRef.current) return
      btn.focus()
    }, 0)
  }, [onChange, resetMint])

  const beginMint = useCallback(() => {
    stageRef.current = 'mint'
    setStage('mint')
    setKindsWanted(true)
    setMintName(q)
    setMintErr(null)
  }, [q])

  const backToList = useCallback(() => {
    stageRef.current = null
    setStage(null)
    setHighlight(0)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  async function submitMint() {
    const name = mintName.trim()
    if (!name || mintBusy) return
    setMintBusy(true)
    setMintErr(null)
    const res = await createSource({
      name,
      kind: mintKind || null,
      locality: mintLocality.trim() || null,
    })
    setMintBusy(false)
    if (res?.error) { setMintErr({ message: res.error, existing: res.existing ?? null }); return }
    // CONTINUE the flow. Stopping at "created" would leave the user to find the new row themselves
    // in a list they came here precisely because it did not contain it.
    select(res.source)
  }

  async function submitKind() {
    const display_name = kindName.trim()
    if (!display_name || kindBusy) return
    setKindBusy(true)
    setKindErr(null)
    // `display_name` ONLY. The slug is a primary key and an FK target and is derived server-side;
    // the hook does not offer it as a parameter for exactly this reason.
    const res = await createSourceKind({ display_name })
    setKindBusy(false)
    if (res?.error) { setKindErr({ message: res.error, existing: res.existing ?? null }); return }
    // Select what was just minted, for the same reason the source mint continues its flow.
    setMintKind(res.sourceKind.slug)
    setAddingKind(false)
    setKindName('')
  }

  const clear = useCallback(() => {
    onChange?.('', null)
    setTouched(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [onChange])

  const onKeyDown = (e) => {
    if (disabled) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      setHighlight(h => Math.min(navCount - 1, h + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(h => Math.max(0, h - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      if (showCreateRow && highlight === createIndex) beginMint()
      else if (visible[highlight]) select(visible[highlight])
    } else if (e.key === 'Escape') {
      // Gated on `open`, and deliberately NOT a blur. DismissRegistry bails on defaultPrevented, so
      // an unconditional preventDefault here would make Escape dead for the hosting Sheet whenever
      // focus sat in this input with the list closed. When the registry IS live it owns the key
      // entirely — handling it here as well would preventDefault the key it then bails on.
      if (open) {
        if (dismissRegistered) return
        e.preventDefault()
        e.stopPropagation()
        closePanel()
      }
    } else if (e.key === 'Tab') {
      // Close immediately, but NEVER preventDefault and NEVER commit the highlighted option: a
      // typeahead that writes a value on Tab-out is a wrong-write generator.
      setOpen(false)
    }
  }

  const onBlur = () => {
    // A blur we caused ourselves to swap inputMode — leave `open` alone.
    if (isDeliberateBlur()) return
    // Focus moved INTO the mint panel (its Name field autofocuses). The panel owns its own
    // dismissal from here; the deferred close below would otherwise shut it in 150ms.
    if (stageRef.current !== null) return
    setTimeout(() => {
      if (stageRef.current !== null) return
      setOpen(false)
    }, 150)
    setTouched(true)
  }

  // ── Chip mode: a selection is made and the picker is at rest ───────────────
  if (selected && !open) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <div style={chipStyle(disabled)} data-testid={dataTestId ? `${dataTestId}-chip` : 'sp-chip'}>
          {/* One line, ellipsised, with `title` keeping the full text reachable where there is a
              pointer. An unbounded chip grows VERTICALLY in a narrow column and takes that height
              out of whatever track pays for it — the BUG-FRAMEPADOCCLUDE-001 shape. */}
          <span
            id={chipLabelId}
            title={selected.name}
            style={{
              fontSize: T.type.sm2, fontWeight: 600, color: P.green,
              minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {selected.name}
          </span>
          {sourceSubLabel(selected) && (
            <span style={{ fontSize: T.type.xs2, color: P.light, marginLeft: T.space.xs, flexShrink: 0 }}>
              {sourceSubLabel(selected)}
            </span>
          )}
          {!disabled && (
            <button type="button" onClick={clear} aria-label={`Clear ${label.toLowerCase()}`} style={chipClearBtn}>
              <Icon name="action.close" size={ICON_SM_PX} decorative />
            </button>
          )}
        </div>
        {!disabled && (
          <button
            ref={changeBtnRef}
            type="button"
            // DESCRIBED by, not LABELLED by: the accessible NAME stays "Change" while TalkBack also
            // reads what was chosen when focus lands here after a commit.
            aria-describedby={chipLabelId}
            onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0) }}
            style={linkBtn}
          >
            Change
          </button>
        )}
      </div>
    )
  }

  const showBlankError = required && touched && !selected && !q
  const effectivePlaceholder = disabled && disabledHint
    ? disabledHint
    : (placeholder ?? 'Search sources…')

  const kbRaised = kbMode === 'text'
  const showKbBtn = open && !disabled && stage === null
  const showMicBtn = open && !disabled && stage === null && voiceSupported
  // Present for the whole time the panel is, in BOTH stages. This panel has no backdrop and Android
  // has no Escape key: an invisible dismissal is not a discoverable exit.
  const showCloseBtn = open && !disabled
  const togglePad = toggleSlotsPaddingStyle({ showKb: showKbBtn, showMic: showMicBtn, showClose: showCloseBtn, hand })

  // Rendered UNCONDITIONALLY (empty string when there is nothing to say) — a live region must
  // pre-exist its content to be announced; one created together with its text is silent. Bare
  // aria-live rather than role="status", which host post-save confirmations already occupy.
  const liveCount = (!listboxOpen || loading) ? ''
    : visible.length === 0
      ? (showCreateRow ? 'No sources match — create one' : 'No sources available')
      : `${visible.length} source${visible.length === 1 ? '' : 's'} available${showCreateRow ? ', or create one' : ''}`

  return (
    <div style={{ position: 'relative' }}>
      <div aria-live="polite" style={srOnly}>{liveCount}</div>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        // Both derived from listboxOpen, never from `open` alone: while the mint form is up there is
        // no listbox in the document, and naming one that is not rendered is a dangling IDREF that
        // tells a screen reader "expanded — the popup is #x" with #x nowhere to be found.
        aria-expanded={listboxOpen}
        aria-controls={listboxOpen ? listboxId : undefined}
        // `undefined` (attribute ABSENT), never '': an empty aria-activedescendant reads as "there
        // is an active option, I just cannot find it".
        aria-activedescendant={activeDescendantId}
        aria-autocomplete="list"
        aria-required={required || undefined}
        aria-invalid={showBlankError || undefined}
        aria-label={ariaLabel ?? label}
        aria-describedby={ariaDescribedBy}
        data-testid={dataTestId}
        value={query}
        inputMode={kbMode}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => { if (!disabled) setOpen(true) }}
        // Required BY the Escape behaviour: Escape leaves focus on the input, so tapping the field
        // again fires no focus event and onFocus alone could not re-open the list.
        onClick={() => { if (!disabled && !open) setOpen(true) }}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        placeholder={effectivePlaceholder}
        disabled={disabled}
        style={{
          ...inputChrome(showBlankError), minHeight: T.tapMinHeight,
          ...(togglePad ?? null),
          ...(disabled ? { opacity: 0.5, cursor: 'not-allowed' } : null),
        }}
        autoComplete="off"
      />
      {showKbBtn && (
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={kbRaised ? disableKeyboard : enableKeyboard}
          aria-label={kbRaised ? 'Hide the keyboard and browse sources' : 'Type to search sources'}
          aria-pressed={kbRaised}
          title={kbRaised ? 'Hide the keyboard' : 'Type to search'}
          style={kbToggleBtnStyle(hand)}
        >
          {/* The BUTTON owns the accessible name (aria-label above), so the mark is decorative.
              `action.search` = "type to search"; `action.chevron` = "put the keyboard away". */}
          <Icon name={kbRaised ? 'action.chevron' : 'action.search'} size={ICON_PX} decorative />
        </button>
      )}
      {showMicBtn && (
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={voiceState === 'denied' ? undefined : toggleVoice}
          aria-label={
            voiceState === 'denied' ? 'Microphone unavailable'
            : voiceState === 'listening' ? 'Stop listening'
            : 'Speak to search sources'
          }
          aria-pressed={voiceState === 'listening'}
          aria-disabled={voiceState === 'denied' || undefined}
          title="Speak to search"
          style={micToggleBtnStyle(voiceState, hand)}
        >
          <Icon name="media.mic" size={ICON_PX} decorative />
        </button>
      )}
      {showCloseBtn && (
        <button
          type="button"
          // Load-bearing twice: it keeps focus wherever it already is, so a focused input is not
          // blurred into a second close, and an unfocused one is not given focus and made to raise
          // the keyboard on the way out.
          onMouseDown={e => e.preventDefault()}
          onClick={closePanel}
          aria-label="Close the source list"
          title="Close the list"
          data-testid="sp-close"
          style={closeToggleBtnStyle(showMicBtn, hand)}
        >
          <Icon name="action.close" size={ICON_PX} decorative />
        </button>
      )}

      {listboxOpen && (
        <div style={panelStyle(placement)} data-testid="sp-panel">
          <ul
            id={listboxId}
            role="listbox"
            aria-label="Sources"
            style={listStyle(placement)}
            // Keep input focus while clicking rows; the deferred blur-close still runs after click.
            onMouseDown={e => e.preventDefault()}
          >
            {loading && <li style={noteRow} role="presentation">Loading sources…</li>}
            {!loading && visible.length === 0 && !showCreateRow && (
              <li style={noteRow} role="presentation">
                {q ? `No sources match “${q}”.` : 'No sources yet.'}
              </li>
            )}
            {visible.map((s, i) => (
              <li
                key={s.id}
                id={optionId(s.id)}
                role="option"
                // SELECTED, not highlighted — the active row is carried by aria-activedescendant
                // above. VarietyPicker conflates the two; do not copy it from there.
                aria-selected={String(s.id) === String(value)}
                data-testid={`sp-opt-${s.id}`}
                onClick={() => select(s)}
                style={rowStyle(i === highlight)}
              >
                {/* minWidth 0 is load-bearing: a flex child's default min-width:auto refuses to
                    shrink below its content, so textOverflow never engages without it. */}
                <span style={{ minWidth: 0, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.name}
                </span>
                {sourceSubLabel(s) && (
                  <span style={{ fontSize: T.type.xs2, color: P.light, marginLeft: T.space.sm, flexShrink: 0 }}>
                    {sourceSubLabel(s)}
                  </span>
                )}
              </li>
            ))}
            {showCreateRow && (
              // A real role="option" so Enter commits it and it counts in the option set the arrow
              // keys walk — it is the one row reachable no other way.
              <li
                id={optionId('create')}
                role="option"
                aria-selected={false}
                data-testid="sp-create-row"
                onClick={beginMint}
                style={createRowStyle(highlight === createIndex)}
              >
                ＋ Create “{q}”
              </li>
            )}
            {hiddenCount > 0 && (
              <li style={noteRow} role="presentation">
                +{hiddenCount} more — keep typing to narrow.
              </li>
            )}
          </ul>
        </div>
      )}

      {open && !disabled && stage === 'mint' && (
        // Rendered INSTEAD of the listbox, never inside it: role="listbox" owns only options and
        // groups, so nesting these inputs there would be invalid ARIA and would break the combobox.
        // EVERY button below is type="button" — this panel sits inside the host's <form>, and a
        // default-type button would submit it and save the plant instead of minting the source.
        <div style={panelStyle(placement)} data-testid="sp-mint">
          <div style={mintBody}>
            <div style={mintHeader}>New source</div>

            <Field label="Name" htmlFor={`${listboxId}-mint-name`} required style={{ marginBottom: T.space.sm }}>
              <Input
                id={`${listboxId}-mint-name`}
                type="text"
                autoFocus
                value={mintName}
                onChange={e => { setMintName(e.target.value); setMintErr(null) }}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); submitMint() }
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); backToList() }
                }}
                placeholder="e.g. Fedco Seeds"
                data-testid="sp-mint-name"
                autoComplete="off"
              />
            </Field>

            {/* CropTypeField's shape (VarietyEditor.jsx:176): a Select of the live vocabulary plus a
                collapsed link that expands an inline mint. No local `minted` merge is needed here —
                CropTypeField needs one because its vocabulary is a PROP that lags the mint by a
                render; this hook is owned by this component, so its list is already current. */}
            <Field label="Kind" htmlFor={`${listboxId}-mint-kind`} optional style={{ marginBottom: T.space.xs }}>
              <Select
                id={`${listboxId}-mint-kind`}
                value={mintKind}
                onChange={e => setMintKind(e.target.value)}
                placeholder="— none —"
                data-testid="sp-mint-kind"
              >
                {sourceKinds.map(k => (
                  <option key={k.slug} value={k.slug}>{k.display_name}</option>
                ))}
              </Select>
            </Field>

            {addingKind ? (
              <div style={kindPanel}>
                <Field label="New kind name" htmlFor={`${listboxId}-kind-name`} required style={{ marginBottom: T.space.sm }}>
                  <Input
                    id={`${listboxId}-kind-name`}
                    type="text"
                    autoFocus
                    value={kindName}
                    onChange={e => { setKindName(e.target.value); setKindErr(null) }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitKind() } }}
                    placeholder="e.g. Seed Library"
                    data-testid="sp-kind-name"
                    autoComplete="off"
                  />
                </Field>
                {kindErr && (
                  <div role="alert" style={errText}>
                    <div>{kindErr.message}</div>
                    {kindErr.existing && (
                      <Button
                        type="button" variant="secondary" style={{ marginTop: T.space.sm }}
                        data-testid="sp-kind-adopt"
                        onClick={() => {
                          setMintKind(kindErr.existing.slug)
                          setAddingKind(false); setKindName(''); setKindErr(null)
                        }}
                      >
                        Use “{kindErr.existing.display_name}”
                      </Button>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: T.space.sm }}>
                  <Button
                    type="button" variant="primary" loading={kindBusy} loadingLabel="Creating…"
                    disabled={!kindName.trim()} onClick={submitKind} data-testid="sp-kind-submit"
                  >
                    Create kind
                  </Button>
                  <Button
                    type="button" variant="secondary"
                    onClick={() => { setAddingKind(false); setKindName(''); setKindErr(null) }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddingKind(true)}
                style={mintLinkStyle}
                data-testid="sp-kind-add"
              >
                ＋ New kind
              </button>
            )}

            <Field label="Locality" htmlFor={`${listboxId}-mint-locality`} optional
              help="Town and state, if it helps tell two of the same name apart."
              style={{ marginTop: T.space.sm, marginBottom: 0 }}>
              <Input
                id={`${listboxId}-mint-locality`}
                type="text"
                value={mintLocality}
                onChange={e => setMintLocality(e.target.value)}
                placeholder="e.g. Hadley, MA"
                data-testid="sp-mint-locality"
                autoComplete="off"
              />
            </Field>

            {mintErr && (
              <div role="alert" style={errText}>
                <div>{mintErr.message}</div>
                {/* The server steered us to a row that already exists. Adopting it is the CORRECT
                    outcome, not a failure — so it gets a real button that completes the flow. */}
                {mintErr.existing && (
                  <Button
                    type="button" variant="secondary" style={{ marginTop: T.space.sm }}
                    data-testid="sp-adopt"
                    onClick={() => select(mintErr.existing)}
                  >
                    Use “{mintErr.existing.name}”
                  </Button>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: T.space.md }}>
              <Button
                type="button" variant="primary" loading={mintBusy} loadingLabel="Creating…"
                disabled={!mintName.trim()} onClick={submitMint} data-testid="sp-mint-submit"
              >
                Create source
              </Button>
              <Button type="button" variant="secondary" onClick={backToList} data-testid="sp-mint-cancel">
                Back
              </Button>
            </div>
          </div>
        </div>
      )}

      {showBlankError && (
        <div role="alert" style={{ color: P.terra, fontSize: T.type.sm, marginTop: T.space.xs }}>
          Choose a {label.toLowerCase()}.
        </div>
      )}
    </div>
  )
}

// ── Chrome (composed from P/T per formStyles discipline — no raw hex) ────────
function chipStyle(disabled) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    backgroundColor: P.greenPale,
    border: `1px solid ${P.green}`,
    borderRadius: T.radiusField,
    padding: `${T.fieldPadY}px ${T.fieldPadX}px`,
    minHeight: T.tapMinHeight,
    minWidth: 0,
    maxWidth: '100%',
    boxSizing: 'border-box',
    opacity: disabled ? 0.6 : 1,
  }
}

const chipClearBtn = {
  background: 'none', border: 'none', cursor: 'pointer', color: P.mid,
  fontSize: T.type.base, padding: `${T.space.xs}px`, minWidth: 30, minHeight: 30, lineHeight: 1,
}

const linkBtn = {
  background: 'none', border: 'none', cursor: 'pointer', color: P.green,
  fontSize: T.type.sm, fontWeight: 600, textDecoration: 'underline',
  padding: `${T.space.sm}px ${T.space.xs}px`, minHeight: T.tapMinHeight,
}

// The floating panel both stages share, so the list and the mint form anchor identically and the
// panel never changes position when the stage swaps under the user's thumb.
function panelStyle(placement) {
  const flip = !!placement?.flip
  return {
    position: 'absolute',
    // Z.sheet — the panel registers LAYER.SHEET, and dismissLayers' whole premise is that the
    // registered layer equals the painted one.
    zIndex: 200,
    ...(flip
      ? { bottom: '100%', top: 'auto', marginTop: 0, marginBottom: T.space.xs }
      : { top: '100%', bottom: 'auto', marginTop: T.space.xs, marginBottom: 0 }),
    left: 0,
    right: 0,
    backgroundColor: P.white,
    border: `1px solid ${P.border}`,
    borderRadius: T.radiusField,
    boxShadow: flip ? '0 -6px 18px rgba(0,0,0,0.12)' : '0 6px 18px rgba(0,0,0,0.12)',
    maxHeight: (placement?.maxHeight ?? LIST_MAX_H) + 120,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  }
}

function listStyle(placement) {
  return {
    margin: 0,
    padding: T.space.xs,
    listStyle: 'none',
    maxHeight: placement?.maxHeight ?? LIST_MAX_H,
    overflowY: 'auto',
    // Without this, flicking past the end chains the scroll to the host sheet, which drags the
    // anchored input (and this panel with it) away mid-choice.
    overscrollBehavior: 'contain',
  }
}

const mintBody = {
  padding: `${T.fieldPadY}px ${T.fieldPadX}px`, overflowY: 'auto', overscrollBehavior: 'contain',
}

const mintHeader = {
  fontSize: T.type.sm, fontWeight: 700, color: P.mid, textTransform: 'uppercase',
  letterSpacing: '0.4px', marginBottom: T.space.sm,
}

const mintLinkStyle = {
  background: 'none', border: 'none', color: P.green, cursor: 'pointer', fontSize: T.type.sm,
  fontWeight: 600, paddingTop: T.space.sm, textDecoration: 'underline',
  minHeight: T.tapMinHeight,
}

const kindPanel = {
  marginTop: T.space.sm, border: `1px solid ${P.border}`, borderRadius: T.radiusButton,
  padding: `${T.fieldPadY}px ${T.fieldPadX}px`, backgroundColor: P.cream,
}

const errText = { color: P.terra, fontSize: T.type.sm, marginTop: T.space.sm }

function rowStyle(highlighted) {
  return {
    display: 'flex',
    alignItems: 'baseline',
    padding: `${T.fieldPadY}px ${T.fieldPadX}px`,
    // HEIGHT, not just minHeight: a long name that wrapped would shift every row below it, making
    // the y-position of "the third result" depend on how long the second one was. Under a soft
    // keyboard, tap targets that move between renders are a mis-tap generator.
    height: T.tapMinHeight,
    minHeight: T.tapMinHeight,
    boxSizing: 'border-box',
    borderRadius: T.radiusField,
    cursor: 'pointer',
    fontSize: T.type.sm2,
    color: P.dark,
    backgroundColor: highlighted ? P.greenPale : 'transparent',
  }
}

function createRowStyle(highlighted) {
  return {
    ...rowStyle(highlighted),
    color: P.green,
    fontWeight: 600,
    borderTop: `1px solid ${P.border}`,
  }
}

const noteRow = { padding: `${T.space.sm}px`, fontSize: T.type.sm, color: P.light }

const srOnly = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
}
