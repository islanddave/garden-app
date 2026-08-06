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

**PASS if:** it matches the version we just shipped (I'll tell you the number when we ship — it will be **3.104.0**).
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

After each of steps 1–4, just try scrolling the page up and down.

**PASS if:** it scrolls normally.
**FAIL if:** the page is frozen and won't scroll. This is the one problem with no way out inside the app — you'd have to force-close it. That's exactly why it gets checked five times instead of once.

☐ after 1 ☐ after 2 ☐ after 3 ☐ after 4 — notes: _____________________

---

## Result

| | |
|---|---|
| Date | |
| Version tested | |
| Overall | ☐ all passed ☐ something failed (say which) ☐ voided at step 0 |

Write the result here rather than only telling me in chat — a gate whose outcome isn't recorded is the situation this file was created to end.

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
