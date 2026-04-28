// Clerk JWT verification for Lambda functions
// Verifies the Authorization: Bearer <token> header on every request.

import { createClerkClient } from '@clerk/backend';

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

/**
 * Extract and verify Clerk session token from Lambda event headers.
 * Returns the Clerk user ID string (e.g. "user_2abc123") on success.
 * Throws on missing/invalid token — caller returns 401.
 *
 * @param {object} event - Lambda event object
 * @returns {Promise<string>} Clerk user ID
 */
export async function requireAuth(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AuthError('Missing or malformed Authorization header');
  }
  const token = authHeader.slice(7);
  try {
    const payload = await clerk.verifyToken(token);
    return payload.sub; // Clerk user ID: "user_2abc123"
  } catch {
    throw new AuthError('Invalid or expired token');
  }
}

export class AuthError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'AuthError';
  }
}

// Standard Lambda response helpers
// NOTE: No CORS headers here — Lambda Function URL handles CORS.
// Adding them here causes duplicate Access-Control-Allow-Origin headers
// which browsers reject.
export const ok = (body) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const created = (body) => ({
  statusCode: 201,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const noContent = () => ({
  statusCode: 204,
  headers: {},
  body: '',
});

export const err = (status, message) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error: message }),
});

// CORS preflight — Function URL handles OPTIONS before invoking Lambda,
// so this is kept as a safety fallback but should never be reached.
export const corsPreflight = () => ({
  statusCode: 200,
  headers: {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  },
  body: '',
});

