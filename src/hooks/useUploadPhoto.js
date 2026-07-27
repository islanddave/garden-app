// src/hooks/useUploadPhoto.js
// V2-PHOTO-F1 — shared 3-step upload engine.
//   1. GET  /api/photos/upload-url?key=...&content_type=...  -> { upload_url }
//   2. PUT  upload_url  body=file  Content-Type=mime           (direct S3, no auth)
//  2b. GET  /api/photos/thumb-upload-url?key=... -> PUT the 800px thumb at thumbs/<key>
//      BEST-EFFORT: every failure swallowed. Closes the gap where only the 913 backfilled
//      photos had thumbs and every new upload fell back to its full-size original.
//   3. POST /api/photos { storage_path, linkage..., caption, is_public } -> photo row
//
// Owns URL.createObjectURL / revokeObjectURL lifecycle so callers can't leak blob URLs.
//
// Contract:
//   useUploadPhoto({ errorMode = 'surface' }) -> {
//     upload(file, { keyPrefix, parentId, linkage, caption, is_public })
//       -> { photo, previewUrl } on success
//       -> { error } on failure when errorMode='surface'
//       -> throws when errorMode='swallow' is false AND caller did not provide onError
//     isUploading, error, photo, preview, reset
//   }
//
// errorMode:
//   'surface' (default) — errors stored in hook state AND returned in the result.
//                          Used by surfaces that fail loudly (PhotoLibrary).
//   'swallow'           — errors logged + photo:null result. Used by EventNew where
//                          photo upload is non-fatal (event already saved).

import { useState, useCallback, useRef, useEffect } from 'react';
import { useApiFetch, apiFetch } from '../lib/api.js';
import { buildPhotoKey, extFromFile, mimeFromFile } from '../lib/photoKeys.js';
import { downscaleWithThumb } from '../lib/imageDownscale.js';

// Step 2b only. The thumb is ~50KB; if it has not landed in 10s it is not going to, and it must
// never be the reason a save hangs (see the bounded-PUT note at its call site).
const THUMB_PUT_TIMEOUT_MS = 10_000;

// Lightweight UUID for the photo key segment. Doesn't need RFC4122 — the DB
// generates its own UUID for photos.id. This is the S3-key per-upload token.
function genUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for older test environments
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useUploadPhoto({ errorMode = 'surface' } = {}) {
  const { fetch } = useApiFetch();
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError]             = useState(null);
  const [photo, setPhoto]             = useState(null);
  const [preview, setPreview]         = useState(null);

  // Hold the active object URL so we can revoke on unmount or reset.
  const previewRef = useRef(null);

  useEffect(() => () => {
    if (previewRef.current) {
      URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    if (previewRef.current) {
      URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    }
    setPreview(null);
    setPhoto(null);
    setError(null);
    setIsUploading(false);
  }, []);

  const upload = useCallback(async (file, opts = {}) => {
    if (!file) {
      const err = new Error('useUploadPhoto: file is required');
      if (errorMode === 'surface') { setError(err.message); return { error: err.message }; }
      console.error(err);
      return { error: err.message };
    }

    const {
      keyPrefix    = 'standalone',
      parentId     = null,
      linkage      = {},
      caption      = null,
      is_public    = true,
      explicitExt  = null,
    } = opts;

    setIsUploading(true);
    setError(null);
    setPhoto(null);

    // BUG-PHOTOBLANK-001: shrink BEFORE anything derives from the file. Raw camera originals
    // (3-12MB) are what stall the S3 PUT on a mobile uplink. downscaleImage is fail-safe — it
    // returns the ORIGINAL file on any error or when re-encoding wouldn't save bytes — so this
    // can only reduce work, never block the upload. Runs first because ext/mime/key and the
    // preview must all describe the bytes we actually PUT (a HEIC normalized to JPEG changes
    // both extension and Content-Type).
    // Also yields the 800px thumb off the SAME decode (see downscaleWithThumb: a second decode
    // would double peak native memory on exactly the devices where uploads already hang).
    const { file: upFile, thumb } = await downscaleWithThumb(file);

    // Set up preview eagerly — caller may want to render before upload completes.
    // Revoke any previous one first. Previews the DOWNSCALED bytes: same image, less memory.
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    const url = URL.createObjectURL(upFile);
    previewRef.current = url;
    setPreview(url);

    try {
      const uuid = genUuid();
      const ext  = extFromFile(upFile, explicitExt);
      const mime = mimeFromFile(upFile);
      const key  = buildPhotoKey({ prefix: keyPrefix, id: parentId, uuid, ext });

      // Step 1: presign
      const presign = await fetch(
        `/api/photos/upload-url?key=${encodeURIComponent(key)}&content_type=${encodeURIComponent(mime)}`
      );
      if (!presign?.upload_url) throw new Error('Presign response missing upload_url');

      // Step 2: direct PUT to S3 (no auth header — URL is pre-signed)
      const putRes = await window.fetch(presign.upload_url, {
        method: 'PUT',
        body: upFile,
        headers: { 'Content-Type': mime },
      });
      if (!putRes.ok) throw new Error(`S3 upload failed: ${putRes.status} ${putRes.statusText}`);

      // Step 2b: the 800px thumb, at the server-derived key thumbs/<key>.
      //
      // STRICTLY BEST-EFFORT — every failure here is swallowed. The grid presigns thumbs/<key> and
      // falls back to view_url when the object is missing, which is precisely the pre-existing
      // behavior for the photos that have no thumb today. So the worst case of this block failing
      // is "no better than before", never a lost photo. It runs BEFORE the row is registered so a
      // photo never appears in the grid without its thumb, and it is cheap (the thumb is ~50KB
      // against a 2048px original).
      // BOUNDED (THUMB_PUT_TIMEOUT_MS): uploads deliberately bypass the WS-A6 apiFetch timeout
      // because a large original legitimately takes a while — but this extra PUT sits on the user's
      // save path, and "photo upload hangs" is an OPEN bug. An unbounded call here would add a new
      // way for Save to stall forever. A thumb is ~50KB, so if it hasn't landed in 10s it is not
      // going to; abandon it and let the read path fall back. Never applied to the original PUT.
      if (thumb) {
        try {
          const tPresign = await fetch(`/api/photos/thumb-upload-url?key=${encodeURIComponent(key)}`);
          if (tPresign?.upload_url) {
            const ac = typeof AbortController === 'function' ? new AbortController() : null;
            const timer = ac ? setTimeout(() => ac.abort(), THUMB_PUT_TIMEOUT_MS) : null;
            try {
              await window.fetch(tPresign.upload_url, {
                method: 'PUT',
                body: thumb,
                headers: { 'Content-Type': 'image/jpeg' },
                ...(ac ? { signal: ac.signal } : {}),
              });
            } finally {
              if (timer) clearTimeout(timer);
            }
          }
        } catch { /* no thumb: read path falls back to view_url, exactly as it does today */ }
      }

      // Step 3: register the photo row + linkage
      const registered = await fetch('/api/photos', {
        method: 'POST',
        body: JSON.stringify({
          storage_path: key,
          caption,
          is_public,
          ...linkage,
        }),
      });

      setPhoto(registered);
      setIsUploading(false);
      return { photo: registered, previewUrl: url };
    } catch (err) {
      const msg = err?.message ?? String(err);
      setIsUploading(false);
      if (errorMode === 'surface') {
        setError(msg);
        return { error: msg };
      }
      // swallow mode — log + return error in result, never throw
      console.error('useUploadPhoto (swallow):', msg);
      return { error: msg };
    }
  }, [fetch, errorMode]);

  return { upload, isUploading, error, photo, preview, reset };
}

// Test seam: lets unit tests inject a custom apiFetch reference without
// having to wire Clerk. Keeps the public surface clean.
export const __testing__ = { apiFetch };
