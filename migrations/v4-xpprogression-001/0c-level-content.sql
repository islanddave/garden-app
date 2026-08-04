-- V4-XPPROGRESSION-001 / 0c — named content above level 9, so the ladder does not die where the
-- old one did.
--
-- WHY THIS FILE EXISTS, AND WHY IT IS SEPARATE
-- 0a's header rejects the historical ladder partly because "the table stops at 9, so the bar dies
-- the moment it is reached." That criticism applies to 0a itself unless this file ships. Replacing
-- a threshold table with a formula solved the ARITHMETIC problem — the formula runs forever — but
-- the CONTENT still stopped at 9. `level_9` "Master" is the last named thing in the entire reward
-- system, and at the measured rate the main user reaches it around 2026-08-27, with two months of
-- season left and nothing above it but unnamed integers on a bar whose bands are visibly widening.
-- Shipping the `WHEN 'level'` evaluator branch and NOT shipping the content it exists to enable
-- would be the same defect this whole ticket is fixing, one rung higher up.
--
-- ZERO CODE. The evaluator branch added in this change dispatches on `trigger_type = 'level'`
-- generically and reads `trigger_value->>'level'`; src/pages/Achievements.jsx already renders the
-- locked hint for that type ("Reach level N"). These four rows are therefore pure content — they
-- need no Lambda change, no frontend change, and no further migration.
--
-- SEPARATE FILE ON PURPOSE. 0a/0b fix a defect; this file adds CONTENT, which is a product call.
-- It is packaged so it can be dropped, edited, or deferred without touching the defect fix — names,
-- XP values and levels below are a proposal, not a mechanism. If Dave wants different names or a
-- different cadence, edit this file; nothing else in the migration depends on it.
--
-- PACING at the main user's measured peak-season rate (112.5 XP/calendar day), and honestly
-- discounted for the off-season the rate does not cover:
--   level_12  11,900 XP   ≈ 33 d after level 9 at peak; realistically ~Nov 2026 as income falls
--   level_15  17,600 XP   ≈ next spring
--   level_20  27,100 XP   ≈ the 2027 season
--   level_25  36,600 XP   ≈ 2028
-- XP rewards escalate 250/400/750/1000 against level_9's 500 — a capstone should not be the largest
-- grant available for the rest of the app's life. All four are non-secret: an ADHD-friendly app
-- should show the user what is ahead of them, and a visible next rung is the entire point of adding
-- these. sort_order continues the 60/61 block that level_5/level_9 already occupy.
--
-- IDEMPOTENT: ON CONFLICT (slug) DO NOTHING, matching the v1-2a-2 seed precedent — re-running
-- changes nothing, and it will never overwrite a row Dave has since edited by hand.
-- SAFE AGAINST THE DEPLOYED LAMBDA: `level` is already in the live achievements_trigger_type_check
-- enum (added by v1-2a-2/0a), so these rows insert cleanly, and an evaluator without the branch
-- simply never selects them — which is exactly today's behaviour for level_5/level_9.

INSERT INTO public.achievements
  (slug, name, description, emoji, xp_reward, trigger_type, trigger_value, is_secret, is_active, sort_order)
VALUES
  ('level_12', 'Steward',              'Reached Level 12 — Steward of the garden.',
     '🌿', 250,  'level', '{"level": 12}'::jsonb, false, true, 62),
  ('level_15', 'Cultivator',           'Reached Level 15 — Cultivator.',
     '🌻', 400,  'level', '{"level": 15}'::jsonb, false, true, 63),
  ('level_20', 'Elder',                'Reached Level 20 — Elder of the garden.',
     '🌳', 750,  'level', '{"level": 20}'::jsonb, false, true, 64),
  ('level_25', 'Keeper of the Ridge',  'Reached Level 25 — Keeper of the Ridge.',
     '🏔️', 1000, 'level', '{"level": 25}'::jsonb, false, true, 65)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.schema_version (version, description)
VALUES ('4.22.2-xpprogression-001-content',
        'four named level achievements above level_9 (12/15/20/25) so the ladder has content past the capstone')
ON CONFLICT (version) DO NOTHING;
