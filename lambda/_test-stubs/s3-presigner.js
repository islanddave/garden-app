// Stub for @aws-sdk/s3-request-presigner (V4-IGSHARE-001).
//
// The real getSignedUrl is what makes the Instagram staging hop safe: Meta fetches the image over
// this URL, and the signature was proven load-bearing against the live API on 2026-08-21 (the same
// URL unsigned returns HTTP 403). The stub returns a URL that CARRIES THE KEY VERBATIM so a test can
// assert which object was handed to Meta — the one thing that must never be the untouched original.
import { stubState } from './state.js';

export async function getSignedUrl(_client, command, options) {
  const key = command?.input?.Key ?? 'unknown';
  stubState.presigns.push({ key, expiresIn: options?.expiresIn ?? null });
  return `https://stub-presigned.example/${key}?X-Amz-Expires=${options?.expiresIn ?? 0}&X-Amz-Signature=stub`;
}
