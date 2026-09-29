// Stub for @neondatabase/serverless. `neon(url)` returns a tagged-template function, which is how
// the handlers call it: sql`SELECT ...${value}...`.
import { stubState } from './state.js';

export function neon(connectionString) {
  const tagged = async (strings, ...values) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);
    stubState.sqlCalls.push({ text, values, connectionString });
    return stubState.sqlHandler(text, values);
  };
  // sql.transaction([...]): the stub has already executed each element (a tagged call runs eagerly
  // here), in order, so the batch is just their results — the shape the real driver returns.
  tagged.transaction = async (queries) => Promise.all(queries);
  return tagged;
}
