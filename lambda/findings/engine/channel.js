// Channel gate (spec §2, slice 5). Objective classifier: ambient vs operational.
// `operational` (interrupt-eligible) requires ALL THREE of {imminent, external, irreversible} AND
// must NOT be a missed cadence. Missed cadence → ALWAYS ambient. This boundary is binding: it protects
// interrupt-sensitive Jen, and a fuzzy boundary would violate the Reward-UX may-interrupt rule.
import { IMMINENT_CEIL_HOURS } from './config.js';

export function classifyChannel(harm) {
  const h = harm ?? {};
  if (h.is_cadence_miss === true) return 'ambient'; // missed cadence is NEVER operational.
  const imminent = typeof h.horizon_hours === 'number' && h.horizon_hours <= IMMINENT_CEIL_HOURS;
  const external = h.external === true;
  const irreversible = h.irreversible === true;
  return (imminent && external && irreversible) ? 'operational' : 'ambient';
}

// urgency_level [BUILT but DE-PRIVILEGED] — emitted, but the surface MUST order by trend + decay_state,
// NOT this. One input among many; never the sole field the tab reads (that was the nag).
export function deriveUrgency(channel, severity, decay_state) {
  if (decay_state === 'resolved') return 'low';
  if (channel === 'operational') return 'high';
  if (severity === 'high' && (decay_state === 'fresh' || decay_state === 'decaying')) return 'high';
  if (severity === 'moderate' || decay_state === 'stale_unverified') return 'moderate';
  return 'low';
}
