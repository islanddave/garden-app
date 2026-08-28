-- V4-CROPTYPEALIAS-001 — crop_types.search_aliases: a searchable second name per crop type.
--
-- ADDITIVE DDL + DATA. One new nullable column, 54 rows populated, no view change, no constraint,
-- no destructive step. Safe to apply before the code that reads it (Migration Authoring Rule §2),
-- and it MUST be — lambda/dashboard/handlers.js will reference the column, and a handler that
-- SELECTs a column prod lacks 500s every request (L-081).
--
-- ── WHAT IS WRONG ────────────────────────────────────────────────────────────────────────────────
-- V4-SEARCHCROPTYPE-001 (shipped v4.64.0) made search match crop_types.display_name, which is why
-- q=cucumber now finds Suyo Long. It cannot find a crop by a name the crop is not STORED under.
--
-- MEASURED on prod 2026-08-28, per-column, BEFORE this migration. q=cantaloupe matched 2 of the 4
-- melon varieties, and the misses are the point:
--     Cantaloupe      MATCHED — by its own display_name.
--     Green Flesh     MATCHED — but only through care_notes + soil_notes, i.e. prose. Same fragility
--                     v4-peafirstyear-001 objected to: reword the paragraph and the match vanishes.
--     Charentais      MISSED  — and this is the variety Dave actually named.
--     Minnesota Mini  MISSED.
-- So the pre-state was NOT "returns nothing" (an earlier draft of this header said that and was
-- wrong — corrected before the code shipped): it was a partial, prose-dependent 2 of 4 that happened
-- to exclude the one case that prompted the work. Charentais is filed under crop type 'melon',
-- display 'Melon', and no crop type anywhere is named cantaloupe, so nothing about the crop could
-- reach it. With search_aliases the same query returns all four.
--
-- Thirteen crop types already resolve by a second name because it sits INSIDE the display name
-- ('Onion (bunching / scallion)' answers q=scallion). That is the existing mechanism, and this
-- migration deliberately does NOT extend it.
--
-- ── WHY A COLUMN AND NOT MORE PARENTHETICALS ────────────────────────────────────────────────────
-- crop_types.display_name is NOT an internal label. It is SELECTed as crop_name / crop_display_name
-- by lambda/harvests, lambda/preservation, lambda/events, lambda/harvests/watch-route AND
-- lambda/facebook-share/index.js:319 — i.e. it reaches the text of a PUBLIC Facebook/Instagram post.
-- Appending '(cantaloupe / muskmelon / honeydew)' to 'Melon' would publish that string. The ledger
-- item V4-CROPTYPESYNONYM-001 anticipated this and scoped the work as "a schema change (aliases
-- column or table on crop_types)". This is that column: search-only, rendered nowhere.
--
-- ── THE VOCABULARY IS DAVE'S, NOT DERIVED ───────────────────────────────────────────────────────
-- The 54 entries below were put to Dave as a marked list of all 150 display names (published
-- 2026-08-28) and approved as the uncontroversial subset. EIGHT crop types were deliberately
-- EXCLUDED because the obvious synonym would be wrong, and they remain his open decision:
--   marigold  — 'calendula' is Calendula officinalis, a different genus from Tagetes.
--   jade      — 'money plant' collides with the EXISTING money_plant crop type (Lunaria).
--   cilantro  — 'coriander' is correct but also substring-matches culantro + vietnamese_coriander.
--   thunbergia— 'black-eyed susan' alone is Rudbeckia, a different plant.
--   delphinium— 'larkspur' is Consolida, a neighbouring genus.
--   endive / radicchio — chicory/escarole/frisee overlap two Cichorium species across both rows.
--   winter_squash — 'pumpkin' is a categorisation question, not a naming one (butternut/acorn below
--                   are the uncontested part; pumpkin is NOT included).
--   carnation — 'dianthus' is the genus and is broader than the plant.
-- Adding any of those later is a one-row UPDATE; adding them now would encode a judgment Dave has
-- not made.
--
-- ── ONE ENTRY WAS DROPPED AS REDUNDANT, NOT FORGOTTEN ───────────────────────────────────────────
-- 'chrysanthemum' -> 'mum' was on the approved list and is NOT applied: search is ILIKE '%term%'
-- (lambda/dashboard/handlers.js:1157, pat = '%' + esc + '%'), and the string 'chrysanthemum' already
-- ENDS in 'mum', so q=mum resolves it today. The alias would add a row and change no behaviour.
-- Approved count was 55; applied count is 54. Stated here so the gate's 54 is not read as a miss.
--
-- ── SUBSTRING MATCHING IS THE MECHANISM, AND IT CUTS BOTH WAYS ──────────────────────────────────
-- Because matching is substring, an alias widens more than its own row. Deliberate and accepted:
--   q=corn  already hits mache ('Mache (Corn Salad)') and will now also hit dracaena ('corn plant').
--   q=mustard already hits mustard and will now also hit mizuna + tatsoi ('japanese/spinach mustard').
--   q=melon already hits Melon, Watermelon, Bitter Melon, Cucamelon with no aliases at all.
-- None of these is a wrong answer — they are all genuinely that thing — but a future reader should
-- not diagnose them as a defect.
--
-- ── ENVIRONMENT ASYMMETRY ───────────────────────────────────────────────────────────────────────
-- Prod carries 150 crop_types; STAGING CARRIES 98 (measured 2026-08-28), so a subset of the 54 slugs
-- below simply do not exist there and their UPDATEs match zero rows. The ALTER is what staging
-- actually needs: integration CI forks its ephemeral Neon branch from STAGING and applies NO
-- migrations, so if the column is absent there every test touching the search path fails once the
-- code lands. Apply to BOTH environments. The row-count gate is therefore env:prod.

BEGIN;

-- Nullable, no default, no backfill of non-targeted rows: NULL means "no second name recorded",
-- which is the honest state for the 96 crop types that need none and for the 8 held for Dave.
ALTER TABLE public.crop_types ADD COLUMN IF NOT EXISTS search_aliases text;

COMMENT ON COLUMN public.crop_types.search_aliases IS
  'V4-CROPTYPEALIAS-001. Comma-separated alternate names, matched by the search predicate only. '
  'NEVER rendered: display_name is the user-facing and social-post-facing label. NULL = no alias.';

UPDATE public.crop_types ct
   SET search_aliases = v.aliases,
       updated_at     = now()
  FROM (VALUES
    -- Crops with live plantings, ordered as they were put to Dave.
    ('geranium',         'pelargonium'),
    ('melon',            'cantaloupe, muskmelon, honeydew'),
    ('bean',             'green bean, snap bean, string bean'),
    ('tomatillo',        'husk tomato'),
    ('sedum',            'stonecrop'),
    ('coleus',           'plectranthus'),
    ('fittonia',         'nerve plant'),
    ('squash',           'zucchini, courgette'),
    ('beet',             'beetroot'),
    ('sage',             'salvia'),
    ('tradescantia',     'spiderwort, inch plant'),
    ('arugula',          'rocket'),
    ('eggplant',         'aubergine'),
    ('collard',          'collard greens'),
    ('yarrow',           'achillea'),
    ('calibrachoa',      'million bells'),
    ('bay',              'bay laurel'),
    ('bee_balm',         'monarda, bergamot'),
    ('lemon_verbena',    'aloysia'),
    ('kohlrabi',         'german turnip'),
    ('okra',             'lady''s finger, bhindi'),
    ('luffa',            'loofah, sponge gourd'),
    ('bitter_melon',     'bitter gourd, karela'),
    ('cucamelon',        'mouse melon, mexican sour gherkin'),
    ('foxglove',         'digitalis'),
    ('japanese_maple',   'acer'),
    ('dogwood',          'cornus'),
    ('pothos',           'devil''s ivy, epipremnum'),
    ('spider_plant',     'chlorophytum'),
    ('christmas_cactus', 'schlumbergera'),
    ('crown_of_thorns',  'euphorbia milii'),
    ('lithops',          'living stones'),
    -- Seed varieties on hand, nothing planted yet.
    ('winter_squash',    'butternut, acorn squash'),
    ('pea',              'snap pea, snow pea, shelling pea'),
    ('morning_glory',    'ipomoea'),
    ('bok_choy',         'pak choi, pac choi'),
    ('columbine',        'aquilegia'),
    ('four_o_clock',     'mirabilis'),
    ('sunflower',        'helianthus'),
    ('artichoke',        'globe artichoke'),
    ('hollyhock',        'alcea'),
    ('milkweed',         'asclepias'),
    ('poppy',            'papaver'),
    ('stock',            'matthiola'),
    ('viola',            'pansy, johnny jump-up'),
    ('edelweiss',        'leontopodium'),
    ('tweedia',          'blue star, oxypetalum'),
    ('blackberry_lily',  'belamcanda, leopard lily'),
    ('dracaena',         'corn plant'),
    -- Nothing on hand, but a search would still miss them.
    ('chard',            'swiss chard, silverbeet'),
    ('mizuna',           'japanese mustard'),
    ('tatsoi',           'spinach mustard'),
    ('rhubarb',          'rheum'),
    ('pineapple',        'ananas')
  ) AS v(slug, aliases)
 WHERE ct.slug = v.slug
   AND ct.deleted_at IS NULL
   AND ct.search_aliases IS DISTINCT FROM v.aliases;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.64.1-croptypealias-001',
        'CROPTYPEALIAS: adds nullable crop_types.search_aliases (text) and populates 54 rows with '
        'search-only alternate names, so a crop resolves by a name it is not stored under. Measured '
        'per-column on prod 2026-08-28: q=cantaloupe matched 2 of 4 melon varieties — ''Cantaloupe'' '
        'by its own name and ''Green Flesh'' only through care_notes/soil_notes PROSE — and MISSED '
        'both ''Charentais'' (the variety Dave actually named) and ''Minnesota Mini''. Charentais is '
        'filed under crop type ''melon'' / display ''Melon'' and no crop type is named cantaloupe, so '
        'nothing about the crop could reach it; with the alias the same query returns all four. A '
        'COLUMN rather than more '
        'display_name parentheticals because display_name is SELECTed as crop_name by lambda/harvests, '
        'lambda/preservation, lambda/events and lambda/facebook-share/index.js:319 — i.e. it reaches '
        'the text of a PUBLIC Facebook/Instagram post, so widening it would publish the alias list. '
        'search_aliases is matched by the search predicate only and rendered nowhere. Vocabulary is '
        'Dave-approved from a marked list of all 150 display names; EIGHT crop types (marigold, jade, '
        'cilantro, thunbergia, delphinium, endive/radicchio, winter_squash''s pumpkin question, '
        'carnation) were deliberately EXCLUDED because the obvious synonym is wrong, and stay his open '
        'decision. 54 not 55: chrysanthemum->mum was dropped as redundant, since ILIKE ''%mum%'' '
        'already matches ''Chrysanthemum''. Additive and nullable; NULL means no alias recorded. Must '
        'be applied to STAGING as well as prod — integration CI forks from staging and applies no '
        'migrations, so an absent column reds every search test once the code lands.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
