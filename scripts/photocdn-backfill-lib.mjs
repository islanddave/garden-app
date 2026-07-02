// V4-PHOTOCDN-001 P3d backfill — PURE helpers (no I/O, no AWS/DB deps). Unit-tested directly;
// the driver (photocdn-backfill.mjs) imports these + adds the S3/Lambda/Neon I/O.

export function stripQuotes(etag) { return String(etag ?? '').replace(/"/g, ''); }

// S3 object key (== CDN path minus the leading slash) of a derivative. Path-addressed + etag-scoped
// so a replaced original yields a new key (free CDN invalidation). Matches the generator rawPath.slice(1).
export function derivativeKey(variant, etag, storagePath) {
  if (!['thumb', 'card'].includes(variant)) throw new Error(`bad variant: ${variant}`);
  return `d/${variant}/${stripQuotes(etag)}/${storagePath}.webp`;
}
export function invokeRawPath(variant, etag, storagePath) { return '/' + derivativeKey(variant, etag, storagePath); }

// A row is already backfilled iff its persisted etag matches the live object AND all derivative fields exist.
export function isBackfilled(row, currentEtag) {
  return !!row.original_etag && stripQuotes(row.original_etag) === stripQuotes(currentEtag)
    && !!row.derivative_thumb_key && !!row.derivative_card_key && !!row.blurhash;
}

export const REQUIRED_COLUMNS = ['original_etag', 'derivative_thumb_key', 'derivative_card_key', 'blurhash'];
