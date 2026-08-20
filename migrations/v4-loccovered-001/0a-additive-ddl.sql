-- 0a-additive-ddl.sql
-- V4-COVEREDNOTMODELLED-001 — public.locations.covered, the editable coverage flag.
--
-- NOT APPLIED as of authoring (2026-08-20). This lane executed no DDL anywhere — not on staging,
-- not on prod. Apply order per gates.yml: staging -> rehearse 0r -> re-apply -> prod -> dev push ->
-- promote. CI's integration job forks its ephemeral Neon branch from STAGING and does NOT apply
-- migrations, so the reader in daily-plan/handler.js must not reach dev until this has landed on
-- staging, or every integration test fails on a missing column and blocks the whole fleet promote.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT THIS COLUMN IS, AND WHAT IT IS NOT
--
-- It is the durable replacement for the NAME-MATCHING arm of daily-plan/handler.js's `cov` lateral:
--
--     when l.name in ('Stable','House') then true
--
-- That predicate is named as the defect in three separate places in the tree already —
-- handler.js:703 ("V1.1 replaces this with an editable locations.covered flag"),
-- locations/validate.js:24 ("Name-matching is the actual defect; the durable fix is the explicit
-- editable locations.covered boolean"), and locations/index.js:285 ("Renaming remains possible and
-- is not guarded here — a rename is a legitimate edit whose care consequence is the name-matching
-- predicate's fault"). This bundle is that fix.
--
-- It is NOT a new coverage MODEL. A three-state coverage concept already exists and is live in the
-- watering engine (cov.state -> rain_exposed_resolved / frost_covered_resolved -> engine.rainClass,
-- engine's `_exposed`, ledger.exposureClass, frostClass.isCoveredDefault). This column changes only
-- WHERE the three-state gets its TRUE/FALSE from — an editable row property instead of a free-text
-- name — and deliberately preserves the existing semantics, including the deliberately-non-
-- complementary fail-safe split. Graded coverage, "reduced vs zero rain", and seasonal date ranges
-- are all OUT OF SCOPE and are flagged for Dave in the lane report; do not infer them from this
-- column's existence.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY NULLABLE, AND WHY THERE IS NO CHECK CONSTRAINT
--
-- NULLABLE is what makes this additive and therefore safe to apply while the CURRENT code is still
-- deployed: the running daily-plan Lambda never mentions `covered`, so a nullable column with no
-- default is invisible to it. The three-state is also load-bearing rather than incidental — NULL
-- means "not stated", which the reader resolves via the type_label fallback, and `l.id is null`
-- (no location at all) continues to mean "unknown" and continues to deny rain credit.
--
-- NO CHECK CONSTRAINT, deliberately and permanently. Adding a column is backward-compatible;
-- ARMING a constraint over it is a deploy, not a migration, because it breaks the still-deployed
-- old writer that does not know to satisfy it. That is not hypothetical here — it is how harvest
-- logging went down on 2026-08-03. A boolean column has no vocabulary to police anyway, so there is
-- nothing a CHECK would buy. gates.yml asserts the ABSENCE of any CHECK referencing this column, so
-- a later session that reaches for one reds instead of shipping it.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- IF NOT EXISTS is deliberate: 0b re-runs are idempotent (see its WHERE clause) and the apply
-- runbook rehearses 0r between the staging apply and the prod apply, so this statement is expected
-- to run more than once against the same branch.

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS covered boolean;

COMMENT ON COLUMN public.locations.covered IS
  'V4-COVEREDNOTMODELLED-001. Editable coverage flag read by daily-plan/handler.js''s cov lateral. '
  'TRUE = under cover (no rain reaches plantings here). FALSE = open to the sky. '
  'NULL = not stated; the reader falls back to the type_label heuristic. '
  'Deliberately unconstrained — see 0a-additive-ddl.sql on why no CHECK is armed over it.';
