-- 0a-additive-ddl.sql
-- V5-SOURCECONTACT-001 — public.source gains instagram_url and facebook_url, and the audit trigger
-- is re-armed to watch them.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-sourcecontact-001/0a-additive-ddl.sql
--
-- STATUS AT AUTHORING (2026-09-29): NOT APPLIED ANYWHERE.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────────────────
-- Dave, verbatim: "a source add/edit should include optional fields for website, IG, FB, physical
-- address for me to enter". website_url and address already exist (v5-sourceentity-001). Instagram
-- and Facebook have nowhere to live: notes would hold them as prose no chip can render, and
-- website_url is the vendor's front door, not a social profile. Farm stands and swap organisers
-- often have ONLY a Facebook page, so the column is the only link they will ever carry.
--
-- ── WHY TWO COLUMNS AND NOT A jsonb "links" BAG ─────────────────────────────────────────────────
-- Each gets the same scheme CHECK as website_url, the same audit coverage, and the same place in the
-- L-081 column contract. A bag would need a jsonb CHECK per key to say the same thing, and the audit
-- trigger's watched-column list would see one opaque column instead of two named ones.
--
-- ── THE CHECK IS chk_source_website_url's, WORD FOR WORD ────────────────────────────────────────
-- `IS NULL OR ~ '^https?://'`. Scheme-only, deliberately loose about the rest: a link that is not a
-- link renders as a dead control, which is worse than no link. The client normalises "@handle" to a
-- full profile URL (src/lib/sourceLinks.js) and lambda/varieties/validate.js refuses anything else,
-- so this CHECK is the backstop behind both, not the first line.
-- Added through ALTER rather than inline (website_url's was inline in CREATE TABLE). Both columns
-- are brand new and therefore all-NULL, so the ALTER validates instantly and needs no NOT VALID.
--
-- ── WHY THE AUDIT TRIGGER IS DROPPED AND RE-CREATED ─────────────────────────────────────────────
-- trg_audit_source_upd passes its watched set as trigger ARGUMENTS (tgargs). There is no ALTER for
-- that list; the only way to change it is DROP + CREATE. Without this step two things break:
--   1. an edit that changes ONLY instagram_url or facebook_url writes NO audit_events row, so the
--      prior value is unrecoverable (the v5-plantsourceaudit-001 blind spot, on another table); and
--   2. v5-sourceentity-001's CONTINUOUS gate post_audit_update_watches_every_mutable_column derives
--      the expected list from information_schema and would go red the moment the columns exist.
-- The re-created list is the ORIGINAL nine, in their original order, plus the two new names. Shape
-- (AFTER UPDATE, both transition tables, FOR EACH STATEMENT, audit_stmt_update) is unchanged, so
-- v5-sourceentity-001's post_audit_triggers_installed_and_statement_level stays green too.
-- DROP IF EXISTS + CREATE, unconditionally: the target state is "this trigger exists with this
-- list", and that is correct whether or not a prior apply already left it there. pre gate
-- pre_audit_trigger_list_is_the_known_nine refuses to run over a list someone else widened.
--
-- Apply order: staging -> rehearse 0r -> re-apply staging -> prod -> dev push -> promote. The
-- Lambda change that reads these columns must NOT reach prod before this does: its SELECT lists
-- name them, and a missing column is a 42703 on every source read.

BEGIN;

ALTER TABLE public.source
  ADD COLUMN IF NOT EXISTS instagram_url text,
  ADD COLUMN IF NOT EXISTS facebook_url  text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'chk_source_instagram_url'
                    AND conrelid = 'public.source'::regclass) THEN
    ALTER TABLE public.source
      ADD CONSTRAINT chk_source_instagram_url
      CHECK (instagram_url IS NULL OR instagram_url ~ '^https?://');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'chk_source_facebook_url'
                    AND conrelid = 'public.source'::regclass) THEN
    ALTER TABLE public.source
      ADD CONSTRAINT chk_source_facebook_url
      CHECK (facebook_url IS NULL OR facebook_url ~ '^https?://');
  END IF;
END
$$;

DROP TRIGGER IF EXISTS trg_audit_source_upd ON public.source;
CREATE TRIGGER trg_audit_source_upd
  AFTER UPDATE ON public.source
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.audit_stmt_update(
    'name', 'kind', 'locality', 'address', 'website_url', 'notes',
    'created_by', 'created_at', 'deleted_at',
    'instagram_url', 'facebook_url');

COMMENT ON COLUMN public.source.instagram_url IS
  'V5-SOURCECONTACT-001. The source''s Instagram profile as a full http(s) URL. The client turns '
  '"@handle" into https://www.instagram.com/handle before sending; chk_source_instagram_url refuses '
  'anything without a scheme. Watched by trg_audit_source_upd.';
COMMENT ON COLUMN public.source.facebook_url IS
  'V5-SOURCECONTACT-001. The source''s Facebook page as a full http(s) URL — often the ONLY link a '
  'farm stand or swap has. Same normalisation and CHECK as instagram_url. Watched by '
  'trg_audit_source_upd.';

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-sourcecontact-001',
        'SOURCECONTACT: V5-SOURCECONTACT-001. public.source gains nullable instagram_url and '
        'facebook_url (text, no default) with chk_source_instagram_url / chk_source_facebook_url '
        '(IS NULL OR ~ ''^https?://'', same as chk_source_website_url). trg_audit_source_upd dropped '
        'and re-created with the same shape and the watched set widened 9 -> 11 (the original nine '
        'plus both new columns), keeping v5-sourceentity-001''s continuous '
        'post_audit_update_watches_every_mutable_column green. No backfill, no view touched.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
