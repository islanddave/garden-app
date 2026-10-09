#!/usr/bin/env bash
# The A3 trial's two exit checks at the current checkout (THE A3 TRIAL in .github/workflows/ci-next.yml):
#   E1  every node-project test makes the same number of assertions under jsdom as under node;
#   E2  the statements, functions and branch arms covered in every module those tests load are the same.
#
# Run: scripts/ci-telemetry/a3-exit.sh OUT_DIR        (OUT_DIR: empty or not there yet, and outside the checkout)
#
# THE LAST LINE IS THE RESULT: `A3-EXIT-PASS (…)` and exit 0, or `A3-EXIT-FAIL (e1=…, e2=…, red=…, node=…, tree=…)`
# and exit 1. PASS needs all of: E1-SAME, E2-SAME, every vitest run exiting 0, the Node of .nvmrc, a clean tree.
#
# Refused before any run, exit 2: no OUT_DIR, or one inside the checkout or not empty; no node_modules; a `node`
# that is not the one .nvmrc names (CI's: what `node` is as an environment differs between majors, so a result on
# another Node is not the trial's); uncommitted paths (the SHA printed would not be the tree measured).
# A3_EXIT_ANY_NODE=1 and A3_EXIT_ANY_TREE=1 run it anyway, for trying the tool out: the result is then never a
# pass. The exit stays 1 and the last line says which of the two was overridden.
#
# Seven vitest runs of ./a3-exit.config.mjs, one after another, each into OUT_DIR/<run> with its output in
# OUT_DIR/<run>.log:
#   e1-jsdom  e1-node                             no coverage: tests.jsonl, one line per test
#   e2-jsdom-a  e2-jsdom-b  e2-node-a  e2-node-b  coverage on: coverage/coverage-final.json. Twice per environment
#                                                 because one tree can give one file two whole readings
#                                                 (lambda/daily-plan/engine.js: 1,214 or 1,257 of 1,374 items
#                                                 covered, BUG-ENGINECOVERAGETWOREADINGS-001), and a second run is
#                                                 what lets a reading be found in both environments
#   e2-setup                                      the control: what the repo setup file alone loads under jsdom
# then ./a3-exit.py e1 and e2 on them (OUT_DIR/e1.txt, OUT_DIR/e2.txt), their two verdict lines, and the last line.
#
# A run with a failing test is still compared (a test that fails the same way on both sides is not a difference)
# but is not a clean measurement, so it is said (RUNS-RED) and the result is FAIL. E2-INCONCLUSIVE (something was
# not compared) is FAIL too: run it again. Needs node_modules (npm ci), git and python3; uses no network.
set -uo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: a3-exit.sh OUT_DIR" >&2
  exit 2
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(cd "${here}/../.." && pwd -P)"

# Where OUT_DIR is, without making it: the nearest directory above it that exists, resolved, plus the rest.
case "$1" in
  /*) above="${1%/}" ;;
  *) above="${PWD}/${1%/}" ;;
esac
rest=""
while [ ! -d "${above:-/}" ]; do
  case "$(basename "${above}")" in
    ..) echo "a3-exit.sh: OUT_DIR $1 has .. in a part that is not there yet: give it resolved" >&2; exit 2 ;;
  esac
  rest="/$(basename "${above}")${rest}"
  above="$(dirname "${above}")"
done
out="$(cd "${above:-/}" && pwd -P)" || exit 2
out="${out%/}${rest}"
[ -n "${out}" ] || out="/"
case "${out}/" in
  "${repo}/"*) echo "a3-exit.sh: OUT_DIR ${out} is inside the checkout: give a directory outside it" >&2; exit 2 ;;
esac
if [ -d "${out}" ] && [ -n "$(ls -A "${out}")" ]; then
  echo "a3-exit.sh: OUT_DIR ${out} is not empty: runs of two trees must not mix" >&2
  exit 2
fi
if [ ! -x "${repo}/node_modules/.bin/vitest" ]; then
  echo "a3-exit.sh: no ${repo}/node_modules/.bin/vitest: run npm ci first" >&2
  exit 2
fi

want_node="v$(cat "${repo}/.nvmrc" 2>/dev/null)"
have_node="$(node --version 2>/dev/null)"
node_said="${have_node}"
if [ "${have_node}" != "${want_node}" ]; then
  if [ "${A3_EXIT_ANY_NODE:-}" != "1" ]; then
    echo "a3-exit.sh: node is ${have_node:-missing} and .nvmrc (CI) says ${want_node}: the exit checks are made on" \
      "that Node. A3_EXIT_ANY_NODE=1 runs them here anyway, and the result is then never a pass" >&2
    exit 2
  fi
  node_said="${have_node:-missing} is not ${want_node} of .nvmrc: A3_EXIT_ANY_NODE=1, never a pass"
fi
sha="$(git -C "${repo}" rev-parse HEAD 2>/dev/null)" && changed="$(git -C "${repo}" status --porcelain 2>/dev/null)" || {
  echo "a3-exit.sh: git cannot read ${repo}: the SHA and the state of the tree are part of the result" >&2
  exit 2
}
paths="$(printf '%s' "${changed}" | grep -c . || true)"
tree_said="clean"
if [ "${paths}" -ne 0 ]; then
  if [ "${A3_EXIT_ANY_TREE:-}" != "1" ]; then
    echo "a3-exit.sh: ${paths} uncommitted paths in ${repo}: ${sha} is not the tree that would be measured." \
      "A3_EXIT_ANY_TREE=1 runs it anyway, and the result is then never a pass" >&2
    exit 2
  fi
  tree_said="${paths} uncommitted paths: A3_EXIT_ANY_TREE=1, never a pass"
fi

mkdir -p "${out}" || exit 2
{
  echo "sha ${sha}"
  echo "uncommitted ${paths} paths"
  echo "node ${have_node:-missing}, .nvmrc ${want_node#v}"
  echo "started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "${out}/meta.txt"

red=0
# run NAME ENV [VAR=value …]
run() {
  local name="$1" mode="$2" began="${SECONDS}" code said
  shift 2
  (cd "${repo}" && env TZ=UTC A3_EXIT_ENV="${mode}" A3_EXIT_OUT="${out}/${name}" "$@" \
    node_modules/.bin/vitest run --config scripts/ci-telemetry/a3-exit.config.mjs) >"${out}/${name}.log" 2>&1
  code=$?
  [ "${code}" -eq 0 ] || red=$((red + 1))
  said="run ${name}: vitest exit ${code}, $((SECONDS - began))s"
  echo "${said}"
  echo "${said}" >>"${out}/meta.txt"
}

run e1-jsdom jsdom
run e1-node node
run e2-jsdom-a jsdom A3_EXIT_WIDE=1
run e2-jsdom-b jsdom A3_EXIT_WIDE=1
run e2-node-a node A3_EXIT_WIDE=1
run e2-node-b node A3_EXIT_WIDE=1
run e2-setup jsdom A3_EXIT_WIDE=1 A3_EXIT_CONTROL=1

final() { echo "${out}/$1/coverage/coverage-final.json"; }
python3 "${here}/a3-exit.py" e1 "${out}/e1-jsdom/tests.jsonl" "${out}/e1-node/tests.jsonl" >"${out}/e1.txt" 2>&1
e1=$?
python3 "${here}/a3-exit.py" e2 "$(final e2-jsdom-a)" "$(final e2-jsdom-b)" "$(final e2-node-a)" "$(final e2-node-b)" \
  --setup-loads "$(final e2-setup)" --root "${repo}" >"${out}/e2.txt" 2>&1
e2=$?

# The first word of a comparer's last line, when it is a verdict of that check; a comparer that died says so.
verdict() {
  local word
  word="$(tail -n 1 "${out}/$1.txt" 2>/dev/null)"
  word="${word%%[ :]*}"
  case "${word}" in
    "$2"-*) echo "${word}" ;;
    *) echo "$2-NO-VERDICT" ;;
  esac
}
e1_said="$(verdict e1 E1)"
e2_said="$(verdict e2 E2)"

said="e1=${e1_said}, e2=${e2_said}, red=${red}, node=${node_said}, tree=${tree_said}"
result="A3-EXIT-FAIL (${said})"
code=1
if [ "${e1}" -eq 0 ] && [ "${e1_said}" = "E1-SAME" ] && [ "${e2}" -eq 0 ] && [ "${e2_said}" = "E2-SAME" ] \
  && [ "${red}" -eq 0 ] && [ "${node_said}" = "${want_node}" ] && [ "${tree_said}" = "clean" ]; then
  result="A3-EXIT-PASS (${said})"
  code=0
fi
{
  echo
  echo "E1 (${out}/e1.txt), exit ${e1}:"
  tail -n 1 "${out}/e1.txt"
  echo "E2 (${out}/e2.txt), exit ${e2}:"
  tail -n 1 "${out}/e2.txt"
  if [ "${red}" -ne 0 ]; then
    echo "RUNS-RED: ${red} of the 7 vitest runs exited non-zero: read their .log files in ${out}"
  fi
  echo "${result}"
} | tee -a "${out}/meta.txt"
exit "${code}"
