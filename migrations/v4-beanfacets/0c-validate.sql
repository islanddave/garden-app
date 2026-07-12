-- 0c-validate.sql — V4 BEAN FACETS: VALIDATE the NOT VALID constraint from 0a (L-058 sweep step).
-- Run AFTER 0a and AFTER the backfill (0b) so the full-table validation scan sees final data.
ALTER TABLE public.tag VALIDATE CONSTRAINT tag_facet_check;
