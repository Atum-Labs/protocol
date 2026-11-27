import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Signature, Wallet } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { PaymentRequest } from '@atum-labs/schema-declarations/PaymentRequest/v1/bindings/typescript';
import { evmAdapter } from './adapters/evm.js';
import { solanaAdapter } from './adapters/solana.js';
import { CommitmentError, commitmentResultOf } from './commitment-rules.js';
import type { CommitmentOutcome } from './commitment-rules.js';
import { verifyPaymentRequest, verifyPaymentRequestJSON } from './verify.js';
import { PermitAmountMismatchError } from './errors.js';
import type { ChainDefaults } from './types.js';

const defaults: ChainDefaults = {
  escrowContract: '0x1111111111111111111111111111111111111111',
  quoteSelector: '0x2222222222222222222222222222222222222222',
  fulfillmentVerifierAccount: '0x3333333333333333333333333333333333333333',
  fulfillmentVerifierEndpoint: 'https://verifier.example',
  fulfillmentProxy: '0x4444444444444444444444444444444444444444',
};
const TOKEN = '0x5555555555555555555555555555555555555555';
// verifyPaymentRequest takes the scheme expectations (maxSourceAmount comes from the request).
const expected = {
  escrowContract: defaults.escrowContract,
  reserver: defaults.quoteSelector,
  releaser: defaults.fulfillmentVerifierAccount,
};

async function makeRequest(): Promise<PaymentRequest> {
  const wallet = Wallet.createRandom();
  const built = await evmAdapter.buildAuthMessage({
    sourceAsset: `eip155:1/erc20:${TOKEN}`,
    depositor: wallet.address,
    maxSourceAmount: '1000000',
    requestId: 'req_test',
    destinationAsset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    destinationAccount: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
    sourceDefaults: defaults,
    nonce: 123n,
    deadline: 1924991999n,
  });
  const signed = {
    message: built.messageHash,
    message_prehash: built.messagePrehash,
    signature: '',
  };
  signed.signature = await evmAdapter.sign(signed, wallet.privateKey);
  return {
    source: { asset_identifier: `eip155:1/erc20:${TOKEN}`, account: wallet.address },
    destination: [
      {
        asset_identifier: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        account: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
      },
    ],
    request_id: 'req_test',
    max_source_amount: '1000000',
    quote_deadline: new Date(Date.now() + 60_000).toISOString(),
    fulfillment_deadline: new Date(Date.now() + 120_000).toISOString(),
    sender_auth: { message_scheme: 'EVM_PERMIT2', signed_messages: [signed] },
  } as unknown as PaymentRequest;
}

describe('verifyPaymentRequest', () => {
  it('refuses a request with no destination as destination_mismatch, as Go does', async () => {
    const pr = await makeRequest();
    delete (pr as { destination?: unknown }).destination;
    expect(outcomeOf(() => verifyPaymentRequest(pr, expected))).toBe('destination_mismatch');
  });

  it('refuses a request whose payee was rewritten after signing', async () => {
    const pr = await makeRequest();
    pr.destination[0]!.account = '0x1111111111111111111111111111111111111111';
    expect(() => verifyPaymentRequest(pr, expected)).toThrow(
      /the payer signed a deposit payable to/,
    );
  });

  it('recovers each signer, binds the universal terms, and returns the parsed permits', async () => {
    const pr = await makeRequest();
    const result = verifyPaymentRequest(pr, expected);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.amount).toBe('1000000');
    expect(result.results[0]!.permit.spender).toBe(defaults.escrowContract);
    expect(result.recoveredAccount).toBe(pr.source.account);
  });

  it("rejects when the permit amount does not match the request's max_source_amount", async () => {
    const pr = await makeRequest();
    (pr as unknown as { max_source_amount: string }).max_source_amount = '999';
    expect(() => verifyPaymentRequest(pr, expected)).toThrow(
      /permit amount does not match max_source_amount/,
    );
  });

  it("binds against a caller-supplied maxSourceAmount over the request's own field", async () => {
    const pr = await makeRequest();
    // Request self-reports 1000000 (would pass), but the caller's agreed amount is 999 — a
    // consumer that did not author the request pins its own term and the mismatch is caught.
    expect(() => verifyPaymentRequest(pr, { ...expected, maxSourceAmount: '999' })).toThrow(
      /permit amount does not match max_source_amount/,
    );
  });

  it("binds a quote source amount and ignores the request's max_source_amount", async () => {
    const pr = await makeRequest();
    (pr as unknown as { max_source_amount: string }).max_source_amount = '5000000';
    const result = verifyPaymentRequestJSON(JSON.stringify(pr), {
      ...expected,
      quoteSourceAmount: '1000000',
    });
    expect(result.results[0]!.amount).toBe('1000000');
    expect(() =>
      verifyPaymentRequestJSON(JSON.stringify(pr), { ...expected, quoteSourceAmount: '999999' }),
    ).toThrow(PermitAmountMismatchError);
  });

  it("binds against a caller-supplied sourceAsset over the request's own asset", async () => {
    const pr = await makeRequest();
    expect(() =>
      verifyPaymentRequest(pr, {
        ...expected,
        sourceAsset: '0x6666666666666666666666666666666666666666',
      }),
    ).toThrow(/permit token does not match the source asset/);
  });

  it('refuses a request that carries two spellings of one member', async () => {
    const pr = await makeRequest();
    (pr as unknown as Record<string, unknown>).Destination = [
      { ...pr.destination[0]!, account: '0x1111111111111111111111111111111111111111' },
    ];
    expect(outcomeOf(() => verifyPaymentRequest(pr, expected))).toBe('request_malformed');
  });

  it('refuses a destination whose account is not a string', async () => {
    const pr = await makeRequest();
    (pr.destination[0] as unknown as { account: unknown }).account = [pr.destination[0]!.account];
    expect(outcomeOf(() => verifyPaymentRequest(pr, expected))).toBe('request_malformed');
  });

  it('refuses a malformed source asset_identifier as scheme_mismatch', async () => {
    const pr = await makeRequest();
    (pr as unknown as { source: { asset_identifier: string } }).source.asset_identifier =
      'not-a-caip-asset';
    expect(outcomeOf(() => verifyPaymentRequest(pr, expected))).toBe('scheme_mismatch');
  });

  // The commitment check runs before recovery, so its outcome is reported even when a later check
  // would also fail.
  it('checks the commitment first', async () => {
    const pr = await makeRequest();
    (pr as unknown as { max_source_amount: string }).max_source_amount = '999';
    pr.request_id = 'req_other';
    expect(outcomeOf(() => verifyPaymentRequest(pr, expected))).toBe('request_hash_mismatch');

    const noPayee = await makeRequest();
    (noPayee as unknown as { destination: unknown[] }).destination = [];
    expect(outcomeOf(() => verifyPaymentRequest(noPayee, expected))).toBe('destination_mismatch');

    const noScheme = await makeRequest();
    delete (noScheme.sender_auth as { message_scheme?: string }).message_scheme;
    expect(outcomeOf(() => verifyPaymentRequest(noScheme, expected))).toBe('scheme_mismatch');

    const wrongScheme = await makeRequest();
    (wrongScheme.sender_auth as { message_scheme: string }).message_scheme = 'SOLANA';
    expect(outcomeOf(() => verifyPaymentRequest(wrongScheme, expected))).toBe('scheme_mismatch');
  });
});

function outcomeOf(run: () => unknown): CommitmentOutcome {
  try {
    run();
  } catch (e) {
    if (e instanceof CommitmentError) return e.result.outcome;
    throw e;
  }
  throw new Error('expected a CommitmentError');
}

describe('verifyPaymentRequest on Solana', () => {
  const b58 = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));
  const solanaDefaults: ChainDefaults = {
    escrowContract: b58(1),
    quoteSelector: b58(2),
    fulfillmentVerifierAccount: b58(3),
    fulfillmentVerifierEndpoint: 'https://verifier.example',
    fulfillmentProxy: b58(4),
    svmSignatureClusterId: 'devnet',
    svmSignatureDomainVersion: 5,
  };
  const solanaExpected = {
    escrowContract: solanaDefaults.escrowContract,
    reserver: solanaDefaults.quoteSelector,
    releaser: solanaDefaults.fulfillmentVerifierAccount,
    svmSignatureClusterId: 'devnet',
    svmSignatureDomainVersion: 5,
  };
  const payee = {
    asset_identifier:
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo',
    account: '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4',
  };

  async function makeSolanaRequest(): Promise<PaymentRequest> {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4));
    const payer = bs58.encode(keys.publicKey);
    const built = await solanaAdapter.buildAuthMessage({
      sourceAsset: `solana:mainnet/token:${b58(9)}`,
      depositor: payer,
      maxSourceAmount: '1000000',
      requestId: 'req_sol',
      destinationAsset: payee.asset_identifier,
      destinationAccount: payee.account,
      sourceDefaults: solanaDefaults,
      nonce: 5n,
      solanaClockReader: async () => 1700000000n,
    });
    const signed = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
      payload: { delegate_signer: payer },
    };
    signed.signature = await solanaAdapter.sign(signed, bs58.encode(keys.secretKey));
    return {
      source: { asset_identifier: `solana:mainnet/token:${b58(9)}`, account: payer },
      destination: [{ ...payee }],
      request_id: 'req_sol',
      max_source_amount: '1000000',
      sender_auth: { message_scheme: 'SOLANA', signed_messages: [signed] },
    } as unknown as PaymentRequest;
  }

  it("admits the payment's own payee and refuses a rewritten one", async () => {
    const pr = await makeSolanaRequest();
    expect(verifyPaymentRequest(pr, solanaExpected).results[0]!.amount).toBe('1000000');

    pr.destination[0]!.account = b58(7);
    expect(outcomeOf(() => verifyPaymentRequest(pr, solanaExpected))).toBe('destination_mismatch');
  });

  it("needs the escrow domain from the verifier's configuration", async () => {
    const pr = await makeSolanaRequest();
    const { svmSignatureDomainVersion: _omitted, ...withoutDomain } = solanaExpected;
    expect(outcomeOf(() => verifyPaymentRequest(pr, withoutDomain))).toBe('verifier_misconfigured');
  });
});

// The request as received: two spellings of one member are refused before parsing, and the honest
// request verifies. Mirrors TestVerifyPaymentRequestJSONRefusesCaseTwinMembers.
describe('verifyPaymentRequestJSON', () => {
  it('verifies the honest request and refuses a twin member name', async () => {
    const pr = await makeRequest();
    const honest = JSON.stringify(pr);
    expect(verifyPaymentRequestJSON(honest, expected).results[0]!.amount).toBe('1000000');
    expect(
      verifyPaymentRequestJSON(new TextEncoder().encode(honest), expected).results[0]!.amount,
    ).toBe('1000000');

    const twin = honest.replace(
      '"destination":',
      `"destination":[{"asset_identifier":"${pr.destination[0]!.asset_identifier}","account":"0x1111111111111111111111111111111111111111"}],"Destination":`,
    );
    expect(outcomeOf(() => verifyPaymentRequestJSON(twin, expected))).toBe('request_malformed');
  });
});

// Shared vectors for the JSON entry point, asserted by the Go suite too. Regenerate with
// REGEN_VERIFY_JSON_VECTORS=1.
const VERIFY_JSON_VECTORS = resolve(__dirname, '../../../../conformance/verify-json-vectors.json');

interface VerifyJSONVector {
  name: string;
  request: string;
  expected: Record<string, unknown>;
  expect: { amount?: string; outcome?: CommitmentOutcome; errorContains?: string };
}

async function generateVerifyJSONVectors(): Promise<VerifyJSONVector[]> {
  const wallet = new Wallet('0x' + '22'.repeat(32));
  const built = await evmAdapter.buildAuthMessage({
    sourceAsset: `eip155:1/erc20:${TOKEN}`,
    depositor: wallet.address,
    maxSourceAmount: '1000000',
    requestId: 'req_json',
    destinationAsset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    destinationAccount: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
    sourceDefaults: defaults,
    nonce: 7n,
    deadline: 1924991999n,
  });
  const signed = {
    message: built.messageHash,
    message_prehash: built.messagePrehash,
    signature: '',
  };
  signed.signature = await evmAdapter.sign(signed, wallet.privateKey);
  const request = {
    source: { asset_identifier: `eip155:1/erc20:${TOKEN}`, account: wallet.address },
    destination: [
      {
        asset_identifier: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        account: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
      },
    ],
    request_id: 'req_json',
    max_source_amount: '1000000',
    sender_auth: { message_scheme: 'EVM_PERMIT2', signed_messages: [signed] },
  };
  const honest = JSON.stringify(request);
  const exp = { ...expected, nowSec: 1700000000 };
  const attacker = '0x1111111111111111111111111111111111111111';
  return [
    // The schema fields the verifier does not read (version, amounts, deadlines) are the caller's.
    {
      name: 'honest-without-unverified-fields',
      request: honest,
      expected: exp,
      expect: { amount: '1000000' },
    },
    {
      name: 'payee-rewritten',
      request: honest.replace('0xC0FFEE254729296a45a3885639AC7E10F9d54979', attacker),
      expected: exp,
      expect: { outcome: 'destination_mismatch' },
    },
    {
      name: 'destination-case-twin',
      request: honest.replace(
        '"destination":',
        `"destination":[{"asset_identifier":"${request.destination[0]!.asset_identifier}","account":"${attacker}"}],"Destination":`,
      ),
      expected: exp,
      expect: { outcome: 'request_malformed' },
    },
    {
      name: 'request-id-twice',
      request: honest.replace('"request_id":', '"request_id":"req_other","request_id":'),
      expected: exp,
      expect: { outcome: 'request_malformed' },
    },
    {
      // Read by exact name: a wrongly cased amount is absent, so the permit binds against "0".
      name: 'max-source-amount-wrong-case',
      request: honest.replace('"max_source_amount":', '"MAX_SOURCE_AMOUNT":'),
      expected: exp,
      expect: { errorContains: 'permit amount does not match max_source_amount' },
    },
    {
      // Every signed message is read by exact name: a wrongly cased signature is absent.
      name: 'second-message-wrong-case',
      request: honest.replace(
        /"signed_messages":\[(\{.*\})\]/,
        (_m, first: string) =>
          `"signed_messages":[${first},${first.replace('"signature":', '"Signature":')}]`,
      ),
      expected: exp,
      expect: { outcome: 'signer_mismatch' },
    },
    ...['0xf4240', ' 1000000', '', '01000000', '+1000000'].map((spelled) => ({
      name: `max-source-amount-spelled-${JSON.stringify(spelled)}`,
      request: honest.replace(
        '"max_source_amount":"1000000"',
        `"max_source_amount":${JSON.stringify(spelled)}`,
      ),
      expected: exp,
      expect: { errorContains: 'max_source_amount is not a decimal integer string' },
    })),
    {
      // An empty override is unset: the request's own amount is bound.
      name: 'empty-amount-override-is-unset',
      request: honest,
      expected: { ...exp, maxSourceAmount: '' },
      expect: { amount: '1000000' },
    },
    {
      // The JSON entry point recovers every signer off chain, so a contract account is refused here;
      // the payee check alone (verifyRequestCommitment) admits it.
      name: 'contract-account-payer',
      request: honest.replace(wallet.address, '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe'),
      expected: exp,
      expect: { outcome: 'signer_mismatch' },
    },
    {
      name: 'compact-signature',
      request: honest.replace(signed.signature, Signature.from(signed.signature).compactSerialized),
      expected: exp,
      expect: { outcome: 'signer_mismatch' },
    },
    {
      name: 'max-source-amount-not-string',
      request: honest.replace('"max_source_amount":"1000000"', '"max_source_amount":1000000'),
      expected: exp,
      expect: { errorContains: 'max_source_amount is not a string' },
    },
  ];
}

if (process.env.REGEN_VERIFY_JSON_VECTORS === '1') {
  describe('verifyPaymentRequestJSON vectors — REGEN', () => {
    it('writes verify-json-vectors.json', async () => {
      const vectors = await generateVerifyJSONVectors();
      writeFileSync(
        VERIFY_JSON_VECTORS,
        JSON.stringify(
          {
            _comment:
              'Shared vectors for VerifyPaymentRequestJSON / verifyPaymentRequestJSON. Regenerate: REGEN_VERIFY_JSON_VECTORS=1 pnpm --filter @atum-labs/payment-request-sender-auth exec vitest run src/verify.test.ts',
            vectors,
          },
          null,
          2,
        ) + '\n',
      );
    });
  });
} else {
  describe('verifyPaymentRequestJSON vectors — frozen', () => {
    const { vectors } = JSON.parse(readFileSync(VERIFY_JSON_VECTORS, 'utf8')) as {
      vectors: VerifyJSONVector[];
    };
    it('has every case', () => expect(vectors).toHaveLength(15));
    for (const v of vectors) {
      it(v.name, () => {
        const run = () => verifyPaymentRequestJSON(v.request, v.expected);
        if (v.expect.amount !== undefined) {
          expect(run().results[0]!.amount).toBe(v.expect.amount);
          return;
        }
        let thrown: unknown;
        try {
          run();
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(Error);
        if (v.expect.outcome !== undefined) {
          expect(commitmentResultOf(thrown)?.outcome).toBe(v.expect.outcome);
        } else {
          expect(commitmentResultOf(thrown)).toBeUndefined();
          expect((thrown as Error).message).toContain(v.expect.errorContains);
        }
      });
    }
  });
}
