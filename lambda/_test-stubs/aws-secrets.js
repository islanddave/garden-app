// Stub for @aws-sdk/client-secrets-manager. Mirrors the command/send shape the handlers use.
import { stubState } from './state.js';

export class GetSecretValueCommand {
  constructor(input) { this.input = input; }
}
export class SecretsManagerClient {
  constructor(cfg) { this.cfg = cfg; }
  async send(cmd) {
    const id = cmd?.input?.SecretId;
    const found = stubState.secrets[id];
    if (found === undefined) {
      const e = new Error(`stub: no secret configured for ${id}`);
      e.name = 'ResourceNotFoundException';
      throw e;
    }
    return { SecretString: JSON.stringify(found) };
  }
}
