-- 0a-view.sql
-- BUG-SEEDEDGATE-001 — carry care-profile provenance OUT OF BAND, as view columns, so the cadence
-- resolver stops depending on a magic key inside the merged payload.
--
-- WHY: lambda/daily-plan/engine.js:32 adopts a DB-resolved cadence only when the merged blob carries
-- `_seeded`. Nine cultivar care_profile rows carry other provenance markers instead
-- (`_source: cowork_care_audit_20260709` on eight, `source: dave_confirmed` on Collards), so their
-- researched intervals are ignored and the plantings water on bundled-JSON guesses.
--
-- WHY NOT "just drop the _seeded check": v_resolved_care merges system||cultivar||leaf with the
-- jsonb || operator, which is a SHALLOW, TOP-LEVEL, RIGHT-WINS key merge. The single system row
-- carries water_interval_days: 3, and 146 of 159 cultivar rows express cadence under the DIFFERENT
-- key names water_interval_days_container / _inground. The system value is therefore never shadowed:
-- every resolved_profile on prod carries a plausible 3-day interval whether or not anyone researched
-- the plant. Verified read-only on prod 2026-08-07: all 102 active plantings with no cultivar row
-- resolve to a profile jsonb-EQUAL to the system row. Without a provenance signal a system-only row
-- is indistinguishable from a researched one, so dropping the gate would make every planting look
-- researched and would destroy DRG-CADENCEFLOOR-001's observability signal entirely.
--
-- ═══ WHY TWO COLUMNS AND NOT ONE ═══
-- resolved_scopes — which scopes have a row at all. STRUCTURAL. Observability only.
-- cadence_scopes  — which scopes contributed a non-null CADENCE-BEARING key. LOAD-BEARING; this is
--                   the one the resolver reads.
--
-- They diverge on exactly one live row today, and that row is the whole reason the distinction
-- exists. Collards (variety d80353c0-45bc-407d-923c-73796acdb486) has a cultivar care_profile row
-- that deliberately carries NO watering keys. Its own _scope_note says so verbatim:
--
--   "container-sizing only; watering/thresholds intentionally omitted so resolution still falls to
--    system default (no behavior change)"
--
-- A naive predicate of the form "did a non-system scope contribute?" would adopt that row, move
-- Collards from 2 days (genus:Brassica, real horticultural content in the bundled JSON) to 3 days
-- (the naked system default wearing a DB costume) and do it AGAINST THE ROW AUTHOR'S WRITTEN INTENT
-- — a silent regression shipped inside the fix. cadence_scopes is what prevents that.
--
-- 'system' is deliberately ABSENT from cadence_scopes even though the system row carries
-- water_interval_days. The house constant is not evidence of knowledge. cadence_scopes = {} IS the
-- unresolved signal.
--
-- ═══ WHY jsonb_typeof(...) <> 'null' AND NOT THE ? OPERATOR ═══
-- 20 cultivar rows carry water_interval_days_inground: null — key PRESENT, value JSON null. The ?
-- containment operator returns true for those, which would classify a row with no usable interval as
-- cadence-bearing. The -> IS NOT NULL test alone has the same flaw. Both tests are required.
--
-- ═══ WHY NOT array_remove(arr, NULL) ═══
-- array_remove compares with = and x = NULL is never true, so it returns the array UNCHANGED. The
-- unnest/WHERE IS NOT NULL idiom below is the working form.
--
-- DDL SCOPE: one CREATE OR REPLACE VIEW appending two columns at the end. No table DDL, no new
-- column on care_profile, no enum change, no constraint armed. Verified on live prod before
-- authoring: the view has exactly 2 columns today (leaf_id, resolved_profile) and ZERO dependent
-- objects — no matviews, no dependent views, no non-owner grants, no security_invoker/security_barrier
-- reloptions. Postgres permits CREATE OR REPLACE VIEW to APPEND columns provided existing names,
-- types and order are unchanged; all three are.
--
-- NOTE: this view has no soft-delete filter and never had one — it returns a row per plants row
-- including deleted ones. Any consumer counting rows must scope deleted_at IS NULL itself. Preserved
-- as-is: narrowing it here would be an unrelated behaviour change smuggled into a provenance fix.

BEGIN;

CREATE OR REPLACE VIEW public.v_resolved_care AS
SELECT n.id AS leaf_id,
       ((( SELECT care_profile.profile
             FROM care_profile
            WHERE care_profile.scope = 'system'::care_scope)) || COALESCE(cd.profile, '{}'::jsonb)) || COALESCE(lo.profile, '{}'::jsonb) AS resolved_profile,

       -- STRUCTURAL: which scopes have a row at all. Always contains 'system' (the system row is
       -- unconditional and unique-enforced by care_profile_system_uniq).
       ARRAY(SELECT x FROM unnest(ARRAY[
               'system',
               CASE WHEN cd.id IS NOT NULL THEN 'cultivar' END,
               CASE WHEN lo.id IS NOT NULL THEN 'leaf'     END
             ]) x WHERE x IS NOT NULL)::text[] AS resolved_scopes,

       -- LOAD-BEARING: which scopes contributed a cadence key with a real value. Empty array means
       -- "nothing here knows how often to water this plant" — the resolver must then fall through to
       -- the bundled JSON exactly as it does today.
       ARRAY(SELECT x FROM unnest(ARRAY[
               CASE WHEN cd.profile IS NOT NULL AND (
                      (cd.profile -> 'water_interval_days'           IS NOT NULL AND jsonb_typeof(cd.profile -> 'water_interval_days')           <> 'null')
                   OR (cd.profile -> 'water_interval_days_container' IS NOT NULL AND jsonb_typeof(cd.profile -> 'water_interval_days_container') <> 'null')
                   OR (cd.profile -> 'water_interval_days_inground'  IS NOT NULL AND jsonb_typeof(cd.profile -> 'water_interval_days_inground')  <> 'null')
                    ) THEN 'cultivar' END,
               CASE WHEN lo.profile IS NOT NULL AND (
                      (lo.profile -> 'water_interval_days'           IS NOT NULL AND jsonb_typeof(lo.profile -> 'water_interval_days')           <> 'null')
                   OR (lo.profile -> 'water_interval_days_container' IS NOT NULL AND jsonb_typeof(lo.profile -> 'water_interval_days_container') <> 'null')
                   OR (lo.profile -> 'water_interval_days_inground'  IS NOT NULL AND jsonb_typeof(lo.profile -> 'water_interval_days_inground')  <> 'null')
                    ) THEN 'leaf' END
             ]) x WHERE x IS NOT NULL)::text[] AS cadence_scopes

  FROM plants n
  LEFT JOIN care_profile cd ON cd.scope = 'cultivar'::care_scope AND cd.scope_id = n.variety_id
  LEFT JOIN care_profile lo ON lo.scope = 'leaf'::care_scope     AND lo.scope_id = n.id;

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.3-seededgate-001',
  'SEEDEDGATE (view-only): append resolved_scopes and cadence_scopes to v_resolved_care so care-profile '
  'provenance is carried OUT OF BAND instead of via the in-payload _seeded marker. cadence_scopes is the '
  'load-bearing one — it lists only scopes that contributed a non-null watering-interval key, so a row '
  'like Collards (cultivar profile present, watering deliberately omitted) stays unresolved and keeps '
  'falling through to the bundled JSON. No table DDL; existing columns unchanged in name, type and '
  'order. Rollback re-issues the prior 2-column definition (0r).')
ON CONFLICT DO NOTHING;

COMMIT;
