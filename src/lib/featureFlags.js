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

// DRG-WXWATER-001 coarse-v1 (Dave 2026-07-08): mirrors the server CARE_RAIN_CREDIT_ENABLED env flag for any UI
// that surfaces the "watering skipped — recent rain" substrate-tier trace. Default OFF; flip TRUE in lockstep
// with the server env var AFTER shadow-soak. These are SEPARATE mechanisms — the CJS daily-plan Lambda cannot
// import this ESM module, so the server reads process.env.CARE_RAIN_CREDIT_ENABLED and this is the client copy.
export const CARE_RAIN_CREDIT_ENABLED = false

// DRG-WXFLAGSPLIT-001 F1 (2026-07-31): client mirror of the server CARE_RAIN_MAXDAYS_ENABLED env flag, split
// out of CARE_RAIN_CREDIT_ENABLED so the tiered rain CREDIT and the max-days interval CEILING can be flipped
// independently. Default OFF and inert. Same separate-mechanism caveat as above: flip this in lockstep with
// the Lambda env var, or the client rain trace diverges from the plan the server actually computed.
export const CARE_RAIN_MAXDAYS_ENABLED = false

// V4-OVERLAY-001 (design V102): route-backed overlays — forms/search open as flyovers over the
// current tab instead of navigating away. Slice 1 = infra + /search consumer. When FALSE, every
// overlay helper degrades to plain navigate/Link, no `background` is ever set, the overlay tree
// never renders, and chrome reads the real location — behavior is byte-identical to pre-overlay.
// Flip TRUE only after Slice-1 CI-green on pinned node 20.19.0. NOTE (design §9): this flag is a
// true safety net for Slice 1 ONLY — Slices 2-3 mutate full-page rendering outside its guard.
export const OVERLAY_ROUTES_ENABLED = true

// V4-PLANTREQUIRED-001 (Lane 3, Ask 2): per-event-type required-planting gate on EventNew + the
// ProjectDetail mini-logger. When FALSE (default) the D2 matrix is INERT — the planting field stays
// optional exactly as today and no POST is blocked, so the existing suite is unaffected. When TRUE,
// event types that predicate on a plant (PLANTING_REQUIRED_TYPES in eventTypes.js) require a plant_id
// client-side before submit. CLIENT-side + flagged ONLY: the server validator (events/validators.js)
// is deliberately NOT flipped in lockstep — this is a PWA with a service worker, so a one-step server
// flip would 400 every log from stale cached bundles mid-season (spec D7). Flip TRUE only after
// Lane 2 telemetry shows new orphans for REQUIRED types approach zero (D1 falsifier). Criteria-gated,
// never date-gated. Rollback = flip back to false (one client revert, no data to unwind).
export const PLANTING_REQUIRED_ENABLED = false

// V4-PROJHIDE-001 (types-forward): hide "project" as a USER-FACING concept — project choosers,
// labels, breadcrumbs, nav entries, the /projects tree default, and required-project gates all
// disappear when TRUE, WHILE project_id stays intact in schema/FKs/authz/API read-shapes (projects
// become invisible plumbing). Mirrors the PUBHIDE "hide the concept, server keeps the data" pattern.
// When FALSE (default) every gated surface renders exactly as today — the existing suite is
// unaffected. When TRUE: Garden defaults to a type facet (project tree hidden); EventNew derives
// project_id from the chosen planting (predicated types require a planting — implied HERE, NOT by
// flipping the telemetry-gated PLANTING_REQUIRED_ENABLED above; exempt types fall back to a default
// project_id); project routes stay reachable-but-unlinked; public /garden/:slug sharing is untouched.
// Preview by flipping this const on dev. Criteria-gated, never date-gated. Rollback = flip back to
// false (one client revert, no data to unwind).
export const PROJECTS_HIDDEN = false

// V4-IMGCACHE-001 D-1 (design V102 §B / §5.4): the subscribable image-LIST SWR cache ("slow-tab win").
// When TRUE (default), the photo-list read sites (PhotosWall / PlantingDetail attached-photos /
// LocationDetail) render from a household-scoped in-heap cache and revalidate on every mount; when
// FALSE, useCachedFetch degrades to a plain fetch-on-mount (no cache read/write) so those sites are
// byte-identical to pre-D1. One-toggle rollback lever (module const → "rollback" = flip false +
// redeploy). Heap-only: no service-worker change. Criteria-gated, never date-gated.
export const IMAGE_LIST_CACHE_ENABLED = true
