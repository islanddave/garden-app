# GATE-A — device check, garden-app on your phone

**Who:** Dave. **How long:** ~10 minutes. **Where:** the garden app **installed from your home screen**, not a Chrome tab. That difference matters — an installed app has no browser UI, so Back at the very start of the app exits it instead of doing nothing.

**Why this exists.** Everything that a test can check on a laptop has been checked. What's left is what a laptop physically cannot do: press a real Android Back button, swipe from the edge of a real screen, and exit a real installed app. The Back button was rewritten across eight screens; this is the only way to know it works.

**How to use this file:** do the steps in order, tick a box for each, and write anything odd in the notes line. If a step fails, stop and say so — a failure here is worth more than finishing the list.

---

## Step 0 — Check you're on the new version (do this first)

If you're on an old copy of the app, everything below tells us nothing. The app can hold onto old code even after the site updates, so this check is not optional.

1. Fully close the app — swipe it out of your recent-apps list, don't just go to the home screen.
2. Open it again.
3. Go to **Settings → About** and read the version number.

**PASS if:** it matches the version we just shipped. I'll tell you the number when we ship: **__________**. (The first run of this file was for 3.104.0; every run since names its own.)
**If it does not match:** stop. Everything after this is meaningless. Give it a few minutes, force-close and reopen, and check again.

Version shown: ______   ☐ matches → carry on   ☐ doesn't match → **stop here**

---

## Step 1 — Back closes the top thing only

This is the main event. When two things are open on top of each other, Back should close **only the top one**.

**1a — the easy version (do this one first)**

1. Open any planting.
2. Tap one of its photos so it fills the screen.
3. Press **Back once.**

**PASS if:** the photo closes and you're looking at the planting again.
**FAIL if:** you land back on the Garden list, or anywhere that isn't the planting.

☐ PASS ☐ FAIL — notes: ______________________________________________

**1b — the harder version (this is the one that was broken)**

You need a pop-up box sitting on top of a sheet. The way to get one:

1. Go to **Sow Now** and start sowing something — you should get the sow sheet sliding up.
2. In that sheet, tap the **variety** field and type a name **very close to one you already have** (e.g. if you have "Cherokee Green", type "Cherokee Greens").
3. Tap the option to **create it as a new variety**.
4. The app should stop you with a box titled **"Similar variety already exists"**, offering *Use existing*, *Create anyway*, *Cancel*.
5. With that box showing, press **Back once.**

**PASS if:** only the "Similar variety already exists" box closes. The sow sheet is still there, still showing what you typed.
**FAIL if:** the whole sow sheet disappears too, or the app leaves the page.

☐ PASS ☐ FAIL ☐ couldn't get the box to appear — notes: ____________________

*(If you can't make that box appear, don't force it — tell me and I'll find you another way to stack two things. Step 1a still covers most of it.)*

---

## Step 2 — Back doesn't get stuck

1. Open a planting.
2. Open its **Details** panel.
3. Tap a link inside Details that takes you somewhere else.
4. Press **Back once.**

**PASS if:** one press brings you back to the planting.
**FAIL if:** the first press does nothing at all — the screen just sits there — and you need a second press. That's the specific bug this step is hunting.

☐ PASS ☐ FAIL — notes: ______________________________________________

---

## Step 3 — Back at the very start

1. Go to the **Today** tab with nothing open — no sheets, no photos, no pop-ups.
2. Press **Back.**

**PASS if:** the app closes or minimises cleanly, the way any app should.
**FAIL if:** it appears frozen, or something is still open behind it.

☐ PASS ☐ FAIL — notes: ______________________________________________

---

## Step 4 — Swiping vs the Back button

Android gives you two ways to go back: swiping in from the edge of the screen, and the Back button (if you use 3-button navigation). They can behave differently, because the system grabs a strip along the screen edge before the app ever sees your finger. On screens where you also swipe sideways for other reasons, those two can fight.

Try **both** ways on **both** of these:

- **A photo open full-screen** — swipe sideways to move between photos. Does a sideways swipe that starts near the screen edge move to the next photo, or does it go back?
- **A planting page** — swipe sideways to move between plantings. Same question.

**PASS if:** both ways of going back close the screen as expected, **and** a sideways swipe you meant as a swipe doesn't get taken as a Back.
**FAIL if:** swiping from the edge keeps kicking you out when you meant to move to the next photo/planting.

☐ PASS ☐ FAIL — notes: ______________________________________________

*(If this one fails, it's a layout problem, not a code bug — the fix is leaving a margin at the screen edge. Nothing to panic about.)*

---

## Step 5 — Can you still scroll? (check after every step above)

After each of steps 1–4, 6 and 7, just try scrolling the page up and down.

**PASS if:** it scrolls normally.
**FAIL if:** the page is frozen and won't scroll. This is the one problem with no way out inside the app — you'd have to force-close it. That's exactly why it gets checked after every step instead of once.

☐ after 1 ☐ after 2 ☐ after 3 ☐ after 4 ☐ after 6 ☐ after 7 — notes: _____________________

---

## Step 6 — Closing Search or Log with ✕ (added with the overlay-close fix, BUG-OVERLAYDISMISSREKEY-001)

Before this fix, closing Search or a Log sheet with its ✕ left the page underneath in your history twice. So the first Back afterwards did nothing, and the list stopped remembering how far down you were. Open each sheet **fresh**: one left open from before the update still closes the old way, and it will look like a fail when it isn't.

- **6a.** Open a page by tapping into it from another page (for example a planting from your Garden list). Tap **Search** at the top, then close it with **✕**. Press **Back once.**
  **PASS if:** you leave that page. **FAIL if:** the first Back does nothing. (On the page the app opens on, leaving means the app closes. That is a PASS too.) ☐ PASS ☐ FAIL
- **6b.** Tap **+LOG** at the bottom, choose **Log an event**, then close it with **✕**. Press **Back once.** Same PASS/FAIL as 6a. ☐ PASS ☐ FAIL
- **6c.** Tap **Search**, search for one of your plantings, and tap **Peek** on it. Then close Search with **✕**. Press **Back once.**
  **PASS if:** you leave the page, and Search does **not** pop back up. ☐ PASS ☐ FAIL
- **6d.** Go to **Seeds → Saved seeds** and scroll well down. Open **Search** and close it with **✕**. The list should not move. Then open a seed lot and press **Back**.
  **PASS if:** the list stayed put when Search closed, and Back puts you at the same spot. **FAIL if:** it jumps, or Back lands at or near the top. ☐ PASS ☐ FAIL
- **6e (only if it happens to come up).** If the app asks you to refresh for an update while Search is open, refresh and then close Search with **✕**.
  **PASS if:** you land on the page with no start-up screen, and the list is where you left it. ☐ PASS ☐ FAIL ☐ didn't come up

The next three check the follow-up fix (BUG-OVERLAYRELOADKEY-001): coming **Back** from a Search result re-opens Search over the list, and the list used to forget your place from then on. Don't judge by where the list sits the moment Search closes — the phone puts it back there by itself even without the fix. That is why 6g and 6h scroll a little first.

- **6f.** Go to **Seeds → My seeds**. Open the **Pepper** group, scroll until a pepper near the bottom is in the middle of the screen, and tap it so it opens (you see **Open details →**). Tap **Search**, type *pepper*, and tap the first result's name. A new page opens. Press **Back once** (Search comes back up), then close Search with **✕**.
  **PASS if:** the pepper you opened is still open, in the same place on screen. **FAIL if:** it is closed, the Pepper group is folded, or the list jumped. ☐ PASS ☐ FAIL
- **6g.** Go to **Seeds → Saved seeds** and scroll well down. Tap **Search**, type any word, tap the first result's name, press **Back once** (Search comes back up), and close it with **✕**. Now scroll the list **up by about two cards** and note the name of the card in the middle of the screen. Tap that card's name, then press **Back once.**
  **PASS if:** that same card is in the middle of the screen. **FAIL if:** you land a couple of cards away (where you were before Search) or near the top. ☐ PASS ☐ FAIL
- **6h.** Same as **6g**, but close Search with the **phone's Back gesture** instead of ✕. After the result, go Back twice: the first brings Search back, the second closes it.
  **PASS / FAIL** as 6g. ☐ PASS ☐ FAIL

*Not on this list on purpose:* a double tap on **✕** is checked by machine (gate:seeds-scroll flow g), because on a phone a second tap can land on the page under it.

Notes: ______________________________________________

---

## Step 7 — Pages open at the top, Back keeps your place (BUG-DETAILPAGESCARRYSCROLL-001)

Before this fix, a page you opened from a long, scrolled list often opened part-way down, and Back from an event went to the top of its planting. Do Step 0 first. Use normal signal for 7a–7d.

**What "opens at the top" looks like:** the first line under the app's top bar is a small grey trail that starts with **Home ›** (for example "Home › Event"). If that trail is hidden and the page starts at the big title or lower, the page did **not** open at the top.

- **7a — Zones.** Go to **More → Zones** and scroll down until the last rows are on screen. Remember the row you will tap and the row just above it. Tap the row's name.
  **PASS if:** the new page's first line is the "Home › …" trail with the place's name in big green letters under it. Then press **Back**. PASS if the two rows you remembered are back in the same spots on the screen.
  **FAIL if:** the trail is hidden when the page opens, or Back shows different rows. ☐ PASS ☐ FAIL
- **7b — Event log.** Open a planting with at least 20 events. Scroll down its Event log **without tapping "Show more"** until an event near the end of the list is in the middle of the screen. Remember its date. Tap it.
  **PASS if:** the event page's first line is the "Home › Event" trail. Then press **Back**. PASS if the event with that date is back in the middle of the screen.
  **FAIL if:** the trail is hidden, or Back lands at the top of the planting or on different events. ☐ PASS ☐ FAIL
- **7c — Garden, three times.** Scroll well down **Garden** and remember the planting in the middle of the screen. Tap the **Today** tab, then the **Garden** tab. Do this three times, at a different spot each time.
  **PASS if:** all three times, the planting you remembered is back in the middle of the screen.
  **FAIL if:** even once Garden comes back at the top or somewhere else. ☐ PASS ☐ FAIL
- **7d — Back to a page you left at the top.** Go to **Today** and make sure the big **Today** heading and the date are showing. Tap anything on Today that opens a new page. Scroll that page all the way to the bottom, then press **Back**.
  **PASS if:** Today shows its big heading and the date straight away.
  **FAIL if:** Today comes back part-way down. ☐ PASS ☐ FAIL
- **7e (optional — only on weak signal).** Do 7a up to tapping the row. On the place's page press **Back** and at once press the power button to turn the screen off. Wait 30 seconds, then turn the screen on and unlock.
  **PASS if:** the two rows you remembered are on screen. **FAIL if:** the list is at or near its top.
  ☐ PASS ☐ FAIL ☐ no weak signal

Notes: ______________________________________________

---

## Result

| | |
|---|---|
| Date | |
| Version tested | |
| Overall | ☐ all passed ☐ something failed (say which) ☐ voided at step 0 |

Write the result here rather than only telling me in chat — a gate whose outcome isn't recorded is the situation this file was created to end.

---

## Run log

### 2026-08-06 — BASELINE run against production (pre-Slice-3a)

Operator: Dave. Version tested: **prod as of 2026-08-06 — v3.103.0** (the per-surface `useBackDismiss` implementation; Slice 3a was on `dev`, unshipped).

| Step | Result | Notes |
|---|---|---|
| 0 — version check | not recorded | Ran against live prod; see caveat below. |
| 1 — Back closes the top thing only | **PASS** | "Exactly right on everything I'm seeing… everywhere I've tried it, it works as expected." Not every surface exercised. |
| 2 — Back doesn't get stuck | **PASS** | "Back doesn't seem to get stuck anywhere." No dead first press observed. |
| 3 — Back at the very start | **PASS** | Exits cleanly. |
| 4 — swipe vs Back button | **PASS** | Photo paging behaves; planting-page swipe behaves. Edge-gesture does not steal an intended content swipe. |
| 5 — scroll still alive | **PASS** | Scrolls after every sequence. No stranded scroll lock. |

**What this run establishes, and what it does not.** It is a **baseline**, not the Slice 3a gate. v3.103.0 shipped with zero functional verification, so the open question was whether the back-nav Dave has today already works — and it does. That matters because it makes any post-3a regression **attributable**: if Back misbehaves after the promote, it is Slice 3a, not a pre-existing fault. Without this run that distinction was unavailable.

**Therefore GATE-A must be run AGAIN after v3.104.0 reaches prod** — same six steps, with Step 0 reading 3.104.0. That second run is the actual gate.

**Caveat carried forward:** Step 0's version was not recorded on this run. It is safe to treat it as v3.103.0 because that was prod all day and nothing else had been promoted, but the next run must capture the number — the whole point of Step 0 is that an unrecorded version makes every later observation unattributable.

---

<!-- Maintainer notes — not for the operator.
     Step 1a exercises topmost-wins across layers (Lightbox DIALOG over a Sheet).
     Step 1b exercises a registry-only surface (armsBack=false) on top of an armed one — the case
       where gating dismissal on armsBack produced a dead press. VarietyPicker's ConflictModal,
       triggered by a 409 fuzzy-match on create (src/components/VarietyPicker.jsx:228).
     Step 2 is the orphan branch: an entry stranded by navigating while a surface was open.
     Step 3 is Back at history index 0, which jsdom reports as a silent no-op and cannot test.
     Step 4 is Android's system-gesture edge exclusion; the platform exposes no
       setSystemGestureExclusionRects analogue, so mitigation is layout-only.
     Step 5 is the refcounted scroll lock in Sheet.jsx — stranded = body{overflow:hidden}, no
       in-app recovery.
     Everything mechanically checkable lives in backNav.test.js, BackNav.history.test.jsx,
     layerMatchesPaint.test.js and the global afterEach in setup.ts. Keep this list at ~6 steps;
     if it grows, cut automated-checkable items, never device-only ones. -->
