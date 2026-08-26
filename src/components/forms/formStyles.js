// src/components/forms/formStyles.js
// ────────────────────────────────────────────────────────────────────────────
// Lane D / Phase A — canonical form CHROME, composed entirely from the palette `P`.
//
// Single source of truth for input/select/textarea/button pixel values. Per the
// Lane D Crucible (forms-consolidation-plan-V002): field chrome is canonicalized
// from InventoryAdd (the winner where pixel values conflicted with VarietyPicker /
// ProjectNew); a11y wiring conventions come from VarietyPicker. EVERY value here
// derives from `P` — there is no literal hex, and the select chevron stroke is
// built from P.light at runtime (it used to be hardcoded `stroke=%23777` in each
// page's inline selectStyle). Phase F's token-level ESLint rule bans raw hex /
// radius / padding on form JSX; this module is how consumers stay compliant.
//
// AI-read shared module: the commentary is intentional (Code Rules agent-destined
// exception) — later Lane D phases (B/C enums, D pickers, E unification) compose
// these tokens, and drift here re-scatters every form.
import { P } from '../../lib/constants.js'

// ── Design tokens ────────────────────────────────────────────────────────────
export const T = {
  radiusField:  7,    // input/select/textarea (InventoryAdd canonical)
  radiusButton: 8,    // button (InventoryAdd canonical)
  radiusCard:   10,
  radiusBadge:  12,   // DESIGNSYS Pass A: PlantStatusBadge pill radius
  fieldPadY:    10,
  fieldPadX:    12,
  fontField:    '0.9rem',
  buttonMinHeight: 48, // frozen — accessibility tap target + Crucible §2
  // BUG-DISCLOSURETAPSIZE-001 — the FLOOR, distinct from buttonMinHeight's 48 comfort target.
  // 44 was already the number this codebase enforced (selectChrome's minHeight, PhotoHero,
  // Lightbox, NotifyButton, PostSaveFeedback… all literal 44s); it just had no home, so four
  // controls on Log Event were shipped under it — "Add details" at 16px, the frame's
  // photo/notes toggle at 24, "Flag an issue" at 36, and every <Input> at 41. Named here so a
  // fifth cannot be authored under the floor without spelling out a different number.
  tapMinHeight: 44,
  // ── DESIGNSYS Pass A: type + space ramps (values already in use; additive) ──
  // xs2 / sm2 are INTERSTITIAL parity steps, not new sizes: 0.75rem (forms/Badge) and
  // 0.88rem (SelectChip's non-small branch) were already shipping with no name, so the
  // ramp did not in fact cover the chip/badge fonts it was written for. Named at their
  // EXACT current values — naming is parity-preserving; RETUNING them onto xs/sm/base is
  // a visible pixel change and belongs to Pass B. Do not author new surfaces against
  // xs2/sm2/lg; they exist so the guard has something to route the existing literals to.
  type: { xs: '0.72rem', xs2: '0.75rem', sm: '0.82rem', sm2: '0.88rem', base: '0.9rem', md: '0.95rem', lg: '1rem' },
  space: { xs: 5, sm: 10, md: 16, lg: 20 },
  // Badge tokens — exact current PlantStatusBadge values (parity-preserving).
  badgeFontSm: '0.73rem',
  badgeFontLg: '0.85rem',
  badgePadSm:  '2px 9px',
  badgePadLg:  '4px 12px',
  // The tighter pad SeverityBadge and TagChip both already used, plus SeverityBadge's
  // height floor. Two primitives sharing an unnamed value is how a third gets authored at
  // '2px 7px'; both are captured at their current values.
  badgePadXs:  '2px 8px',
  badgeMinHeight: 20,
  // ── Selection-chip grammar (contract §2) ──────────────────────────────────
  // §2 froze `minHeight 40` and `borderRadius 20` as THE selection-chip grammar, but both
  // shipped as bare numbers inside SelectChip, so nothing stopped a sixth chip being
  // authored at 18. Named here at the frozen values; the 48 touch variant reuses
  // buttonMinHeight, which is the same 48 the contract froze as the tap target.
  radiusPill:    20,
  chipMinHeight: 40,
  chipPadSm:     '6px 12px',
  chipPadLg:     '8px 14px',
  // ── PhotoUpload's rem scale (parity capture) ──────────────────────────────
  // PhotoUpload is the one §2 primitive authored in rem rather than px, so its values have
  // no counterpart on the px ramps above. Grouped rather than scattered into T's top level
  // precisely so the divergence stays legible: unifying this onto the px ramp changes
  // pixels and is a Pass B decision. linkFont duplicates badgeFontLg's value at a distinct
  // role — a semantic alias, not a second source of truth.
  photo: {
    triggerPad:  '0.75rem 1.25rem',
    radius:      '0.5rem',
    thumbRadius: '0.375rem',
    gapMd:       '0.75rem',
    gapSm:       '0.5rem',
    linkFont:    '0.85rem',
  },
}

// Build the select chevron data-URI from a palette color (default P.light).
// Returns a `url("data:image/svg+xml,…")` string. The stroke is URL-encoded
// (`#` → `%23`) so it embeds cleanly in a CSS background-image.
export function chevronDataUri(color = P.light) {
  const enc = color.replace('#', '%23')
  return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='${enc}' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`
}

// Base input chrome. `hasError` swaps the border to terra (the canonical error
// affordance — paired in the components with aria-invalid, never color-alone).
export function inputChrome(hasError = false) {
  return {
    width: '100%',
    // BUG-DISCLOSURETAPSIZE-001: 10px padding + a ~0.9rem line box computes to ~41px, under the
    // tap floor selectChrome has enforced since V4-PLANTPICKER-001. The date control on Log Event
    // is the measured instance (41px at 390x844), but every Input in the app was equally short.
    minHeight: T.tapMinHeight,
    padding: `${T.fieldPadY}px ${T.fieldPadX}px`,
    border: `1px solid ${hasError ? P.terra : P.border}`,
    borderRadius: T.radiusField,
    fontSize: T.fontField,
    backgroundColor: P.white,
    boxSizing: 'border-box',
    fontFamily: 'inherit',
    color: P.dark,
  }
}

export function selectChrome(hasError = false) {
  return {
    ...inputChrome(hasError),
    // V4-PLANTPICKER-001 (spec §6.5 nit): computed height was ≈39px, under the 44pt tap minimum
    // that buttonMinHeight already froze for buttons — pages were patching it inline instead.
    // (Now inherited from inputChrome; kept explicit so this stays true if that base ever moves.)
    minHeight: T.tapMinHeight,
    appearance: 'none',
    WebkitAppearance: 'none',
    MozAppearance: 'none',
    backgroundImage: chevronDataUri(P.light),
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 12px center',
    paddingRight: 36,
    cursor: 'pointer',
  }
}

export function textareaChrome(hasError = false) {
  return {
    ...inputChrome(hasError),
    minHeight: 80,
    resize: 'vertical',
  }
}

// Button variants. One disabled convention everywhere: P.light fill +
// not-allowed cursor (components also set aria-disabled). minHeight frozen at 48.
const BUTTON_VARIANTS = {
  primary:   { bg: P.green,  fg: P.white, border: 'none' },
  secondary: { bg: 'transparent', fg: P.mid, border: `1px solid ${P.border}` },
  danger:    { bg: P.terra,  fg: P.white, border: 'none' },
}

export function buttonChrome(variant = 'primary', disabled = false) {
  const v = BUTTON_VARIANTS[variant] ?? BUTTON_VARIANTS.primary
  return {
    backgroundColor: disabled ? P.light : v.bg,
    color: disabled && variant === 'secondary' ? P.light : v.fg,
    border: v.border,
    borderRadius: T.radiusButton,
    padding: '13px 30px',
    fontSize: '0.95rem',
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
    minHeight: T.buttonMinHeight,
    fontFamily: 'inherit',
    lineHeight: 1.2,
  }
}

export const labelChrome = {
  display: 'block',
  fontSize: '0.8rem',
  fontWeight: 600,
  color: P.mid,
  marginBottom: 5,
}

export const requiredMarkChrome = { color: P.terra, marginLeft: 3 }
export const optionalMarkChrome = { color: P.light, fontWeight: 400, marginLeft: 6, fontSize: '0.82em' }

export const helpChrome = { marginTop: 5, fontSize: '0.74rem', color: P.light }

export const errorChrome = {
  display: 'flex', alignItems: 'center', gap: 5,
  marginTop: 5, fontSize: '0.78rem', color: P.terra,
}

export const cardChrome = {
  backgroundColor: P.white,
  border: `1px solid ${P.border}`,
  borderRadius: T.radiusCard,
  padding: '20px 18px',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
}

export const bannerChrome = {
  backgroundColor: P.alert,
  border: `1px solid ${P.alertBorder}`,
  borderRadius: 8,
  padding: '12px 16px',
  fontSize: '0.875rem',
  color: P.bannerInk,
}
