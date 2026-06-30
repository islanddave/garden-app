// DRG Care Knowledge Engine V1 — public entry. The findings read-model Lambda (slice 6) imports
// composeFinding to turn DB-assembled raw findings into the §2 contract; evidence-ingest (slice 7)
// imports validateFinding. Pure ESM, NO neon/clerk/aws imports → runs in the unit-test env.
export { composeFinding } from './finding.js';
export { validateFinding, CONTRACT_FIELDS } from './contract.js';
export {
  computeConfidence, deriveBand, dominantTier, corroboratorCount,
} from './confidence.js';
export {
  computeDecayState, deriveTrend, isResolvedByContradiction, latestLocalSupportingTs,
} from './decay.js';
export { classifyChannel, deriveUrgency } from './channel.js';
export { resolveAssertionMode } from './assertion.js';
export { renderConfidenceBasis, renderStatement } from './render.js';
export { toPersistRow, fromPersistRow, resolveHybrid, RESERVED_DEFAULTS } from './persist.js';
export * as config from './config.js';
