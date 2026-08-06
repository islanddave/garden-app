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

// BUG-TODAYWATER-001 (2026-08-03): client mirror of the server CARE_TODAY_AWARE_ENABLED env flag. Lets the
// engine suppress watering on rain forecast for TODAY, not just rain already fallen or rain due tomorrow.
// Default OFF and inert. Same lockstep caveat as above — and note the flag is also the rollback lever here:
// this Lambda has no staging surface and its deploy redeploys all 26 functions, so flipping the env var is
// the two-minute revert path and flipping this constant is only the client-side trace.
export const CARE_TODAY_AWARE_ENABLED = false

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

// V4-SPACEPHOTO-001 Lane C (crucible plan V100 §3 / §12a): the Space tier's user-facing photo
// surface — the /space route + page, the More-sheet nav rows, the space hero, and the space
// gallery. The Space ("Gardens at Mathews Ridge") is the property itself, ABOVE the six level-0
// location ZONES; it is the tenant/geo anchor plants.workspace_id points at, and until now it has
// had no identity surface at all. When FALSE (default) the /space routes are NOT registered, the
// nav rows are NOT rendered, and no space request is ever issued — the app is byte-identical to
// today (App.routes.test.jsx's exact 48-route pin is the mechanical proof). This flag is what made
// the code promote-safe AHEAD of its schema: photos.space_id and spaces.featured_photo_id did not
// exist in prod when it shipped, so flipping this then would have 500'd every space read.
// SCHEMA STATUS 2026-08-01: migrations/v4-spacephoto-001 IS APPLIED to prod (and staging) — both
// columns and the 7-clause photos_must_have_parent CHECK are live and convalidated. The schema no
// longer blocks this flip; only the SERVER GATE below does. One-toggle rollback lever (module const
// -> "rollback" = flip false + redeploy). Criteria-gated, never date-gated.
// FLIP ORDER (binding — this flag is CLIENT-side and the photos Lambda carries its OWN server-side
// space gate): [DONE] apply migrations/v4-spacephoto-001 -> [DONE 2026-08-02] set the garden-photos
// Lambda env var SPACE_PHOTOS_ENABLED=true -> [DONE 2026-08-02] flip this true. There is no build
// variable to set: the space id is discovered at runtime from the id-free GET /api/photos/space-hero
// (see lib/spaceId.js).
// WARNING: `aws lambda update-function-configuration` REPLACES the entire env block — restate all
// eight existing vars or PHOTO_CDN_SIGNING_SECRET and GARDEN_HOUSEHOLD_IDS are wiped.
// Client-before-server is the unsafe skew: with the server gate off, `GET /api/photos?space_id=`
// ignores the param and returns the UNFILTERED garden-wide list, so the space gallery would
// silently show every photo in the garden — and the id-free space-hero route is not registered at
// all, so discovery falls through to the handler's 405 and the page shows its error state. That
// ordering constraint is why this flip waited: the server gate went true in prod on 2026-08-01 and
// soaked 48h clean before the client followed.
//
// FLIPPED TRUE 2026-08-02 (V4-SPACECLIENTGAP-001, Stage 2). Rollback is still one const: flip false
// + redeploy. The flag-OFF path is not dead code — it is that lever, and it is covered by
// SpacePhotos.flagOff.test.jsx, which mocks this false and re-pins the exact 48-route table.
export const SPACE_PHOTOS_ENABLED = true

// V4-HIDEQUALITY-001 (BD-006, Dave 2026-07-31): hide the harvest Quality rating from the CAPTURE form
// (EventNew) and the harvest OUTPUT (Harvests list). HIDE, NOT REMOVE — this is the whole ask. The
// harvest_log.quality_rating column, its 1-5 CHECK, the validator in lambda/events/validators.js, the
// create+edit write paths, and every already-logged rating all stay exactly as they are. Dave doesn't
// use the field today; he did not ask to lose the data, and dropping it would not be reversible on
// prod rows.
// Consequence of hiding the capture control: new harvests submit quality_rating: null (the state
// default). That is the correct read of "hide" — no UI to set it means nothing sets it. EventDetail's
// edit path already carries the existing value through untouched (V4-HIDEQUALITY sibling, shipped
// v3.85.0), so editing an OLD harvest PRESERVES its rating rather than nulling it.
// Rollback is one const: flip false + redeploy — both surfaces come straight back. That flag-OFF path
// is NOT dead code, it is the lever, and it is covered by HarvestQuality.flagOff.test.jsx. The single
// pin on this flag's SHIPPED value lives once, in HarvestQuality.flagOn.test.jsx via importActual, so
// a future flip is a deliberate decision rather than a test that quietly needs fixing.
export const HARVEST_QUALITY_HIDDEN = true

// V4-HIDETODAYBAND-001 (BD-002, Dave 2026-08-04): hide the always-on "what needs me today?" bar that
// TodayBand docks above the bottom nav on EVERY authenticated route except /today itself (49 of the 50
// routes). HIDE, NOT REMOVE — that distinction is the whole ask. The component, its ranked todayBand()
// helper, the /api/dashboard signals it reads, the keyboard-chrome inset wiring, and all of its tests
// stay exactly as they are, because the care engine behind it currently only covers watering + pest
// checks and the larger Dr. G / care-engine alerting rework is deliberately deferred until after v4
// settles. When that rework lands, this comes back by flipping one const.
// What hiding reclaims, measured: the shell's paddingBottom is
// `calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + var(--today-band-height, 0px))`
// (App.jsx), and TodayBand is the only writer of --today-band-height (BAND_HEIGHT = 56px). Hidden, the
// component zeroes that var on mount, so every non-/today route gets exactly 56px of viewport back.
// (Painted card is ~54px: a 48px min-height button + 6px container padding; the 56px reserve carried
// 2px of slack.) /today already reserved 0px, so it is unaffected.
// Hiding also stops the per-navigation /api/dashboard refetch the bar issued on mount, in-app nav, focus
// and visibilitychange — dead weight once nothing renders.
// Rollback is one const: flip false + redeploy. That flag-OFF path is NOT dead code, it is the lever,
// and it stays under live test: TodayBand.test.jsx and keyboardChromeSuppression.test.jsx both mock this
// false (partial importOriginal form) and keep exercising the full component. The pin on the SHIPPED
// value lives once, in TodayBand.hidden.test.jsx via importActual. Criteria-gated, never date-gated.
export const TODAY_BAND_HIDDEN = true

// V4-BACKNAV-001 Slice 1 (decision V200 §6) — the shared modal dismiss registry: ONE Escape
// listener resolving the topmost registered surface, replacing per-instance document keydown
// handlers that currently double-fire (a Sheet under an open Lightbox gets BOTH onCloses from one
// Escape). Slice 1 is an ARBITRATION REPAIR, not a behaviour change: the only observable difference
// is that the correct surface closes.
//
// FLAG-OFF IS A TRUE ROLLBACK, and that is load-bearing here in a way it was not for
// OVERLAY_ROUTES_ENABLED (whose own note concedes it stopped being a real lever once later slices
// mutated rendering outside its guard). Every global mutation this slice makes sits INSIDE the
// flag: with it false, useDismissable never registers, the provider binds no listener, and Sheet
// and Lightbox fall back to their own per-instance handlers via `registered === false`. That same
// fallback is what keeps ~380 existing tests — which render these components with no provider —
// passing untouched.
//
// This slice is flagged despite shipping no Back behaviour BECAUSE it is the highest-blast-radius
// change in the program: it touches Sheet.jsx, the primitive behind 8 non-route render sites plus
// every route overlay through OverlayHost. Revert-only was judged insufficient for a 9-site
// primitive whose worst failure mode (a stranded body-scroll lock) has no in-app recovery.
export const DISMISS_REGISTRY_ENABLED = true

// V4-BACKNAV-001 Slice 3a — the Android system Back is arbitrated by the dismiss registry, so Back
// and Escape resolve to the SAME surface. One provider-owned marker per modal session (not one per
// surface). Opted in via `armsBack` at 8 surfaces:
// PlantingDetail Details, both Harvests pickers, Lightbox, CareNeeded bulk, TransplantDatePrompt,
// AddSeeds row edit, SowNow sow sheet, PhotoModal.
//
// NOT BottomNav, though an earlier draft of this comment said so: every row in both its sheets
// closes the sheet AND navigates, which orphans the pushed entry and costs a second Back forever on
// the app's most frequent path. As of Slice 3a that exclusion is MECHANISED, not conventional: the
// `armsBack` prop defaults FALSE, so BottomNav's two Sheets never arm even though they register.
// See src/lib/backNav.js for the rule.
//
// Scoped to an opaque history.state marker, NOT a URL. Needing a history entry is not the same as
// needing a URL: a transient action menu must be poppable by Back but must never be deep-linkable
// (a bookmarked "+LOG menu open" is incoherent). Conflating those two is what forces a false
// route-promotion hybrid.
//
// Rollback is deleting the hook calls. Flag off ⇒ zero pushState calls, zero popstate listeners, and
// history.length after boot identical to pre-change — pinned by the "flag OFF is provably inert"
// suite in BackNav.history.test.jsx, which also carries the real-history harness self-test.
export const BACKNAV_ENABLED = true
