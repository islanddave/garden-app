// db-error.js — MASTER. Byte copies ship in each handler dir whose catch answers a database error
// (scripts/lambda-copies.json); a Lambda zip cannot reach ../. SEC-20: a reply names the KIND of refusal, never the
// database's words: no constraint, column, table, message or detail. Sentences a handler keys on a constraint
// name are consulted BEFORE this. Pure: no imports, no SQL. Executed by lambda/db-error.test.js.
export const DB_ERROR_REPLIES = Object.freeze({
  '23514': Object.freeze({ status: 400, error: 'Constraint violation', code: 'check_violation' }),
  '23502': Object.freeze({ status: 400, error: 'Required field missing', code: 'not_null_violation' }),
  '23503': Object.freeze({ status: 400, error: 'Foreign key violation', code: 'foreign_key_violation' }),
  '23505': Object.freeze({ status: 409, error: 'Unique violation', code: 'unique_violation' }),
  '42P01': Object.freeze({ status: 500, error: 'Schema out of date for this deploy — relation missing', code: 'schema_out_of_date' }),
  '42703': Object.freeze({ status: 500, error: 'Schema out of date for this deploy — column missing', code: 'schema_out_of_date' }),
});

// The reply for err when this handler maps its SQLSTATE (`arms`), else null, and the caller answers its own generic
// 500. Reads err.code and nothing else.
export function dbErrorReply(err, arms) {
  const code = err?.code;
  if (typeof code !== 'string' || !arms.includes(code) || !Object.hasOwn(DB_ERROR_REPLIES, code)) return null;
  const r = DB_ERROR_REPLIES[code];
  return { status: r.status, body: { error: r.error, code: r.code } };
}

const SQLSTATE = /^(?:[0-9][0-9A-Z]|P0|XX|HV|F0)[0-9A-Z]{3}$/;
// Class 42 names a missing relation or column and P0 is a trigger's RAISE text; neither carries row values.
// A class 22 or 23 message can ("invalid input syntax for type uuid: "<value>""), and detail always can.
const MESSAGE_CLASSES = new Set(['42', 'P0']);

// One log line per caught error. A database error is JSON with its object names and call frames as the locator;
// anything else (TypeError, ECONNRESET) is logged whole with its stack, as `console.error(msg, err)` always was.
export function logCaughtError(msg, err) {
  const code = err?.code;
  if (typeof code !== 'string' || !SQLSTATE.test(code)) {
    console.error(msg, err);
    return;
  }
  const line = { msg, code, constraint: err.constraint ?? null, table: err.table ?? null, column: err.column ?? null, routine: err.routine ?? null };
  if (MESSAGE_CLASSES.has(code.slice(0, 2))) line.message = String(err.message ?? '');
  line.frames = framesOf(err);
  console.error(JSON.stringify(line));
}

// The stack after its message, call frames only: the first line repeats the message, which may span lines.
function framesOf(err) {
  const stack = typeof err.stack === 'string' ? err.stack : '';
  const message = typeof err.message === 'string' ? err.message : '';
  const at = message ? stack.indexOf(message) : -1;
  const rest = at === -1 ? stack : stack.slice(at + message.length);
  return rest.split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 8).map((l) => l.trim());
}
