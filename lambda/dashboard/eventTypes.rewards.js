// Reward-bearing event-type partition — the dashboard Lambda's copy.
//
// KEEP IN SYNC with src/lib/eventTypes.js (canonical) and lambda/events/eventTypes.generated.js.
// eventTypes.rewards.drift.test.js fails the build if this list and the canonical one disagree.
//
// WHY A COPY, AND WHY NOT CODEGEN (yet) — the two options are not equally available here:
//
//   The deploy packages each Lambda by zipping ONLY its own directory
//   (`cd lambda/<fn> && npm install --omit=dev && zip -r ../<fn>.zip .`), so a shared
//   `../shared/…` import is excluded from the bundle and 502s at module load (L-089). That rules
//   out importing src/lib/ or a sibling Lambda's file at runtime, and it is exactly why
//   lambda/dashboard/streak.js is already a byte-identical copy of lambda/events/streak.js — the
//   documented, intentional precedent this file follows.
//
//   The other option was extending scripts/gen-lambda-event-types.mjs to emit a second generated
//   copy into this directory, which is strictly nicer. It is not available on this branch: that
//   generator imports src/lib/eventTypes.js and re-emits what it finds, and NON_REWARD_EVENT_TYPES
//   does not exist there yet — it lands with the V4-WATERMATH-001 F0 events work (lane
//   waterevents). Wiring the generator now would emit `undefined` and, worse, editing
//   src/lib/eventTypes.js to add the constant would collide head-on with that lane over the same
//   symbol. So: duplicate now, with a drift guard that turns strict the moment the canonical
//   constant merges. Folding this into the generator is the correct follow-up and the drift test
//   names it.
//
// WHAT IT IS FOR: these event types must grant ZERO xp, ZERO streak credit and ZERO total_events.
// `moisture_check` is a "I checked the soil" tap — rewarding it would make a farmable loop out of
// pressing a button, which is the whole reason the partition exists.
export const NON_REWARD_EVENT_TYPES = [
  'moisture_check',
];

// Single predicate for the reward partition. Free-text / non-vocabulary types are rewarded (they
// are real logging actions), so the default is TRUE and exclusion is opt-in.
export function isRewardedEventType(eventType) {
  return !NON_REWARD_EVENT_TYPES.includes(eventType);
}
