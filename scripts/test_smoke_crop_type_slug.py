"""tests/smoke/run-smoke.sh block V: the smoke's own crop type is named by block V and by nothing else.

Run: python3 -m pytest -q scripts/test_smoke_crop_type_slug.py

Block V (V4-CROPTYPERETIRE-001) walks retire and bring-back on one crop type that is the smoke's own, slug
smoke_test_crop_type, and leaves it RETIRED between runs. The retire guard counts every row that names a type,
deleted rows included, and the app has no hard delete. So one staging row that names this slug makes the type
unretirable until somebody deletes that row by hand, and a type that cannot be retired sits live with no harvest
habit, which the standing gate v4-harvhabitgap-001/post_every_null_habit_is_a_recorded_decision counts.

These are static reads of the script and of tests/integration. They hold three things:
  - no other smoke block and no integration test names the slug or its display name;
  - the refusal path (no admin on the function) sends no create: it leaves the vocabulary as it found it;
  - cleanup() starts with block V's arm, and that arm retires the type, it does not bring it back.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SMOKE = ROOT / "tests" / "smoke" / "run-smoke.sh"
INTEGRATION = ROOT / "tests" / "integration"
SLUG = "smoke_test_crop_type"
NAME = "Smoke test crop type"
BLOCK_START = "# ── V) Crop types"
BLOCK_END = "# ── S) Pantry"


def script():
    return SMOKE.read_text(encoding="utf-8")


def block_v():
    text = script()
    assert text.count(BLOCK_START) == 1 and text.count(BLOCK_END) == 1
    start, end = text.index(BLOCK_START), text.index(BLOCK_END)
    assert start < end
    return text[:start], text[start:end], text[end:]


def code(text):
    """The lines that run: comment lines dropped."""
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


def cleanup_body():
    found = re.findall(r"^cleanup\(\) \{\n(.*?)^\}\n", script(), re.M | re.S)
    assert len(found) == 1, "expected exactly one top-level cleanup() in run-smoke.sh"
    return found[0]


def test_block_v_names_its_own_type_once():
    _, block, _ = block_v()
    assert code(block).count(f'CT_SLUG="{SLUG}"') == 1
    assert code(block).count(f'CT_NAME="{NAME}"') == 1
    # Every use after that goes through the two variables.
    assert code(block).count(SLUG) == 1 and code(block).count(NAME) == 1


def test_nothing_outside_block_v_names_the_smoke_crop_type():
    before, _, after = block_v()
    for where, text in (("before block V", before), ("after block V", after)):
        for needle in (SLUG, NAME):
            assert needle.lower() not in text.lower(), (
                f"run-smoke.sh names {needle!r} {where}. Only block V may use the smoke's own crop type: a row "
                "that names it, deleted or not, makes it unretirable until that row is hard-deleted by hand.")


def test_no_integration_test_names_the_smoke_crop_type():
    files = [p for p in sorted(INTEGRATION.rglob("*")) if p.is_file()]
    assert len(files) > 20, "tests/integration was not read"
    hits = []
    for path in files:
        text = path.read_text(encoding="utf-8", errors="replace").lower()
        if SLUG in text or NAME.lower() in text:
            hits.append(str(path.relative_to(ROOT)))
    assert hits == [], f"only the smoke's block V may name {SLUG}: {hits}"


def test_the_refusal_path_creates_nothing():
    _, block, _ = block_v()
    lines = code(block).splitlines()
    start = [i for i, line in enumerate(lines) if line.strip() == 'elif [[ "$CT_LIST" == 403\\ * ]]; then']
    assert len(start) == 1, "the refusal arm of block V was not found"
    # The arm runs to the next line at its own indent, the block's last `else`.
    end = next(i for i in range(start[0] + 1, len(lines)) if lines[i] == "  else")
    arm = "\n".join(lines[start[0]:end])
    assert "ct_post" in arm and "/retire" in arm, "the refusal arm no longer sends its retire"
    assert "display_name" not in arm and "CT_NAME" not in arm and "restore_slug" not in arm, (
        "the refusal arm writes to the vocabulary. With no admin on the function a type made here stays live, "
        "with no harvest habit, and nobody can retire it from the app.")
    posts = [line for line in arm.splitlines() if "ct_post" in line]
    assert len(posts) == 1 and '"$CT_BASE/retire"' in posts[0] and "$CT_SLUG" in posts[0], posts
    # The create exists once in the whole block, on the admin path.
    assert code(block).count('\\"display_name\\"') == 1


def test_cleanup_starts_with_block_v_and_retires():
    body = cleanup_body()
    first = next(line for line in body.splitlines() if line.strip() and not line.lstrip().startswith("#"))
    assert first.strip().startswith('if [[ -n "${CT_DIRTY_SLUG:-}"'), first
    arm = body[:body.index("  # Block P (Put-Up F)")]
    assert '/api/varieties/crop-types/retire"' in arm and '{\\"slug\\": \\"$CT_DIRTY_SLUG\\"}' in arm
    assert "restore_slug" not in arm, "cleanup must leave the smoke's crop type RETIRED, not bring it back"
    assert SLUG not in arm


def test_the_block_ends_on_the_retire():
    _, block, _ = block_v()
    body = code(block)
    # One bring-back and one create (both before the read-back live), one retire per path, retire last.
    assert body.count('\\"restore_slug\\"') == 1
    admin_path = body[:body.index('elif [[ "$CT_LIST" == 403\\ * ]]; then')]
    assert admin_path.rindex('"$CT_BASE/retire"') > admin_path.rindex('\\"restore_slug\\"')
    assert admin_path.rindex('"$CT_BASE/retire"') > admin_path.rindex('\\"display_name\\"')


def test_on_the_ship_gate_any_admin_refusal_fails():
    """ct_unwalked: under SMOKE_REQUIRE_AUTH the skipped walk is a FAIL whatever code the 403 carried.

    The handler sends admin_not_configured only when the function has no list at all; a list that lacks the
    smoke user answers 403 with no code. Keying the FAIL on that one code let the second case pass the gate
    with the write walk skipped.
    """
    _, block, _ = block_v()
    body = code(block)
    start = body.index("ct_unwalked() {")
    fn = body[start:body.index("\n    }", start)]
    first_if = next(line.strip() for line in fn.splitlines() if line.strip().startswith("if "))
    assert first_if == 'if [[ -n "${SMOKE_REQUIRE_AUTH:-}" ]]; then', first_if
    fail_arm, warn_arm = fn.split("\n      else\n")
    assert "FAIL [write:crop-type-retire-readback]" in fail_arm and "FAIL=$((FAIL+1))" in fail_arm
    assert "WARN [write:crop-type-retire-readback]" in warn_arm and "FAIL=" not in warn_arm
    assert "admin_not_configured" not in fn
