import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readDepositRequest } from './deposit-request-v2.js';

// Mirrors TestDepositRequestHashV2IgnoresTheDepositNonce in
// bindings/go/sender-auth/senderauth/deposit_nonce_test.go. The settler-deposit refusal and the
// quote binding reach this suite through the shared v2 and commitment vectors.
const VECTORS_PATH = resolve(
  __dirname,
  '../../../../conformance/deposit-request-hash-v2-vectors.json',
);
const golden = (JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as { golden: { request: string }[] })
  .golden;

/**
 * The first shared golden request rewritten as an originator-executed deposit, with the nonce
 * member set when `nonce` is given.
 */
function directDepositRequest(nonce?: string): string {
  const doc = JSON.parse(golden[0].request) as Record<string, unknown>;
  doc.executor = { deposit: 'originator', reserve: 'settler', fulfill: 'originator' };
  delete doc.sender_auth;
  if (nonce !== undefined) doc.deposit_nonce = nonce;
  return JSON.stringify(doc);
}

describe('deposit_nonce', () => {
  it('is not committed by v2: the deposit id binds it', () => {
    const without = readDepositRequest(directDepositRequest());
    const withNonce = readDepositRequest(directDepositRequest('7'));
    expect(withNonce.depositRequestHashV2).toBe(without.depositRequestHashV2);
  });
});
