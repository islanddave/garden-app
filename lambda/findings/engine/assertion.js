// Assertion-mode resolution (spec §2, slice 2 — the PRIMARY cold-start path).
// V1 default is `assert`, EXCEPT three ask-driving conditions:
//   - cold-start: no first-party LOCAL supporting evidence (confidence_local === 0)
//   - uncorroborated: corroborator_count === 0 (resting only on claude_distilled / transferable_prior)
//   - stale: decay_state === 'stale_unverified' (a once-fresh belief that aged out of verification)
// This satisfies §3.4 / L-152 "ask, don't assert" and makes the cold-start state the normal V1 posture.
import { CORROBORATION_MIN } from './config.js';

export function resolveAssertionMode({ confidence_local, corroborator_count, decay_state }) {
  if (confidence_local === 0) return 'ask';
  if (corroborator_count < CORROBORATION_MIN) return 'ask';
  if (decay_state === 'stale_unverified') return 'ask';
  return 'assert';
}
