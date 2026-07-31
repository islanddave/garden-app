"""Tests for check-staging-drift.py (OPS-STAGINGDRIFT-001).

Run: pytest -q test_check_staging_drift.py

The classifier is the whole design — the raw set-difference is trivial, but telling a REAL hazard
from the normal staging-first-apply lead is what stops this being permanently noisy. These use a
fake connection so no database is required.
"""
import importlib.util
from pathlib import Path

# House idiom for importing a hyphenated script (cf. test_verify_deploy.py).
_spec = importlib.util.spec_from_file_location(
    'check_staging_drift', Path(__file__).resolve().parent / 'check-staging-drift.py')
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


class _FakeCursor:
    def __init__(self, rows):
        self._rows = rows

    def execute(self, *_a, **_k):
        return None

    def fetchall(self):
        return self._rows

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False


class _FakeConn:
    def __init__(self, rows):
        self._rows = rows

    def cursor(self):
        return _FakeCursor(self._rows)


def test_staging_only_check_not_in_prod_is_hazardous():
    """The real 2026-07-31 case: staging kept plants_container_type_domain (the OLD 7-value list)
    after prod dropped it for the widened enum, so staging REJECTED 'trough' while prod accepted it."""
    rows = [('plants', 'plants_container_type_domain', 'c',
             "CHECK ((container_type IS NULL) OR (container_type = ANY (ARRAY['pot'::text, 'bag'::text])))")]
    out = mod._hazardous_staging_only_constraints(
        _FakeConn(rows), ['plants.plants_container_type_domain'], staging_only_cols=set())
    assert out == ['plants.plants_container_type_domain']


def test_staging_only_foreign_key_is_benign():
    """An FK that merely accompanies a staging-only column is the normal staging-first lead."""
    rows = [('photos', 'photos_space_id_fkey', 'f', 'FOREIGN KEY (space_id) REFERENCES spaces(id)')]
    out = mod._hazardous_staging_only_constraints(
        _FakeConn(rows), ['photos.photos_space_id_fkey'], staging_only_cols={'space_id'})
    assert out == []


def test_staging_only_check_guarding_a_staging_only_column_is_benign():
    """A CHECK is only a hazard if it constrains a column prod ALSO has — otherwise prod has no
    write to reject in the first place."""
    rows = [('photos', 'photos_space_kind_chk', 'c', "CHECK (space_id IS NULL OR kind = 'x')")]
    out = mod._hazardous_staging_only_constraints(
        _FakeConn(rows), ['photos.photos_space_kind_chk'], staging_only_cols={'space_id'})
    assert out == []


def test_constraint_not_in_the_staging_only_set_is_ignored():
    """Constraints present in BOTH environments must never be reported."""
    rows = [('plants', 'plants_pkey', 'p', 'PRIMARY KEY (id)'),
            ('plants', 'some_check', 'c', 'CHECK (x > 0)')]
    out = mod._hazardous_staging_only_constraints(_FakeConn(rows), [], staging_only_cols=set())
    assert out == []


def test_ctas_snapshot_tables_are_ignored():
    """Ad-hoc CTAS incident snapshots live only in prod and would otherwise dominate the diff."""
    assert mod._ignored('ctas_photos_20260519')
    assert not mod._ignored('photos')


def test_missing_url_returns_2_not_0(monkeypatch):
    """An unreachable/unconfigured environment is UNKNOWN drift, never 'no drift'."""
    monkeypatch.delenv('NEON_DATABASE_URL', raising=False)
    monkeypatch.delenv('NEON_STAGING_URL', raising=False)
    assert mod.main([]) == 2
