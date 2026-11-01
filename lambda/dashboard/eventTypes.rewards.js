// Reward-bearing event-type partition: the dashboard Lambda's copy.
//
// KEEP IN SYNC with src/lib/eventTypes.js (canonical) and lambda/events/eventTypes.generated.js.
// The drift guard in nonreward-streak.test.js fails the build if this list and the canonical one disagree.
//
// Why a copy: the deploy zips ONLY each Lambda's own directory, so a shared `../shared/` import
// 502s at module load (L-089); lambda/dashboard/streak.js is the same kind of in-dir copy.
// Folding this into scripts/gen-lambda-event-types.mjs is the follow-up; it needs the canonical
// NON_REWARD_EVENT_TYPES constant to exist first.
//
// These event types must grant ZERO xp, ZERO streak credit and ZERO total_events.
// `moisture_check` is an "I checked the soil" tap; rewarding it would make a farmable loop out of
// pressing a button.
export const NON_REWARD_EVENT_TYPES = [
  'moisture_check',
];

// Single predicate for the reward partition. Free-text / non-vocabulary types are rewarded (they
// are real logging actions), so the default is TRUE and exclusion is opt-in.
export function isRewardedEventType(eventType) {
  return !NON_REWARD_EVENT_TYPES.includes(eventType);
}
