// Stub for @clerk/backend — see ./state.js for why stubs rather than mocks.
import { stubState } from './state.js';

export async function verifyToken(token, opts) {
  stubState.verifyTokenCalls.push({ token, opts });
  const r = stubState.verifyTokenResult;
  if (r instanceof Error) throw r;
  if (r == null) throw new Error('stub: verifyTokenResult not configured');
  return r;
}
