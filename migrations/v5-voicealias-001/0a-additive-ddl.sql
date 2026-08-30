-- 0a-additive-ddl.sql
-- V5-VOICEALIAS-001 — public.voice_alias, the learned-mishearing store for the voice harvest chooser.
--
-- STATUS 2026-08-30: APPLIED TO STAGING (0a applied, 0r rehearsed clean, 0a re-applied, post gates
-- 8/8). NOT APPLIED TO PROD — no DDL has run against prod from this lane. Apply order per gates.yml:
-- staging -> rehearse 0r -> re-apply -> prod -> dev push -> promote. CI's integration job branches
-- off STAGING WITHOUT applying migrations, so this had to land on staging BEFORE the dev push or a
-- missing relation reads as an infra flake and gets retried green. The prod apply is deferred until
-- it is actually needed, which is before the PROMOTE of any build carrying the writer.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT THIS IS FOR
--
-- Dave, 2026-08-30: "Saying suyo long in the app is getting transcribed as studio long ... I said it
-- very clearly and tried it multiple times, and it still picked up studio long."
--
-- Chrome's recogniser re-ranks candidates by how likely each word is in general English, so a rare
-- cultivar name loses to a common phonetic neighbour. That is a property of the engine, not of his
-- diction, and no setting on our side changes it. v4.78.0 shipped voiceFuzzyMatch.js, which recovers
-- the case by scoring against the closed set of live plantings — measured at 0.0% wrong auto-selects
-- over 750 adversarial utterances. But fuzzy matching has a measured ceiling: it cannot reach a
-- mishearing that lands far from the true name (spoken number words against a digit-named planting
-- are the extreme case — "eighteen eighty four" ranks helichrysum 0.353 against a planting named
-- 1884). This table is where the residue goes: once Dave has corrected a mishearing ONCE, it is
-- right permanently, for both users, on every device.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY VARIETY-SCOPED AND NOT PLANTING-SCOPED — the one design decision here that is not obvious.
--
-- The obvious key is the planting he actually picked. It is wrong. Plantings are SEASONAL: this
-- year's Suyo Long row is archived at the end of the season and next year's is a new row with a new
-- id. A planting-scoped alias would silently expire every winter and have to be retaught annually,
-- which converts a one-time correction into an every-season chore — the exact opposite of the point.
--
-- The mishearing is a property of the NAME, and the name belongs to the variety. plant_varieties.id
-- is stable across replantings, shared between Dave and Jen, and is what plantingAliases() actually
-- matches on. So the alias survives the season, and a variety Dave grows again in three years is
-- still spelled correctly the first time he says it.
--
-- CONSEQUENCE the resolver must handle: a variety can have SEVERAL live plantings (46 tomato and 38
-- pepper plantings on prod today). Resolving an alias therefore yields a VARIETY, and the caller
-- still has to choose among that variety's live plantings — which is the existing "Which one?" list,
-- not a new mechanism. An alias narrows the field; it does not assert a planting.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- GRAIN. One row = one heard phrase -> one variety, per user. UNIQUE (user_id, heard_key) with the
-- writer's ON CONFLICT DO UPDATE, so re-teaching a phrase RETARGETS it rather than minting a second
-- row: a phrase that resolved to the wrong variety must be correctable by simply saying it again and
-- picking correctly, and two rows for one phrase would make resolution order-dependent.
--
-- USER-SCOPED, NOT GARDEN-SCOPED. Dave and Jen have different voices and the recogniser mishears
-- them differently; one person's correction is not evidence about the other's audio. The cost is
-- that each learns their own set, which is correct rather than merely safe.
--
-- GROWTH is negligible and structurally bounded: rows accrue only when a human corrects a
-- mishearing, capped by (distinct phrases a user actually says) — realistically tens per season,
-- not thousands. No retention policy is needed and none is implied.
--
-- NO created_by COLUMN, DELIBERATELY — same absence and same rationale as watch_exclusion,
-- watch_impression and weather_daily. The V4-OWNERSHIP-001 transfer trigger fires on created_by
-- across 9 tables and reads a NULL -> value write as an ownership transfer. user_id here records
-- WHOSE ear this alias belongs to, which is not an ownership claim. Do not add created_by "for
-- auditing".
--
-- CHECK BLAST RADIUS. The writer inserts ONE row per correction, so a CHECK violation costs exactly
-- that correction and nothing else — and it must fail LOUDLY at the call site rather than silently,
-- because a teach that appears to work and did not is worse than one that visibly failed. The length
-- bound is the only closed rule pinned here: heard_key is a looseKey() output, and voiceFuzzyMatch
-- already refuses to act on anything under MIN_QUERY_CHARS (4), so a 1-3 character key could only
-- arrive from a caller that skipped the matcher entirely.

BEGIN;

CREATE TABLE IF NOT EXISTS public.voice_alias (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- WHOSE ear. Clerk sub. Not created_by — see the ownership note above.
  user_id       text        NOT NULL,

  -- looseKey(transcript) — lowercased, diacritics folded, whitespace/hyphens/apostrophes dropped,
  -- repeated letters collapsed. THE SAME FUNCTION THE MATCHER USES, so a stored alias and a live
  -- utterance are compared on identical terms. Storing the raw text here instead would make every
  -- lookup depend on the recogniser reproducing its own punctuation and spacing, which it does not.
  heard_key     text        NOT NULL,

  -- The raw transcript as Chrome delivered it, kept for forensics only and never matched against.
  -- Without it there is no way to answer "what is the recogniser actually doing to this name" later,
  -- and that question is the entire reason the fuzzy thresholds could be measured at all.
  heard_text    text        NOT NULL,

  -- The variety the phrase means. CASCADE because an alias for a deleted variety is not merely stale,
  -- it is unresolvable — there is nothing for the matcher to return.
  variety_id    uuid        NOT NULL REFERENCES public.plant_varieties(id) ON DELETE CASCADE,

  -- How often this alias has resolved a live utterance. Not a popularity contest: it is the signal
  -- that tells a later review which learned aliases are load-bearing and which were one-off noise
  -- worth pruning. Bumped by the resolver, not by the teach.
  hit_count     integer     NOT NULL DEFAULT 0,

  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,

  -- voiceFuzzyMatch.MIN_QUERY_CHARS is 4, so nothing shorter can legitimately reach a teach. The
  -- upper bound is generous — a spoken cultivar name is short, and anything past 120 characters is a
  -- caller passing a whole utterance where it meant to pass a name.
  CONSTRAINT voice_alias_heard_key_len_chk
    CHECK (char_length(heard_key) BETWEEN 4 AND 120),

  -- heard_key must already be normalised by the caller. Asserting it here rather than trusting the
  -- client is what stops a raw " Studio Long " from being stored as an alias no lookup can ever
  -- match: it would insert cleanly, resolve never, and look like the learning feature simply not
  -- working. Mirrors the looseKey contract — no uppercase, no whitespace, no punctuation.
  CONSTRAINT voice_alias_heard_key_normalised_chk
    CHECK (heard_key = lower(heard_key) AND heard_key !~ '[[:space:][:punct:]]'),

  -- One phrase, one meaning, per user. The writer's ON CONFLICT target: re-teaching RETARGETS.
  CONSTRAINT uq_voice_alias_user_phrase UNIQUE (user_id, heard_key)
);

-- One secondary index, for the only read shape that is not the unique constraint's: "which learned
-- aliases point at this variety", which is what a review or a merge of duplicate varieties needs.
-- The UNIQUE constraint's index (user_id leading) already serves both the resolver's lookup and any
-- per-user scan. No hit_count or created_at index — there is no query that orders by either, and an
-- unused index is pure write cost on a table whose whole point is being cheap.
CREATE INDEX IF NOT EXISTS idx_voice_alias_variety
  ON public.voice_alias (variety_id);

COMMENT ON TABLE public.voice_alias IS
  'V5-VOICEALIAS-001. One row per learned speech-recognition mishearing: a normalised heard phrase '
  '-> the plant_variety it actually means, per user. Written when a human corrects the voice harvest '
  'chooser; read by the chooser BEFORE fuzzy matching. Variety-scoped, not planting-scoped, so an '
  'alias survives replanting — plantings are seasonal, the name is not. Exists because Chrome''s '
  'recogniser re-ranks rare proper nouns into common English words ("Suyo Long" -> "studio long") '
  'and no client-side setting changes that; voiceFuzzyMatch.js recovers most of it, this table '
  'covers the residue permanently.';

COMMENT ON COLUMN public.voice_alias.heard_key IS
  'looseKey(transcript) — the SAME normalisation comboboxInput.js applies to a live utterance. '
  'Constraint-enforced lowercase with no whitespace or punctuation: an un-normalised value would '
  'insert cleanly and never match, which presents as the feature silently not working.';
COMMENT ON COLUMN public.voice_alias.heard_text IS
  'Raw transcript as delivered, for forensics only — never matched against. The record of what the '
  'recogniser actually did to this name.';
COMMENT ON COLUMN public.voice_alias.variety_id IS
  'plant_varieties.id. Resolving an alias yields a VARIETY, and the caller still chooses among that '
  'variety''s live plantings via the existing candidate list — an alias narrows the field, it does '
  'not assert a planting.';
COMMENT ON COLUMN public.voice_alias.hit_count IS
  'Times this alias has resolved a live utterance. Bumped by the resolver, not by the teach. The '
  'signal for later pruning of one-off noise; not used in matching.';

COMMIT;
