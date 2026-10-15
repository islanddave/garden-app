# V5-TODAYREDESIGN-001 S7 — the redesigned Today's remembered open/closed state on `user_notification_prefs`

Plan-v2 §2.1 (Layer 1) and §8 S7, amended by §13 MF1 (date-scoped acks); finish plan V100-20261014 §4 row L6.
A section header tap on the redesigned Today is remembered per person, and from S7 it follows the person across
phones: the device's localStorage mirror (`today-sections:<user>`, shipped in S2) gains a server copy in
`user_notification_prefs.today_sections`, read and written through the critter Lambda's prefs route.

## Status

| Step | State |
|---|---|
| `0a` / `0c` staging | **APPLIED 2026-10-15** — pre 5/5, sweep 1/1 before and after 0a, post 6/6 |
| `0a` / `0c` prod | **APPLIED 2026-10-15** on Dave's OK (AskUserQuestion, first-hand: "Staging then prod") — pre-apply copy `sitting-todaysections-prod-preapply-20261015` (expires 2026-10-22); pre 5/5, sweep 1/1 before and after 0a, post 6/6 incl. `post_today_sections_is_nullable_jsonb_without_default` |
| Critter Lambda (`lambda/critter/`) | on dev with this folder; ships with the next promote |
| SPA (`src/`) | on dev with this folder; ships with the next promote |
| Schema-audit waiver | **Not used** — Dave chose option B (column first), so the waiver commit was dropped before the push |

## Files

| file | what it does |
|---|---|
| `0a-additive-ddl.sql` | One transaction: `ADD COLUMN IF NOT EXISTS today_sections jsonb` (nullable, no default); `chk_unp_today_sections_shape` (`today_sections IS NULL OR jsonb_typeof(today_sections) = 'object'`) added `NOT VALID`; column comment; the `5.0.0-todaysections-001` stamp. |
| `0c-validate.sql` | `VALIDATE`s the CHECK. Safe at once (below). Idempotent. |
| `0r-rollback.sql` | Drops the CHECK, the column and the stamp. Lambda revert first. Loses only the cross-device copy. |
| `gates.yml` | 5 `pre`, 1 `sweep` (apply-window only); 1 `post` receipt + 5 standing `post` invariants, each self-armed on the stamp. `gate_runner.py --validate-only`: 12 gates, schema-valid. |

The DDL, exactly:

```sql
ALTER TABLE public.user_notification_prefs ADD COLUMN IF NOT EXISTS today_sections jsonb;
ALTER TABLE public.user_notification_prefs
  ADD CONSTRAINT chk_unp_today_sections_shape
  CHECK (today_sections IS NULL OR jsonb_typeof(today_sections) = 'object') NOT VALID;   -- guarded by name
-- 0c:
ALTER TABLE public.user_notification_prefs VALIDATE CONSTRAINT chk_unp_today_sections_shape;
```

## The stored value and its contract

```json
{ "v": 1,
  "harvest": { "open": true,  "at": "2026-10-14" },
  "care":    { "open": false, "at": "2026-10-14", "ack": { "r": "small" } },
  "protect": { "open": false, "at": "2026-10-14", "ack": { "t": "frost" } },
  "hh-user_2ab": { "open": true, "at": "2026-10-12" } }
```

The database checks shape only (NULL or an object). The critter Lambda's validator
(`lambda/critter/validators.js` `todaySectionsError`) is the contract; the client's copy
(`src/lib/todayV2/sectionsWire.js`) is pinned to it by `lambda/critter/todaySections.parity.test.js`.

- `v` must be `1`. At most 24 keys including `v`, at least one section, at most 4096 characters serialized.
- Keys are a whitelist: `glance protect headsup care harvest putup resting`, and `hh-` + 1–8 of `[A-Za-z0-9_-]`
  (one per other household member: the first 8 characters of their Clerk sub, `HouseholdSection.jsx`
  `householdKey`, which carries `_` and capitals). A new section is added to both copies in the same release.
- An entry is exactly `{open, at}` or `{open: false, at, ack}`. `at` is `YYYY-MM-DD` (the plan day of the tap).
- MF1: an `ack` records a close made while a trigger held the section open, so it rides only on `open: false`,
  and it is date-scoped by the entry's own `at` (no date of its own; no `ids`, no `keys` — §13 dropped them).
  `ack.t` ∈ `chill frost hardfreeze`; `ack.r` is one of, or a non-repeating list of, `never hot small window
  deadline` (`triggers.js` TIER_RANK and CARE_REASONS ∪ HEADSUP_REASONS). `reopens()` in `triggers.js` decides
  what an ack holds: only while `at` is today's plan day, and only until the trigger escalates.
- `today_sections` must be the only field in its PATCH (beside anything else: 400).

## Cross-device merge rule

**Writes.**

1. Only an explicit section-header tap writes (`TodayV2` `toggle` / `toggleGlance` → `useTodaySections.remember`).
   Expand all / Collapse all, a chip jump and an auto-open trigger are the visit's and never write
   (`TodayV2.s7.test.jsx`).
2. The tap lands in the device mirror first, marked dirty. The mirror is authoritative on that device until the
   server has confirmed the entry.
3. The device sends its dirty entries, and only those: `PATCH /api/notifications/prefs`
   `{ "today_sections": { "v": 1, "<key>": entry, … } }`, alone, `keepalive`. It sends at the tap and again at
   every mount of Today (a visit start or a return), one request at a time; taps made while a request is on the
   wire go together in the next one.
4. The server merges per top-level key, in one statement:
   `today_sections = COALESCE(stored, '{}'::jsonb) || incoming`. A section the PATCH carries replaces that
   section's stored entry whole (an ack included or dropped with it); every section it does not carry is kept.
   Every other column on this route still replaces whole (`COALESCE(new, old)`).
5. A 200 clears dirty for exactly the keys whose mirror entry is still the one that was sent. A key tapped again
   while its request was out stays dirty and goes in the next request. A 400 (a pre-S7 Lambda), a 409 (the S7
   Lambda before this DDL), a 5xx or a network failure clears nothing; the entries go again at the next mount.
   An entry the server would refuse is never sent, so it can never hold the others back; it stays on the device.

**Reads, per section, at the visit's ready point** (once per visit; a server answer that lands later waits for
the next visit):

1. a dirty mirror entry, else
2. the server's entry from `prefs.today_sections` — ignored when the service worker served the prefs body from its
   cache, and ignored for a section this device saved (and had confirmed) after that body was read, else
3. the mirror's (clean) entry, else
4. nothing: closed, unless a trigger opens it.

Rule 2's second exclusion is S7's addition. PrefsProvider reads prefs once per app launch (and Today refreshes it
at a plan-day change). Without the exclusion, the boot body held since before a tap would overrule the tap's now
clean mirror entry at the next visit, and a section just closed would spring back open. Every prefs body is
stamped (a non-enumerable symbol, `PREFS_SECTIONS_READ_AT`) with the count of confirmed section saves when its read
started; `sectionPredatesSave` compares it per section (`notificationPrefsClient.js`, the same idea as
`PREDATES_GROUP_BY_SAVE`). A body read after the save is the server's again.

**What that means for two phones.** Last delivered write wins, per section. Phone A closes Harvest; phone B,
booted earlier, opens Put-Up; both survive on the server, and a third phone that boots afterwards shows both
(`useTodaySections.sync.test.jsx`). B keeps showing its boot-time Harvest until its next prefs read (next launch or
plan-day change): another phone's tap never rearranges a page mid-session. Two phones tapping the same section:
the PATCH that reaches the server last wins.

**Known edge, accepted (plan-v2's rule, not changed here).** Precedence is by delivery, not by tap time. A tap made
offline stays dirty; if another phone sets the same section meanwhile, the offline phone's older entry overwrites
it when it reconnects and re-sends. Bounded to sections tapped while offline; the plan-day `at` would allow a
"newer `at` wins" guard later if Dave wants one.

## Promotability, and the order the code may land

The S7 critter Lambda **tolerates the column's absence**:

- `readUserPrefs`' boot SELECT is unchanged and never names `today_sections` (pinned by
  `lambda/critter/prefs-columns.test.js`). The column is read by its own statement (`readTodaySections`), run beside
  the boot read. On SQLSTATE 42703 naming the column the GET carries **no** `today_sections` key (absent = "this
  server cannot store it yet"; `null` = "stored nothing yet"), and the absence is remembered for 60 s per warm
  container. Any other failure of that read is logged and the key omitted; the boot read never fails for it.
- The PATCH writes it by its own upsert, which is the only statement that names it. On 42703 it answers
  **409** `today_sections is not stored on this server yet`, with nothing written. Every other save is unaffected.
- `lambda/critter/prefsTodaySections.test.js` drives both states through the real handler.

**The prod schema gate still sees the column.** `prefs-columns.test.js` lists `today_sections` (the contract must
name what the code names), so `dev-main-schema-audit.py --gate` reports it missing on prod until `0a` lands there.
Two ways to live with that — pick one:

- **A. Keep the waiver** (`scripts/schema-audit-allowlist.json`, `user_notification_prefs.today_sections`, its own
  commit). Dev stays promotable before the prod DDL; the runtime tolerance above is what makes that safe. The waiver
  is not a feature flag and says so. **Delete it the moment `0a` is on prod**: a stale waiver fails the advisory
  audit and warns at the promote gate.
- **B. Drop the waiver commit** and land the DDL first (the house order, as v5-navcustom-001). From the moment this
  code is on dev, every promote refuses until the prod DDL is applied (or is dispatched with
  `require_schema_audit=false`).

## Landing order (recommended either way)

Run from the garden-app repo root. `gate_runner.py` reads `NEON_STAGING_URL` / `NEON_DATABASE_URL` from the
environment and never takes a URL on the command line (L-067).

1. **Staging**
   1. `python3 scripts/gate_runner.py --migration migrations/v5-todaysections-001 --env staging --phase pre` (5 PASS)
   2. `... --env staging --phase sweep` (vacuous before 0a)
   3. `psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f migrations/v5-todaysections-001/0a-additive-ddl.sql`
   4. `... --env staging --phase sweep` again: the L-058 pre-VALIDATE sweep, now over the real column
   5. `psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f migrations/v5-todaysections-001/0c-validate.sql`
   6. `... --env staging --phase post` (6 PASS)
2. **Prod — only on Dave's explicit OK** (plan-v2 §10 item 7), citing step 1.6's PASS. Take the pre-apply copy with
   an expiry first (`scripts/neon_safety_branch.py --env-file .env.local create --slug <sitting>`), then the same six
   steps with `--env prod` and `"$NEON_DATABASE_URL"`. Cite the PASS of
   `post_today_sections_is_nullable_jsonb_without_default` (an information_schema read on prod) wherever the ship is
   recorded. Then delete the waiver (option A) in its own commit.
3. **Both environments, whole corpus**: `python3 scripts/gate_runner.py --all --env prod --phase post --continuous-only`,
   then `--env staging`.
4. **Then** push the code to `dev` → CI → staging deploy and smoke (block M5 runs the full round trip once staging
   has the column; before that it asserts the 409 state and WARNs) → promote only on Dave's ship phrase →
   verify the live critter CodeSha256 and a prefs GET 200 carrying `today_sections` for both users.

Any Lambda change in the promoted range redeploys all 26 functions; record
`git diff --stat <last-promoted>..<dev> -- lambda/` in the promote record.

**Code before DDL is safe too** (the tolerance above), so steps 1–3 and step 4 may land in either order. What the
early-code order costs: until the column exists, each Today mount that has dirty entries sends them into a 409,
and each warm critter container tries the read once a minute; the person's own phone keeps working from its
mirror throughout, and nothing crosses phones until the column lands.

## Why VALIDATE in 0c is safe immediately

The test for arming a writer-coupled CHECK (gardening-deploy, after the 2026-08-03 harvest outage) is: *would the
currently deployed code produce a row that violates it?* No, in either landing order. Before the S7 Lambda is live
nothing writes the column, so every row is NULL (the CHECK's first arm). After it, the only writer stores
`COALESCE(stored, '{}') || <object the validator accepted>`, which is an object.

## Rollback

Code back before schema back: promote a `main` that predates the S7 prefs-route change and redeploy the critter
Lambda, confirm it no longer names the column, THEN run `0r-rollback.sql` (snapshot query in its header). The reverse
order is not an outage here (the Lambda tolerates the missing column) but leaves every Today mount re-sending into a
409. An SPA that still sends `today_sections` to a reverted Lambda gets 400 "no updatable fields present" and keeps the
entries on the device. Forward undo (`OPS-FORWARDUNDO-001`) is the house default: prefer a forward commit that stops
the client sending over dropping the column.

## Design decisions

- **This table.** Per person (Jen's Today never follows Dave's taps), read at every boot, already the home of
  `today_skipped`, `more_pins` and `bar_layout`.
- **Nullable, no DEFAULT, no 0b.** NULL is "never tapped". There is no server value to migrate; each device's mirror
  reaches the server at its next mount through the dirty-entry resend, which needs no data step.
- **Shape only in the database.** A vocabulary CHECK would make a retired section key a 23514 on every later save.
  `post_only_the_shape_check_touches_today_sections` pins that.
- **Its own statements in the Lambda.** The only way a route that names a column can survive that column's absence
  in Postgres (a missing column fails at parse time, before any guard runs).
- **Sent alone, enforced on the server.** The client already sent it alone (a pre-S7 Lambda's 400 drops the whole
  body); the S7 validator refuses a mixed body so the 409 path can never half-save one.
- **Self-arming post gates, values through `to_jsonb`.** Nothing here reds `gate-invariants.yml` before the apply,
  and no gate names the new column as a column (the parse-time hazard).

## Verification performed at authoring (2026-10-14)

No database connection was opened and nothing was applied. `gate_runner.py --validate-only` on this folder (exit 0,
12 gates); the critter Lambda's tests including both column states; the full vitest run; the schema-audit parser
self-tests and pytest suites (DB-free); `bash -n` on the smoke script (block M5 written, not run). Gate exits are in
the lane log.
