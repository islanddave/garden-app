// Stub for @aws-sdk/client-s3. GetObject (Facebook + Instagram byte read), plus PutObject and
// DeleteObject for the Instagram staging hop (V4-IGSHARE-001), which writes an EXIF-stripped copy
// under ig-staging/ and sweeps it afterwards.
import { stubState } from './state.js';

export class GetObjectCommand {
  constructor(input) { this.input = input; }
}
export class PutObjectCommand {
  constructor(input) { this.input = input; }
}
export class DeleteObjectCommand {
  constructor(input) { this.input = input; }
}
export class S3Client {
  constructor(cfg) { this.cfg = cfg; }
  async send(cmd) {
    // Recorded per operation as well as on the shared list, so a test can assert the staging
    // lifecycle (put then delete) without pattern-matching a flat call log. The Key is what matters:
    // a staged object that is never deleted is a stripped copy of a private photo left in the bucket.
    if (cmd instanceof PutObjectCommand) {
      stubState.s3Puts.push(cmd.input);
      return {};
    }
    if (cmd instanceof DeleteObjectCommand) {
      stubState.s3Deletes.push(cmd.input);
      if (stubState.s3DeleteThrows) throw new Error('stub: delete failed');
      return {};
    }
    stubState.s3Calls.push(cmd?.input);
    if (stubState.s3Bytes == null) throw new Error('stub: s3Bytes not configured');
    return { Body: { transformToByteArray: async () => stubState.s3Bytes } };
  }
}
