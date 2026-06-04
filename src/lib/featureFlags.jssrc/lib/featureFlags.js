// Feature flags for gated UI surfaces.
// V1.2a-4 S1 (PROJ-RESCOPE): cultivar option in ProjectNew kind dropdown is gated
// until VARIETY-REF S4 lands the Cultivar-as-first-class flow. See V102 §5.2.
export const VARIETY_REF_UI_SHIPPED = false // Flips true when VARIETY-REF S4 ships per V102 §5.2

// 2.0.1 (gifted-busy-thompson): the Catch-up badge in the More menu linked to
// /plants/catch-up, whose S1.1 editor was never built — it shipped into V2 as a
// "coming soon" dead-end. Badge is hidden until the editor ships. Flip true when the
// S1.1 catch-up editor lands (planned 2.1). See v2-increment-audit-2.0.1-to-2.1-V001.
export const CATCH_UP_EDITOR_SHIPPED = false

// MVP-Critter Session 4 (revision §3.24 + §6 deferred note): SYSTEM (push) notifications
// option in Settings → Notifications tri-state toggle. Bi-state literal const — when
// false, the SYSTEM radio option is hidden entirely (UI collapses to OFF / IN-APP ONLY).
// Flips true post-V2.x when iOS PWA push delivery is wired (Web Push + service worker
// subscription + Lambda push-send path). Per revision §3.24, even when this is true,
// SYSTEM-option render-time MUST gate on PWA-installed state (matchMedia standalone OR
// navigator.standalone) — installation is a separate prereq from the bi-state flag.
export const SYSTEM_NOTIFICATIONS_ENABLED = false

// V3-EVENT-008 §8 (Dave 2026-06-03): EventNew's three low-frequency fields —
// Quantity·optional, Visibility card, Private-notes card — moved into a collapsible
// "Add details" section to declutter the common logging path (ADHD focus). They are
// NOT removed: the section stays reachable, all state/payload wiring is intact, and
// the horticulture data (season-narrative notes + propagation/germination counts) is
// preserved. When this flag is FALSE the section starts COLLAPSED (the common path);
// flip TRUE to have it render EXPANDED by default. Either way the fields are reachable.
export const EVENTNEW_ADD_DETAILS_EXPANDED = false
