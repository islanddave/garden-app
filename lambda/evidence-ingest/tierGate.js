// tierGate.js — I40 (BUG-AUTHZLAMBDA-001). Pure (no DB/network imports), so the gate is executed by
// tierGate.test.js rather than only pinned as text. index.js applies it right after validateEvidenceInput.
//
// Any Clerk-authed caller could self-assert the top trust tier: `tier`, `source_tier` or `provenance`
// = 'dave_confirmed' (trust_rank 5). And `source_record_id` is a pipeline-only field under a GLOBAL
// partial unique index, so a stranger could claim one ahead of the pipeline (and probe it: 500 on
// 23505 vs 201). All four are admin-only. Kept OUT of validate.js on purpose: validate.test.js runs
// every TIER, dave_confirmed included, through the validator and must keep doing so.

// Fail-CLOSED admin gate, copied from lambda/tags/validate.js. Unset/empty ADMIN_CLERK_SUBS -> nobody
// is admin -> 403 for all. evidence-ingest has no ADMIN_CLERK_SUBS wired (and no client), so today
// nobody can write these fields over HTTP; wiring it is a deploy-workflow decision, not this file's.
export function isAdmin(userId, env) {
  const subs = (env.ADMIN_CLERK_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return subs.length > 0 && subs.includes(userId);
}

export const TIER_FIELDS = ['tier', 'source_tier', 'provenance'];

// The admin-only fields this validated value sets; [] = an ordinary caller may write it.
export function adminOnlyFields(value) {
  const fields = TIER_FIELDS.filter((k) => value?.[k] === 'dave_confirmed');
  if (value?.source_record_id != null) fields.push('source_record_id');
  return fields;
}
