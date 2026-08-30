// Stub for @aws-sdk/s3-request-presigner (V4-IGSHARE-001).
//
// The real getSignedUrl is what makes the Instagram staging hop safe: Meta fetches the image over
// this URL, and the signature was proven load-bearing against the live API on 2026-08-21 (the same
// URL unsigned returns HTTP 403). The stub returns a URL that CARRIES THE KEY VERBATIM so a test can
// assert which object was handed to Meta — the one thing that must never be the untouched original.
import { stubState } from './state.js';

// `bucket` is recorded as well as `key` because the two can diverge: staging writes to
// IG_STAGING_BUCKET while the rest of the handler reads from S3_PHOTOS_BUCKET, and a presign left
// pointing at the wrong bucket produces a URL that 404s for Meta with no other symptom in this suite.
export async function getSignedUrl(_client, command, options) {
  const key = command?.input?.Key ?? 'unknown';
  const bucket = command?.input?.Bucket ?? null;
  stubState.presigns.push({ key, bucket, expiresIn: options?.expiresIn ?? null });
  return `https://stub-presigned.example/${key}?X-Amz-Expires=${options?.expiresIn ?? 0}&X-Amz-Signature=stub`;
}
