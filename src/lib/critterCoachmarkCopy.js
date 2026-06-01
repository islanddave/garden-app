// Coachmark copy variants — MVP-Critter Phase B.
// Spec: revision §3.7 (anchored to garden-view-enter, NOT critter-state-change).
// V100 binding: §5 Stage 3 "coachmark explains the dot the user has been seeing."
// Walkthrough surface: jen-walkthrough-log.md row #4 task 7 (folded in per §3.21).
//
// Pattern grammar:
//   • Ambient (no overlay, no urgency, no command verbs)
//   • Neutral verbs only (mirrors Stage 1 critterCopyVariants discipline)
//   • Names the dot conceptually without DOM-anchoring (the dot lives in BottomNav,
//     the coachmark renders in Garden — the copy bridges them verbally)
//   • Reads as noticing-an-event, NOT app-talking-at-you
//
// Variants are 4 here (Jen-walkthrough will trim to 1; the rest are alternates so
// re-walkthrough doesn't require regenerating copy). Default for first build = #1.

export const COACHMARK_COPY_VARIANTS = Object.freeze([
  'That little dot you keep seeing? A visitor stopped by your garden.',
  'When you see this dot, a critter heard about something and visited.',
  "The dot means there's someone in your garden — peek when you have a moment.",
  'A small dot here means a visitor came by. Nothing to do — just letting you know.',
])

// Default variant for first build (Jen-walkthrough validates / swaps).
export const DEFAULT_COACHMARK_COPY = COACHMARK_COPY_VARIANTS[0]

// Min visible-time before coachmark dismissal writes coachmark_seen_at (§3.7).
// Closes the ADHD accidental-route-change footgun: < 1500ms in garden view = not dismissed.
export const COACHMARK_MIN_VISIBLE_MS = 1500

// Threshold for opt-in prompt eligibility (§3.9 step 4): 3+ critters earned.
// V101 (2026-06-01): baseline residents retired — ALL species (incl. robin/honeybee 1,2) count.
export const OPT_IN_CRITTER_THRESHOLD = 3

// Opt-in copy (verbatim from revision §3.8 — purely informational, NO nav button).
// "ping" specifically may land differently for ADHD interrupt-sensitive Jen than V100
// verbatim suggests — Jen-walkthrough task 7 (§3.21) probes this.
export const OPT_IN_COPY_VARIANTS = Object.freeze([
  'You can enable a gentle ping for critter visits in Settings → Notifications.',
  // Alternates probing the word "ping":
  'You can enable a quiet notification for critter visits in Settings → Notifications.',
  'Want a heads-up when a visitor stops by? Settings → Notifications.',
])

export const DEFAULT_OPT_IN_COPY = OPT_IN_COPY_VARIANTS[0]
