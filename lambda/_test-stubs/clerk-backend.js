// Stub for @clerk/backend — see ./state.js for why stubs rather than mocks.
import { stubState } from './state.js';
import { applyHouseholdDefault } from './householdDefault.js';

export async function verifyToken(token, opts) {
  stubState.verifyTokenCalls.push({ token, opts });
  const r = stubState.verifyTokenResult;
  if (r instanceof Error) throw r;
  if (r == null) throw new Error('stub: verifyTokenResult not configured');
  applyHouseholdDefault(r.sub);
  return r;
}

// Backend API user list, as members/index.js calls it: `userId` filters to those ids, then `offset` and
// `limit` (Clerk's default 10) page the result, so a roster read without the filter sees only a page.
export function createClerkClient() {
  return {
    users: {
      async getUserList(params = {}) {
        stubState.clerkListCalls.push(params);
        const all = Array.isArray(params.userId)
          ? stubState.clerkUsers.filter((u) => params.userId.includes(u.id))
          : stubState.clerkUsers;
        const from = params.offset ?? 0;
        return { data: all.slice(from, from + (params.limit ?? 10)), totalCount: all.length };
      },
    },
  };
}
