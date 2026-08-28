"""Tests for the staged-promote marker (OPS-STAGEDPROMOTEINVALIDATED-001).

Pure core only — no git, no network. The subprocess-touching verbs are covered
by their pure pieces: message formatting, message parsing, age arithmetic, and
the ls-remote peeling rule, which is the one place a plausible implementation is
silently wrong.
"""
import importlib.util, os
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location(
    "sp", os.path.join(os.path.dirname(__file__), "staged-promote.py"))
sp = importlib.util.module_from_spec(spec); spec.loader.exec_module(sp)

SHA = "d395e8412ab34cd56789012345678901234abcde"
NOW = datetime(2026, 8, 28, 18, 0, 0, tzinfo=timezone.utc)


# ── round trip ───────────────────────────────────────────────────────────────────
def test_format_then_parse_round_trips():
    msg = sp.format_marker(SHA, "v4.49.0", "garden-hardparallel-20260824", "2026-08-24T14:00:00+00:00")
    got = sp.parse_marker(msg)
    assert got == {"sha": SHA, "version": "v4.49.0",
                   "by": "garden-hardparallel-20260824", "at": "2026-08-24T14:00:00+00:00"}


def test_message_is_human_readable_before_it_is_machine_readable():
    """A person paged at 2am reads the top of this, not the JSON."""
    msg = sp.format_marker(SHA, "v4.49.0", "sess", "2026-08-24T14:00:00+00:00")
    first = msg.splitlines()[0]
    assert "STAGED PROMOTE" in first and "v4.49.0" in first and SHA in first
    assert "Do not move dev off this SHA" in msg
    assert "clear" in msg  # the way out is stated in the marker itself


# ── parsing is tolerant, because an unreadable marker must still REPORT ──────────
def test_parse_returns_empty_for_absent_metadata():
    assert sp.parse_marker("just a message, no metadata") == {}
    assert sp.parse_marker("") == {}
    assert sp.parse_marker(None) == {}


def test_parse_survives_a_corrupt_metadata_block():
    # A check that crashes on a malformed marker is worse than one that says
    # "something is staged, I can't read the details" — it fails OPEN.
    assert sp.parse_marker(f"header\n{sp._JSON_START}\n{{not json") == {}
    assert sp.parse_marker(f"header\n{sp._JSON_START}\n[1,2,3]") == {}   # valid JSON, wrong shape


# ── age is reported, never used to auto-expire ───────────────────────────────────
def test_age_hours_computes_from_iso():
    assert sp.age_hours("2026-08-28T12:00:00+00:00", NOW) == 6.0


def test_age_hours_accepts_a_z_suffix_and_assumes_utc_when_naive():
    assert sp.age_hours("2026-08-28T12:00:00Z", NOW) == 6.0
    assert sp.age_hours("2026-08-28T12:00:00", NOW) == 6.0


def test_age_hours_returns_none_rather_than_guessing():
    for bad in ["", "yesterday", "2026-13-45", None]:
        assert sp.age_hours(bad, NOW) is None


def test_a_very_old_marker_is_still_a_marker():
    """No auto-expiry, deliberately. A marker that stopped mattering on a timer
    would recreate the exact defect this file exists to fix."""
    assert sp.age_hours("2026-01-01T00:00:00+00:00", NOW) > 5000


# ── the sha guard ────────────────────────────────────────────────────────────────
def test_full_sha_pattern_rejects_the_short_form_that_caused_the_incident():
    # The 2026-08-24 incident recorded only `d395e84`. actions/checkout treats a
    # 7-char sha as a ref PATTERN and pstate refuses a short prod_sha.
    assert sp.FULL_SHA.match(SHA)
    for bad in ["d395e84", SHA.upper(), SHA[:39], SHA + "f", "z" * 40, ""]:
        assert not sp.FULL_SHA.match(bad), f"{bad!r} must not pass as a full sha"


# ── the peeling rule — the one place a plausible implementation is silently wrong ─
def _peel(stdout):
    """Mirror of remote_marker_sha's parsing, fed synthetic ls-remote output."""
    peeled, plain = None, None
    for line in stdout.strip().splitlines():
        sha, _, ref = line.partition("\t")
        if ref.endswith("^{}"):
            peeled = sha.strip()
        else:
            plain = sha.strip()
    return peeled or plain


def test_annotated_tag_resolves_to_the_COMMIT_not_the_tag_object():
    # An annotated tag's plain ls-remote line is the TAG OBJECT's sha. Comparing
    # that against a commit sha never matches, so the guard would never fire —
    # this file's own failure mode, silently.
    tag_object = "1111111111111111111111111111111111111111"
    out = f"{tag_object}\t{sp.TAG_REF}\n{SHA}\t{sp.TAG_REF}^{{}}\n"
    assert _peel(out) == SHA
    assert _peel(out) != tag_object


def test_lightweight_tag_has_no_peeled_line_and_still_resolves():
    assert _peel(f"{SHA}\t{sp.TAG_REF}\n") == SHA


def test_empty_ls_remote_means_nothing_staged():
    assert _peel("") is None


def test_ls_remote_is_ASKED_for_the_peeled_ref(monkeypatch):
    """The bug this pins was NOT in the parser — it was in the parser's INPUT.

    `ls-remote origin refs/tags/staged-promote` matches only the exact ref, so the
    peeled `^{}` line is filtered out before the parser sees it and the plain
    tag-OBJECT sha wins. The first version did exactly that: `check` fired and named
    a sha that exists nowhere in the repository. Every parser test above still
    passed. So assert the ARGUMENTS, which is where the defect actually was.
    """
    seen = {}

    class R:
        returncode, stdout, stderr = 0, "", ""

    def fake_git(*args, **kw):
        seen["args"] = args
        return R()

    monkeypatch.setattr(sp, "_git", fake_git)
    sp.remote_marker_sha("origin")
    assert sp.TAG_REF in seen["args"], "must ask for the tag ref"
    assert sp.TAG_REF + "^{}" in seen["args"], (
        "must ALSO ask for the peeled ref, or an annotated tag resolves to the tag object")


# ── the name matters ─────────────────────────────────────────────────────────────
def test_marker_name_is_outside_the_protected_tag_namespace():
    """release-tag-integrity protects refs/tags/promote-v* and refs/tags/v* against
    update AND delete. A mutable marker inside either pattern could never be
    cleared, and would burn a protected name."""
    assert sp.TAG_NAME == "staged-promote"
    assert not sp.TAG_NAME.startswith("v")
    assert not sp.TAG_NAME.startswith("promote-v")
