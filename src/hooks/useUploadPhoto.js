// src/hooks/useUploadPhoto.js
// V2-PHOTO-F1 — shared 3-step upload engine.
//   1. GET  /api/photos/upload-url?key=...&content_type=...  -> { upload_url }
//   2. PUT  upload_url  body=file  Content-Type=mime           (direct S3, no auth)
//  2b. GET  /api/photos/thumb-upload-url?key=... -> PUT the 800px thumb at thumbs/<key>
//      BEST-EFFORT: every failure swallowed. Closes the gap where only the 913 backfilled
//      photos had thumbs and every new upload fell back to its full-size original.
//   3. POST /api/photos { storage_path, linkage..., caption, is_public, capture meta } -> photo row
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
import { invalidatePrefix as invalidatePhotoLists } from '../lib/dataCache.js';
import { buildPhotoKey, extFromFile, mimeFromFile } from '../lib/photoKeys.js';
import { downscaleWithThumb } from '../lib/imageDownscale.js';
import { readCaptureMeta } from '../lib/imagePipeline.js';
import { stripImageFile } from '../lib/imageMetadataStrip.js';
import { putWithProgress } from '../lib/uploadPut.js';

// Step 2b only. The thumb is ~50KB; if it has not landed in 10s it is not going to, and it must
// never be the reason a save hangs (see the bounded-PUT note at its call site).
const THUMB_PUT_TIMEOUT_MS = 10_000;

// BUG-PHOTOUPLOADRELAY-001: when the direct-to-S3 PUT fails (stall watchdog, dead socket), retry
// THROUGH the API — a client's route to S3 can be dead while its route to Lambda is healthy
// (observed live 2026-07-28: s3.us-east-1 TCP blackholed inside the ISP, Lambda traffic fine).
// Caps mirror the server route; a fallback-to-original file larger than the cap skips the relay
// and surfaces the direct-PUT error honestly. The relay call gets its own generous timeout —
// the WS-A6 15s default is too tight for shipping the photo bytes in the request body.
const RELAY_MAX_BYTES = 3_900_000;
const RELAY_THUMB_MAX_BYTES = 500_000;
const RELAY_TIMEOUT_MS = 60_000;

// Blob -> base64. Prefers arrayBuffer (chunked btoa so a multi-MB buffer can't blow the arg
// limit); falls back to FileReader for engines whose Blob lacks arrayBuffer (incl. jsdom).
async function blobToBase64(blob) {
  if (typeof blob.arrayBuffer === 'function') {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '');
    fr.onerror = () => reject(fr.error ?? new Error('FileReader failed'));
    fr.readAsDataURL(blob);
  });
}

// BUG-PHOTOUPLOADHANG-001: downscaleWithThumb is throw-proof (returns the original on any error)
// but ran unbounded BEFORE the try block — a decode/encode that never settles (mobile memory
// pressure is a real toBlob failure mode) wedged the save forever with isUploading stuck true and
// no error. A phone decodes a camera photo in 1-3s; if it has not settled in 15s it is not going
// to. On deadline, proceed with the ORIGINAL file — exactly the module's own fail-safe contract,
// enforced by clock instead of by catch.
const DOWNSCALE_DEADLINE_MS = 15_000;

// BUG-PHOTOTAKENATNULL-001: same discipline for the capture-metadata read. readCaptureMeta reads a
// bounded ~128KB slice and swallows its own errors, so the only way past this deadline is a File
// whose read never settles (a content:// picker handle on a yanked SD card) or an exifr chunk that
// never arrives. It is a backstop, not a budget — the read is kicked off at the top of upload() and
// only awaited after the S3 PUT, so it has the whole upload to settle. Losing the metadata here is
// acceptable; losing the photo is not.
const CAPTURE_META_DEADLINE_MS = 5_000;
const NO_CAPTURE_META = { takenAt: null, tzOffset: null, gpsLat: null, gpsLon: null, orientation: null };

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
  // BUG-PHOTOUPLOADHANG-001 instrumentation: which step the save is in ('preparing' | 'uploading'
  // | 'saving' | null) and PUT progress 0-100 (null outside step 2). A future "stuck" report can
  // then name the exact step + percentage instead of just "stuck".
  const [stage, setStage]             = useState(null);
  const [progress, setProgress]       = useState(null);

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
    setStage(null);
    setProgress(null);
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
    setStage('preparing');
    setProgress(null);

    try {
      // BUG-PHOTOTAKENATNULL-001: capture metadata, read from the ORIGINAL `file`. Both ends of
      // this plumbing shipped in v3.55.0 — imagePipeline extracts the fields, and
      // lambda/photos/index.js binds all of them in both INSERT templates — and nothing ever
      // connected them, so taken_at was NULL on 1,270 of 1,270 prod rows while the phone destroyed
      // the only copy on every upload.
      //
      // ORDERING (imagePipeline.js rule 1) IS PRESERVED BY WHICH BYTES ARE READ, NOT BY WHEN.
      // canvas.toBlob() emits a bare JPEG with no APP1 segment, so reading the RESIZED output
      // returns null forever. `file` is const and downscaleWithThumb returns a NEW File rather than
      // mutating it, so this sees the original APP1 no matter how the resize below turns out.
      // Started here and awaited only after the PUT: a 128KB header read overlapped with a ~50MB
      // decode costs nothing, and it gives readCaptureMeta's lazy exifr chunk the whole presign+PUT
      // window to arrive before anything waits on it.
      const capturePromise = Promise.resolve(readCaptureMeta(file))
        .then((v) => v ?? NO_CAPTURE_META, () => NO_CAPTURE_META);

      // BUG-PHOTOBLANK-001: shrink BEFORE anything derives from the file. Raw camera originals
      // (3-12MB) are what stall the S3 PUT on a mobile uplink. downscaleImage is fail-safe — it
      // returns the ORIGINAL file on any error or when re-encoding wouldn't save bytes — so this
      // can only reduce work, never block the upload. Runs first because ext/mime/key and the
      // preview must all describe the bytes we actually PUT (a HEIC normalized to JPEG changes
      // both extension and Content-Type).
      // Also yields the 800px thumb off the SAME decode (see downscaleWithThumb: a second decode
      // would double peak native memory on exactly the devices where uploads already hang).
      // BUG-PHOTOUPLOADHANG-001: raced against DOWNSCALE_DEADLINE_MS — a decode that never
      // settles must not wedge the save; the module's own fail-safe (original file, no thumb)
      // is applied by deadline.
      let { file: upFile, thumb } = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          console.warn(`downscaleWithThumb did not settle in ${DOWNSCALE_DEADLINE_MS}ms — uploading the original`);
          resolve({ file, thumb: null });
        }, DOWNSCALE_DEADLINE_MS);
        downscaleWithThumb(file).then(
          (v) => { clearTimeout(timer); resolve(v && v.file ? v : { file, thumb: null }); },
          () => { clearTimeout(timer); resolve({ file, thumb: null }); },
        );
      });

      // V4-PHOTOEXIFSTRIP-001 — nothing reaches S3 carrying the camera's capture metadata. Dave's
      // garden IS his home, so a GPS tag is his home address (measured on his own originals:
      // 42.5087 / -72.6470, the house).
      //
      // PLACED AFTER THE DOWNSCALE ON PURPOSE. The canvas path already emits a bare EXIF-free JPEG,
      // so on the common path this is a cheap no-op. It exists for the FIVE paths that hand back
      // the ORIGINAL camera file: under MIN_BYTES, an undecodable codec, no usable canvas, a
      // re-encode that grew — all four of imageDownscale's fail-safe returns — plus the
      // DOWNSCALE_DEADLINE_MS timeout immediately above. Those are exactly the paths that skip
      // processing, which is why they are the ones that leak.
      //
      // PLACED BEFORE ext/mime/key/preview/PUT so every derived value, the preview the user sees,
      // and every byte that leaves the device all describe the stripped file — including
      // file_size_bytes below and the relay-upload fallback, which re-reads these same variables.
      //
      // readCaptureMeta ABOVE IS UNAFFECTED and must stay that way (imagePipeline rule 1): it was
      // handed the original `file` and started before this line, so taken_at/gps_lat still land in
      // the household-scoped DB row. This removes metadata from the bytes we PUBLISH, not from the
      // record we keep.
      //
      // NOT FAIL-SAFE, deliberately unlike the downscale above — see imageMetadataStrip.js's
      // contract note. A photo whose bytes cannot be read fails the save and costs a retry; it is
      // never uploaded unstripped. Sequential rather than parallel so only one copy of a
      // multi-megabyte original is held at a time (imagePipeline rule 3's memory class).
      upFile = await stripImageFile(upFile);
      if (thumb) thumb = await stripImageFile(thumb);

      // Set up preview eagerly — caller may want to render before upload completes.
      // Revoke any previous one first. Previews the DOWNSCALED bytes: same image, less memory.
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      const url = URL.createObjectURL(upFile);
      previewRef.current = url;
      setPreview(url);

      const uuid = genUuid();
      const ext  = extFromFile(upFile, explicitExt);
      const mime = mimeFromFile(upFile);
      const key  = buildPhotoKey({ prefix: keyPrefix, id: parentId, uuid, ext });

      // Step 1: presign
      const presign = await fetch(
        `/api/photos/upload-url?key=${encodeURIComponent(key)}&content_type=${encodeURIComponent(mime)}`
      );
      if (!presign?.upload_url) throw new Error('Presign response missing upload_url');

      // Step 2: direct PUT to S3 (no auth header — URL is pre-signed).
      // BUG-PHOTOUPLOADHANG-001: was a bare window.fetch with NO bound — the traced hang site
      // (presign logged, no S3 object, no register). Now progress-aware with a stall watchdog:
      // aborts only when bytes stop moving, so a slow-but-moving fallback original still lands.
      setStage('uploading');
      let relayedThumb = false;
      try {
        await putWithProgress(presign.upload_url, upFile, mime, { onProgress: setProgress });
      } catch (putErr) {
        // BUG-PHOTOUPLOADRELAY-001: direct path dead — relay the bytes through the API when they
        // fit. On relay failure the ORIGINAL error surfaces (it names the real problem).
        if (typeof upFile.size !== 'number' || upFile.size > RELAY_MAX_BYTES) throw putErr;
        setProgress(null);
        let relay;
        try {
          const data_b64 = await blobToBase64(upFile);
          const thumb_b64 = thumb && thumb.size <= RELAY_THUMB_MAX_BYTES ? await blobToBase64(thumb) : null;
          relay = await fetch('/api/photos/relay-upload', {
            method: 'POST',
            timeoutMs: RELAY_TIMEOUT_MS,
            body: JSON.stringify({ key, content_type: mime, data_b64, thumb_b64 }),
          });
        } catch {
          throw putErr;
        }
        if (!relay?.ok) throw putErr;
        relayedThumb = !!relay.thumb;
      }
      setStage('saving');
      setProgress(null);

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
      if (thumb && !relayedThumb) {
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

      // Bounded for the same reason the downscale is (BUG-PHOTOUPLOADHANG-001): nothing new on the
      // save path may be able to wedge it. The read has had the whole upload to settle by now, so
      // this deadline only ever fires on a read or a chunk fetch that is never going to finish.
      const capture = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          console.warn(`capture-metadata read did not settle in ${CAPTURE_META_DEADLINE_MS}ms — taken_at will be null`);
          resolve(NO_CAPTURE_META);
        }, CAPTURE_META_DEADLINE_MS);
        capturePromise.then(
          (v) => { clearTimeout(timer); resolve(v); },
          () => { clearTimeout(timer); resolve(NO_CAPTURE_META); },
        );
      });

      // Step 3: register the photo row + linkage
      const registered = await fetch('/api/photos', {
        method: 'POST',
        body: JSON.stringify({
          storage_path: key,
          caption,
          is_public,
          ...linkage,
          // BUG-PHOTOTAKENATNULL-001. These columns have been bound by buildPhotoInsert since
          // v3.55.0 and the client sent none of them. Written AFTER ...linkage deliberately: they
          // are derived from the bytes actually uploaded and must not be clobberable by a caller's
          // linkage object.
          // NULL IS A LEGITIMATE VALUE, not a gap to paper over. A screenshot, a download, or a
          // photo a messaging app already stripped genuinely has no capture time, and dating one
          // by upload time would make the column assert something untrue — the exact distinction
          // taken_at exists to draw (see its COMMENT in migrations/v4-photobulk-p1/0a-additive-ddl).
          // Readers already fall back to created_at when it is NULL.
          // content_hash is deliberately absent — writing it would arm idx_photos_content_hash_uniq
          // and turn this INSERT into an UPSERT. That belongs to V4-PHOTOBULK-001's dedupe work,
          // not to a capture-time fix; pinned by useUploadPhoto.captureMeta.test.js.
          taken_at:          capture.takenAt ? capture.takenAt.toISOString() : null,
          gps_lat:           capture.gpsLat,
          gps_lon:           capture.gpsLon,
          file_size_bytes:   typeof upFile.size === 'number' ? upFile.size : null,
          mime_type:         mime,
          original_filename: file.name || null,
        }),
      });

      setPhoto(registered);
      // V4-IMGCACHE-001 D-1: a new photo can land in ANY cached photo list — the /api/photos wall, a
      // ?attachedTo= gallery (via the server-side event→plant union), a ?location_id= grid. The client
      // can't compute which, so invalidate every /api/photos* key: subscribed surfaces refresh without a
      // remount; unmounted ones refetch on next mount. No-op when the cache is empty (flag off / tests).
      invalidatePhotoLists('/api/photos');
      setIsUploading(false);
      setStage(null);
      return { photo: registered, previewUrl: url };
    } catch (err) {
      const msg = err?.message ?? String(err);
      setIsUploading(false);
      setStage(null);
      setProgress(null);
      if (errorMode === 'surface') {
        setError(msg);
        return { error: msg };
      }
      // swallow mode — log + return error in result, never throw
      console.error('useUploadPhoto (swallow):', msg);
      return { error: msg };
    }
  }, [fetch, errorMode]);

  return { upload, isUploading, error, photo, preview, reset, stage, progress };
}

// Test seam: lets unit tests inject a custom apiFetch reference without
// having to wire Clerk. Keeps the public surface clean.
export const __testing__ = { apiFetch };
