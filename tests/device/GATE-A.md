# GATE-A — device probe (garden-app, installed Android PWA)

**Status before this file existed:** GATE-A was named as a blocking gate in two source comments and had **no artifact** — no script, no owner, no pass criterion, no recorded outcome. v3.103.0 shipped with it "outstanding," which is unfalsifiable: there was nothing to be outstanding against. This file is that thing.

**Owner:** Dave (sole operator and verifier).
**When:** before promoting any release that changes dismissal or history behaviour.
**Budget: 6 steps. Deliberately.** A long script does not get run — v3.103.0 is the evidence. Everything mechanically checkable has been moved into automated tests (`backNav.test.js`, `BackNav.history.test.jsx`, `layerMatchesPaint.test.js`, the global scroll-lock detector in `setup.ts`). What remains here is only what jsdom **structurally cannot express**. If this list grows, cut automated-checkable items, never device-only ones.

**Device:** Chrome on Android, **installed PWA** (home-screen icon), *not* a browser tab. The two differ: in `display: standalone` there is no browser UI to fall back to, so Back at the root minimises or exits the app rather than being a silent no-op.

---

## What is NOT on this list, and why

Resolved from source rather than deferred to a device: **whether Android delivers Back as a history traversal or as a `CloseWatcher` close-request.** This app constructs no `CloseWatcher`, registers no `beforeunload`, uses no native `<dialog>`/`showModal()` and no `popover` attribute — every modal surface is a `role="dialog"` div. Chrome only routes a close-request to `CloseWatcher` when one of those exists, so within this app Back can only arrive as a history traversal → `popstate`. That was GATE-A's original stated blocker; it is answered.

---

## Step 0 — Bundle identity (VOID check, do this first)

Every observation below is worthless if the running bundle is not the one under test. The service worker serves JS **cache-first** while navigations are network-first, so the HTML shell can be fresh while the JS is stale — a bug report minutes after a promote may be against the *previous* build.

1. Fully close the PWA (swipe it out of recents), reopen.
2. Settings → About → note the version.
3. Compare against `curl -s https://garden.futureishere.net/releases.json | head -3`.

**If they differ, STOP. The run is VOID** — discard every later observation, wait for the update, and start again.

| | |
|---|---|
| Expected version | |
| Reported version | |
| Result | ☐ MATCH → continue ☐ MISMATCH → **VOID** |

## Step 1 — Back/Escape parity (the shipped defect Slice 3a fixes)

There is no Escape key on Android, so this is only observable on a device.

Open SowNow → start a sow → trigger a variety-name conflict so the ConflictModal appears **on top of** the sow sheet → press system Back **once**.

**PASS iff:** only the ConflictModal closes. The sow sheet is still open and still shows what you typed.
**FAIL looks like:** the whole stack tears down, or the sheet closes and the modal disappears with it.

☐ PASS ☐ FAIL — notes:

## Step 2 — Orphan / dead press

Open a planting → open its **Details** fly-up → tap a link inside it → land on the new page → press Back **once**.

**PASS iff:** one press returns you to the planting.
**FAIL looks like:** the first press does nothing at all (the screen does not change), and a second press is needed.

☐ PASS ☐ FAIL — notes:

## Step 3 — Root exit

From the Today tab with nothing open, press Back.

**PASS iff:** the documented root behaviour happens — the app minimises/exits cleanly. It must **not** appear frozen, and it must not leave a surface open behind it.

☐ PASS ☐ FAIL — notes:

## Step 4 — Edge-swipe vs 3-button, on the two gesture surfaces

Android's system back gesture claims a strip at the screen edge **before web content sees the touch**, and the web platform exposes no way for a page to reserve it (no `setSystemGestureExclusionRects` analogue). So these two surfaces need both input methods tested, and a failure here has a layout fix, not a code fix.

Do each of these twice — once with the **edge swipe**, once with the **3-button Back** if enabled:

- **Lightbox** (open a photo full-screen): does a horizontal swipe near the edge page the photo, or fire Back?
- **PlantingDetail pager** (swipe between plantings): same question.

**PASS iff:** both input methods dismiss the surface as expected, and an intended *content* swipe starting near the edge is not stolen by the system gesture.

☐ PASS ☐ FAIL — notes:

## Step 5 — Scroll alive (re-check after EVERY sequence above)

After each of steps 1–4, scroll the page.

**PASS iff:** it scrolls. A stranded scroll lock has **no in-app recovery** short of force-closing the app — this is the worst failure mode in the dismiss program, which is why it is checked after every sequence rather than once at the end.

☐ 1 ☐ 2 ☐ 3 ☐ 4 — notes:

---

## Result

| | |
|---|---|
| Date | |
| Build under test | |
| Overall | ☐ PASS ☐ FAIL ☐ VOID (step 0) |

Record the outcome here rather than in a chat message — a gate whose result is not written down is the state this file was created to end.
