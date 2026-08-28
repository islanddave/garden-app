// Stub for @aws-sdk/client-s3. Only GetObject is used by the share handler.
import { stubState } from './state.js';

export class GetObjectCommand {
  constructor(input) { this.input = input; }
}
export class S3Client {
  constructor(cfg) { this.cfg = cfg; }
  async send(cmd) {
    stubState.s3Calls.push(cmd?.input);
    if (stubState.s3Bytes == null) throw new Error('stub: s3Bytes not configured');
    return { Body: { transformToByteArray: async () => stubState.s3Bytes } };
  }
}
