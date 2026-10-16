// C-HARNESS arm CLI. Called by harness.py, once per branch:
//   HARNESS_DSN=<url> node scripts/space-harness/arm.mjs --tree <worktree> --today YYYY-MM-DD \
//     --fixture <fetchers.json> --out <arm.json> [--local-pg] [--driver <dir>] [--ws <dir>] [--echo]
// The URL is read from the environment only (never argv, never printed). The result goes to --out;
// the handler's console is captured into it (and echoed to stderr with --echo), never mixed into stdout.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { runArm } from './arm-lib.mjs'

function parse(argv) {
  const o = { localPg: false, echo: false }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = () => { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); return argv[++i] }
    if (k === '--tree') o.tree = path.resolve(v())
    else if (k === '--today') o.today = v()
    else if (k === '--fixture') o.fixture = v()
    else if (k === '--out') o.out = v()
    else if (k === '--driver') o.driverDir = path.resolve(v())
    else if (k === '--ws') o.wsDir = path.resolve(v())
    else if (k === '--local-pg') o.localPg = true
    else if (k === '--echo') o.echo = true
    else throw new Error(`unknown argument ${k}`)
  }
  for (const k of ['tree', 'today', 'fixture', 'out']) if (!o[k]) throw new Error(`--${k} is required`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.today)) throw new Error('--today must be YYYY-MM-DD')
  return o
}

let opts
try { opts = parse(process.argv.slice(2)) } catch (e) { process.stderr.write(`usage: ${e.message}\n`); process.exit(2) }
const dsn = process.env.HARNESS_DSN
if (!dsn) { process.stderr.write('usage: HARNESS_DSN is not set\n'); process.exit(2) }
const fixture = JSON.parse(readFileSync(opts.fixture, 'utf8'))
const res = await runArm({ ...opts, dsn, fixture, echo: opts.echo ? (s) => process.stderr.write(s) : null })
writeFileSync(opts.out, JSON.stringify(res, null, 1))
process.stdout.write(`arm ${res.error ? 'ERROR' : 'ok'}: ${res.head || '?'} rows=${res.result ? res.result.rows : '-'} ` +
  `console=${res.console.length} calls=${res.calls.length}\n`)
process.exit(res.error ? 1 : 0)
