// Stub for @aws-sdk/cloudfront-signer — see ./state.js for why stubs rather than mocks.
//
// photo-access.js reaches this specifier through a DYNAMIC `await import()` inside signCdnOriginalUrl,
// deliberately, so that nothing loads on the presign path. That does not spare the test run: vite's
// import-analysis resolves dynamic specifiers at TRANSFORM time, so an unaliased one fails the whole
// file to collect ("Failed to resolve import") before a single test starts — which is what kept
// lambda/inventory-items/index.js unimportable even after the other five aliases landed.
import { stubState } from './state.js';

export function getSignedUrl(options) {
  stubState.cdnSigns.push(options);
  return `https://cdn.stub.invalid${new URL(options?.url ?? 'https://x/').pathname}?stub-signed=1`;
}
