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
// FLIPPED TRUE 2026-08-10 on Dave's approval. D1 falsifier MEASURED MET 2026-08-06: orphan rate for
// REQUIRED types was 0.08% over 30d on 5,156 events — a 4x improvement on the 0.31% of the 31-90d
// window. The server validator stays unflipped BY DESIGN (see the paragraph above) — do NOT "fix"
// the asymmetry; a lockstep server flip would 400 every log from a stale cached PWA bundle.
export const PLANTING_REQUIRED_ENABLED = true

// V4-WATERMATH-001 F0 (2026-08-12): editing a logged watering's amount class (Light/Normal/Deep)
// from event history. CAPTURE is unflagged and live — POST /api/events already stores whatever
// `metadata` it is handed, and the batch path is covered by the events-Lambda merge. EDIT is NOT:
// PUT /api/events/:id neither writes `metadata` nor RETURNs it (lambda/events/index.js — the
// UPDATE's SET list has no metadata column and the RETURNING clause omits it), so a chip shipped
// here today would silently discard the user's correction AND blank the Details block on save,
// because EventDetail re-seeds from the PUT response.
//
// This is default-FALSE for exactly that reason, not out of caution: an edit control that appears
// to work and does nothing is the inert-feature class this project has shipped twice. Flip TRUE in
// the same change that teaches the events-Lambda PUT to merge + return `metadata` (that work is
// NOT in W-F0-LAMBDA's stated scope — it needs its own work item). The chips, the seed from the
// stored row, and the PUT body are all built and tested behind this flag; flipping it is the whole
// client-side cost.
// FLIPPED true 2026-08-12 (garden-bigbites-20260812): the blocking PUT arm landed (persists +
// returns metadata, has-key grammar) and the L-108 staging smoke round-trip proved it end-to-end
// against real Postgres (write:event-metadata-readback + preserved-on-absent-key, run on ac7cb8e).
export const WATER_DEPTH_EDIT_ENABLED = true

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
// FLIPPED TRUE 2026-08-10 on Dave's explicit approval, AFTER the three pre-flip gaps were closed:
//   1. stale `garden.groupBy.v1 = 'none'` migration — every existing user carries it; the render-time
//      fallback to crop_type is now covered by tests that SEED the stale value (the prior suite
//      cleared localStorage, i.e. the one starting state that could not exhibit the bug). The stored
//      value is deliberately NOT rewritten, so a revert restores the user's original preference.
//   2. ProjectNew's Cancel/breadcrumb pointed at /projects, which this flag redirects to /garden —
//      a silent teleport. Both sites now share one flag-aware const.
//   3. the unscoped /api/plants fetch on every log-form mount — MEASURED on prod rather than left as
//      a worry: 255 live plantings, 66 kB uncompressed for the columns the picker uses (~10-15 kB
//      gzipped), vs a scoped median of 1 row. Real but immaterial; not a blocker.
// Ordering mattered and was respected: PLANTING_REQUIRED_ENABLED was flipped and shipped FIRST,
// because EventNew.jsx:716 reads (PLANTING_REQUIRED_ENABLED || PROJECTS_HIDDEN) — flipping this one
// first would have activated the required-planting gate implicitly and contaminated that flag's own
// D1 telemetry.
export const PROJECTS_HIDDEN = true

// BUG-EVENTEDITFIELDS-001 slice 4 — the "move this event to a different planting" control.
// OFF by default. This is the one slice of the ticket that earns a flag: slices 1 and 3 are inert
// server changes (no client sends the keys), but this one puts a control on screen whose failure
// mode is SILENT DATA MOVEMENT, and it introduces genuine PROJECTS_HIDDEN control flow onto
// EventDetail, which previously used that flag only for a breadcrumb and a post-delete nav target.
// Flag OFF leaves EventDetail byte-identical, so the existing suites stay meaningful untouched.
export const EVENT_REANCHOR_ENABLED = false

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
// surface). Opted in via `armsBack` at, originally, 8 surfaces:
// PlantingDetail Details, both Harvests pickers, Lightbox, CareNeeded bulk, TransplantDatePrompt,
// AddSeeds row edit, SowNow sow sheet, PhotoModal — plus BottomNav's two sheets since v4.13.0
// (next paragraph). `grep -rn armsBack src/` is the live list; this one is a summary.
//
// BottomNav's two sheets were EXCLUDED in Slice 3a and ARE INCLUDED AS OF v4.13.0
// (BD-009 / BUG-BACKNAVMORE-001). The exclusion was real: every row in both sheets closes the sheet
// AND navigates, so a plain push from an armed sheet strands the marker entry mid-stack — a
// permanent dead Back on the app's most frequent path. Its cost was the shipped bug: Back over an
// open sheet navigated the tab underneath instead of closing the sheet.
// The orphaning is now solved on the NAVIGATION side rather than by refusing to arm: every
// navigating row is a SheetRowLink (BottomNav.jsx), which replace-navigates when the session marker
// is the current entry, collapsing that entry into the destination. Sign-out — the one row that is
// not a SheetRowLink — applies the same gate at click time (BUG-SIGNOUTBACKRACE-001).
// `armsBack` still DEFAULTS FALSE, so arming remains opt-in per render site; what changed is that
// these two sheets now opt in. See src/lib/backNav.js for the rule and
// src/__tests__/BottomNav.backNav.test.jsx for the pins.
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

// V4-SNAPDEST-001 (BD0806-08, Dave 2026-08-06): "hide Save to Device app-wide".
// Two surfaces carry the control — Snap (CaptureFlow) and Log event (EventNew) — so "app-wide"
// means both, and gating them on one const keeps them from drifting apart.
// WHY hidden rather than fixed: src/lib/saveFileToDevice.js can only reach the gallery via
// navigator.share({files}) (a share sheet the user must complete) with a download fallback. A PWA
// on Chrome Android cannot write to the device gallery directly, so the control cannot do what its
// label promises — which is the finding V4-SNAPCAPTURE-001 (BD0806-06) asked for. Hiding it is the
// honest state until/unless that platform capability changes.
// Rollback is one const: flip false + redeploy and both buttons return. The flag-OFF path is the
// lever, not dead code, and both branches are covered by SaveToDevice.flag.test.jsx.
export const SAVE_TO_DEVICE_HIDDEN = true

// V4-CRITTERQUIET-001 (BD0806-24, Dave 2026-08-06): demote critters VISUALLY on the two work
// surfaces. TRUE = quiet: the Stage-1 arrival animation (App-level CritterArrivalController) does
// not mount, and the Stage-2 tile sprites (PlantingTile -> CritterSprite) render as an invisible
// viewport sentinel instead of a bird over the Garden photo.
//
// SCOPE — what this flag does NOT touch, deliberately:
//   • Accrual. Awarding is server-side only (lambda/events awardCritterServer); no SPA code grants
//     a critter, so hiding every client render changes nothing about critter_state writes.
//   • Mark-viewed SEMANTICS. See the sentinel note in CritterSprite.jsx — the per-critter
//     onIntersect contract is preserved EXACTLY, so `viewed_at` is stamped on the same row set as
//     before. Simply unmounting the sprite would have silently reverted Garden to the legacy BULK
//     mark-viewed path (Garden.jsx flushSeen passes null when no sprite intersected), mass-stamping
//     viewed_at on critters that today would not receive it. That is a data change, not a visual
//     one, and it is not what this row asked for.
//   • Collection (/collection). Critters LIVE there — the dex, CritterOfDay and the arrival bloom
//     are the surface Dave goes to on purpose. Quiet removes the interrupt, not the record.
//   • BottomNavDot, CritterCoachmark, CritterOptInPrompt. Not named by the row; the dot is the
//     ambient "go look" signal that still works, and the coachmark copy explains the DOT (not the
//     tile sprites), so it stays coherent with the sprites hidden.
//
// WHY a flag rather than deleting the render sites: this is a taste call on a shipped reward
// surface, so both arms stay live and covered (the SAVE_TO_DEVICE_HIDDEN idiom above). Flipping it
// back is a one-line revert + rebuild — it is a compile-time const, NOT a runtime toggle, so it
// still needs a deploy; what the flag buys is that the loud arm never rots.
export const CRITTERS_QUIET = true

// BUG-HEICEXIFPASSTHRU-001 — should an UPLOAD be REFUSED when we cannot strip its metadata?
//
// ⚠️ PENDING DAVE. This is the one half of that bug that is a policy call, not a defect fix, and it
// is deliberately parked OFF so the shipped behaviour is unchanged until he rules. The SHARE half
// needs no flag and is already fail-closed unconditionally (harvestPostPhotos.js) — that one only
// made the code do what its own comment already claimed.
//
// WHAT IS BEING ASKED. v4.40.0 strips capture metadata on upload and on share, on Dave's verbatim
// "strip always". The stripper walks JPEG/PNG/WebP; HEIC and AVIF are ISOBMFF and it has no walker
// for them, so today they pass through BOTH layers untouched. Measured on a real macOS-encoded
// HEIC carrying GPS: the S3 PUT body was byte-identical to the camera original, GPS readable off
// the wire. Failing closed here means the upload is REJECTED with a user-facing error — which is a
// user-visible regression on a path that succeeds today, and therefore his call and not a lane's.
//
// FALSE (today, shipped): a HEIC/AVIF uploads and lands in S3 with its GPS. console.warn only.
// TRUE:                   a HEIC/AVIF upload FAILS with UnstrippableFormatError's message, which
//                         useUploadPhoto surfaces verbatim ("...Set the camera to JPEG and try
//                         again."). Nothing is uploaded; the user loses the photo until they
//                         change one camera setting. JPEG/PNG/WebP are unaffected either way.
//
// EXPOSURE, measured 2026-08-20 on prod Neon: 1,282 photo rows, 100% .jpg, one creator (Dave, on a
// Pixel, which shoots JPEG). Zero HEIC has ever been uploaded. So TRUE currently costs nothing and
// FALSE currently leaks nothing — but that is a property of the CORPUS, not of the code, and it
// changes the day a camera setting changes or Jen's device differs. Both arms are covered by tests
// so neither rots; flipping is a one-line compile-time change plus a deploy.
export const PHOTO_STRIP_STRICT_UPLOAD = false
