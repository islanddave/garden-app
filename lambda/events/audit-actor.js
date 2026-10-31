// audit-actor.js: one write batch that names its actor. Byte copies ship in varieties, events, plants, projects and
// preservation (scripts/lambda-copies.json); each Lambda zips only its own dir.
// The audit triggers read app.actor_clerk_sub, and the neon HTTP driver runs each bare `await sql` as its own
// transaction, so the GUC must be element 0 of the SAME sql.transaction batch (lambda/audit-actor-guc.test.js).

// Byte-equal to varieties/validate.js and photos/photoDelete.js (audit-actor-guc.test.js, audit-actor-empty.test.js).
// Whitespace-only is refused like '' and never trimmed: trimming a real sub would rewrite the identity recorded.
export function auditActor(userId) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new Error('audit actor is absent — refusing to write an unattributable audit row');
  }
  return userId;
}

// The actor is checked and the GUC built BEFORE `build` runs, so a refused actor builds no statement and a unit mock
// that records a statement when it is built still sees the GUC first. A builder that returns an array variable
// (`() => stmts`) has built its templates already; nothing is sent before the check, and the GUC is still element 0.
export function withActor(sql, userId, build) {
  return sql.transaction([sql`SELECT set_config('app.actor_clerk_sub', ${auditActor(userId)}, true)`, ...build()]);
}
