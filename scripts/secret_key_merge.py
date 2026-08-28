#!/usr/bin/env python3
"""Merge helper for scripts/secret-key-set.sh. Pure stdin/stdout so it is unit-testable and so no
secret value ever crosses argv (where `ps` would show it).

Three subcommands, each reading the bundle (and for `merge`, the new value) from stdin:

  check  <REQUIRED...>              stdin: bundle JSON
                                    exit 0 if it parses as an object holding every REQUIRED key
  merge  <KEY> <set|remove>         stdin: bundle JSON, NUL, new value
                                    stdout: merged JSON; exit 3 if unchanged (no-op)
  verify <KEY> <set|remove> <REQ..> stdin: bundle JSON
                                    exit 0 if REQUIRED all survive and KEY is in the intended state

Separated from the shell so the dangerous part — deciding what the new bundle contains — is
ordinary Python with tests, not string-mangling inside a heredoc.
"""
import json
import sys


def _load(raw):
    try:
        d = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.exit(f"REFUSING: secret is not valid JSON ({e}) — nothing written.")
    if not isinstance(d, dict):
        sys.exit("REFUSING: secret is not a JSON object — nothing written.")
    return d


def cmd_check(required):
    d = _load(sys.stdin.read())
    missing = [k for k in required if k not in d]
    if missing:
        # A throttled or partially-read bundle must never become the new bundle.
        sys.exit(f"REFUSING: pre-read is missing required key(s) {missing}. Nothing written.")
    print(f"  baseline OK — {len(d)} keys: {sorted(d)}", file=sys.stderr)


def cmd_merge(key, mode):
    current, _, newval = sys.stdin.buffer.read().partition(b"\0")
    d = _load(current.decode())
    before = dict(d)
    if mode == "remove":
        d.pop(key, None)
    else:
        d[key] = newval.decode()
    if d == before:
        sys.exit(3)
    print(f"  writing {len(d)} keys: {sorted(d)}", file=sys.stderr)
    sys.stdout.write(json.dumps(d))


def cmd_verify(key, mode, required):
    d = _load(sys.stdin.read())
    missing = [k for k in required if k not in d]
    if missing:
        sys.exit(f"POST-WRITE CHECK FAILED: required key(s) {missing} are GONE. Restore from the "
                 f"previous version (AWSPREVIOUS) immediately.")
    present = key in d
    if mode == "remove" and present:
        sys.exit(f"POST-WRITE CHECK FAILED: {key} is still present.")
    if mode != "remove" and not present:
        sys.exit(f"POST-WRITE CHECK FAILED: {key} was not stored.")
    print(f"OK — bundle now holds {len(d)} keys: {sorted(d)}")


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    cmd = argv[1]
    if cmd == "check":
        cmd_check(argv[2:])
    elif cmd == "merge":
        cmd_merge(argv[2], argv[3])
    elif cmd == "verify":
        cmd_verify(argv[2], argv[3], argv[4:])
    else:
        sys.exit(f"unknown subcommand: {cmd}")


if __name__ == "__main__":
    main(sys.argv)
