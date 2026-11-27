import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computePaymentIdV2 } from '@atum-labs/evm-escrow-encoding';
import { computePaymentId as computeTronPaymentId } from '@atum-labs/tvm-escrow-encoding';
import { computeDepositHashV2, newEscrowDomain, Pubkey } from '@atum-labs/solana-escrow-encoding';
import { verifyPaymentRequestJSON, verifyReserveAuth } from './index.js';
import type { ReserveAuth, ReserveAuthExpectations, ReserveAuthReason } from './index.js';
import { fakeChecker } from './test-helpers.js';

// Awards the SDK built (award-sdk-vectors.json, see its _comment). Mirrors the Go
// award_sdk_vectors_test.go.
interface AwardVector {
  name: string;
  route: 'depositor' | 'selector' | 'contract-selector';
  defaults: { svm_signature_cluster_id?: string; svm_signature_domain_version?: number };
  quoteRequest: {
    source: { account: string };
    escrow_contract_address: string;
    fulfillment_verifier: { account: string };
  };
  quote: { fulfillment_quote: { source_amount: string } };
  award: {
    sender_auth: {
      signed_messages: { message: string; message_prehash?: string; signature: string }[];
    };
    reserve_auth: ReserveAuth;
  };
  paymentId: string;
  reserve: { expected: ReserveAuthExpectations; message: string; message_prehash?: string };
  tampered: { field: string; reserve_auth: ReserveAuth; reason: ReserveAuthReason }[];
}

const ERC1271_MAGIC = '0x1626ba7e' + '0'.repeat(56);
// The clock the fixture was built at (2026-06-01T00:00:00Z).
const AWARD_SDK_CLOCK = 1780272000;

// The escrow's deposit hash for a Solana award's signed record, under the signature domain the
// reserve names.
function solanaDepositHash(prehashJson: string, expected: ReserveAuthExpectations): string {
  const p = JSON.parse(prehashJson) as Record<string, string>;
  const hash = computeDepositHashV2(
    {
      depositRequestHash: Buffer.from(p.deposit_request_hash.replace(/^0x/, ''), 'hex'),
      depositor: Pubkey.fromBase58(p.depositor),
      mint: Pubkey.fromBase58(p.mint),
      amount: BigInt(p.amount),
      reserver: Pubkey.fromBase58(p.reserver),
      releaser: Pubkey.fromBase58(p.releaser),
      nonce: BigInt(p.nonce),
      issuedAt: BigInt(p.issued_at),
      deadline: BigInt(p.deadline),
    },
    p.destination,
    newEscrowDomain(
      expected.svmSignatureClusterId!,
      expected.svmSignatureDomainVersion!,
      Pubkey.fromBase58(expected.escrowContract),
    ),
  );
  return '0x' + Buffer.from(hash).toString('hex');
}

const vectors = (
  JSON.parse(
    readFileSync(resolve(__dirname, '../../../../conformance/award-sdk-vectors.json'), 'utf8'),
  ) as { vectors: AwardVector[] }
).vectors;

// The reserver's chain: no code for an EOA, the ERC-1271 magic value for the contract reserver.
const checkerFor = (v: AwardVector) =>
  fakeChecker(
    v.route === 'contract-selector'
      ? { code: '0x01', isValidSignature: { returnData: ERC1271_MAGIC } }
      : {},
  );

describe('award SDK vectors', () => {
  it('carries rows', () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const v of vectors) {
    it(`${v.name}: the reserve verifies`, async () => {
      const auth = v.award.reserve_auth;
      expect(auth.message).toBe(v.reserve.message);
      expect(auth.message_prehash).toBe(v.reserve.message_prehash);
      expect(v.reserve.expected.depositId).toBe(v.paymentId);

      const checker = checkerFor(v);
      const got = await verifyReserveAuth(auth, v.reserve.expected, checker);
      expect(got.reason).toBe('verified');
      if (v.route !== 'contract-selector') {
        expect(got.path).toBe('eoa');
        return;
      }
      expect(got.path).toBe('contract');
      // The wallet is asked about the digest the SDK signed, by the escrow.
      const asked = checker.calls.filter((c) => c.method === 'isValidSignatureFrom');
      expect(asked).toHaveLength(1);
      expect(asked[0].digest).toBe(v.reserve.message.toLowerCase());
      expect(asked[0].signature).toBe(auth.signature.toLowerCase());
      expect(asked[0].account.toLowerCase()).toBe(v.reserve.expected.reserver.toLowerCase());
      expect(asked[0].caller?.toLowerCase()).toBe(v.reserve.expected.escrowContract.toLowerCase());
    });

    it(`${v.name}: each tampered reserve is refused`, async () => {
      expect(v.tampered.map((t) => t.field)).toEqual(['settler', 'sourceAmount']);
      for (const tampered of v.tampered) {
        const got = await verifyReserveAuth(
          tampered.reserve_auth,
          v.reserve.expected,
          checkerFor(v),
        );
        expect(got.valid).toBe(false);
        expect(got.reason).toBe(tampered.reason);
      }
    });

    // As a gateway verifies it: for the quote's amount, with the reserve's signer as reserver and
    // the fulfillment verifier as releaser, so a deposit whose roles do not match is refused.
    it(`${v.name}: the sender_auth verifies`, () => {
      const got = verifyPaymentRequestJSON(
        JSON.stringify({ ...v.quoteRequest, sender_auth: v.award.sender_auth }),
        {
          quoteSourceAmount: v.quote.fulfillment_quote.source_amount,
          escrowContract: v.quoteRequest.escrow_contract_address,
          reserver: v.reserve.expected.reserver,
          releaser: v.quoteRequest.fulfillment_verifier.account,
          svmSignatureClusterId: v.defaults.svm_signature_cluster_id,
          svmSignatureDomainVersion: v.defaults.svm_signature_domain_version,
          nowSec: AWARD_SDK_CLOCK,
          depositRequestHashV2Mode: 'enforce',
        },
      );
      expect(got.recoveredAccount).toBe(v.quoteRequest.source.account);
    });

    // The deposit id the reserve binds is the escrow's id for the deposit the award signs.
    it(`${v.name}: the payment id is the deposit id`, () => {
      const [deposit] = v.award.sender_auth.signed_messages;
      const namespace = v.reserve.expected.network.split(':')[0];
      if (namespace === 'solana') {
        expect(deposit.message.toLowerCase()).toBe(v.paymentId);
        expect(solanaDepositHash(deposit.message_prehash!, v.reserve.expected)).toBe(v.paymentId);
        return;
      }
      const nonce = (JSON.parse(deposit.message_prehash!) as { message: { nonce: string } }).message
        .nonce;
      const depositor = v.quoteRequest.source.account;
      const id =
        namespace === 'tron'
          ? computeTronPaymentId(depositor, deposit.signature, nonce)
          : computePaymentIdV2(depositor, deposit.signature, nonce);
      expect(id).toBe(v.paymentId);
    });
  }
});
