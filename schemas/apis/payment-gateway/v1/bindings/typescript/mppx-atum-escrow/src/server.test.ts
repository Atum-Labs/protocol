import { describe, it, expect } from 'vitest';
import { hashPermitWitnessTransferFrom } from '@atum-labs/evm-escrow-encoding';
import { ApiError } from '@atum-labs/payment-gateway-client';
import { deriveDepositRequestHash } from '@atum-labs/payment-request-sender-auth';
import { Errors } from 'mppx';
import {
  registerServer,
  buildChargeChallenge,
  buildChargeRequest,
  validateCorridor,
  corridorFromDefaults,
  gatewayRefusalOf,
  PaymentRejectedError,
  isPaymentRejected,
  isPaymentRetryable,
  isSettlementFailed,
  isSettlementPending,
  type PaymentRetryableError,
  type PaymentSubmitResult,
  type SettlementFailedError,
  type SettlementPendingError,
  type SettleAt,
} from './server.js';
import {
  sameAddress,
  ChargeRequestSchema,
  chargeRequestId,
  INTENT_ID_META_KEY,
} from './internal.js';
import type { AtumEscrowReceipt } from './index.js';
import {
  PAYER,
  NOW,
  now,
  corridor,
  EVM_SOURCE,
  request,
  INTENT_ID,
  okSubmitter,
  COMPLETED,
  buildCredential,
  buildTronCredential,
  wallet,
  tronCorridor,
  tronRequest,
  buildSolanaCredential,
  solanaCorridor,
  solanaRequest,
  b58,
  challenge,
  tronChallenge,
  solanaChallenge,
  buildContractAccountCredential,
  SAFE_PAYER,
} from './test-helpers.js';
import type { TestCredential } from './test-helpers.js';

describe('sameAddress (base58 soundness)', () => {
  it('compares EVM hex case-insensitively (EIP-55 is a case-only checksum)', () => {
    expect(
      sameAddress(
        '0xAbC0000000000000000000000000000000000001',
        '0xabc0000000000000000000000000000000000001',
      ),
    ).toBe(true);
  });

  it('compares base58 exactly — a case variant is NOT the same address', () => {
    // A real Solana mint (USDC). Lowercasing it passes a case-insensitive compare but
    // decodes to different bytes, so equality must be exact for base58.
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    expect(sameAddress(mint, mint)).toBe(true);
    expect(sameAddress(mint, mint.toLowerCase())).toBe(false);
  });

  it('does not treat a hex and non-0x form as equal', () => {
    expect(sameAddress('0x41abc', '41abc')).toBe(false);
  });
});

describe('buildChargeRequest', () => {
  it('derives the source cap from fulfillmentAmount + markup', () => {
    expect(request.source.amount).toBe('10300000'); // 10000000 * (1 + 300/10000)
    expect(request.source.asset).toBe(corridor.sources[0]!.assets[0]!.address);
    expect(request.extra.escrow).toBe(corridor.sources[0]!.escrow);
    expect(request.extra.reserver).toBe(corridor.sources[0]!.reserver);
    expect(request.extra.releaser).toBe(corridor.sources[0]!.releaser);
    expect(request.extra.fulfillmentProxy).toBe(corridor.fulfillmentProxy);
    expect(request.extra.fulfillmentAmount).toBe('10000000');
  });

  it('prices each charge independently of the registration', () => {
    const cheap = buildChargeRequest(corridor, EVM_SOURCE, '1000000');
    expect(cheap.extra.fulfillmentAmount).toBe('1000000');
    expect(cheap.source.amount).toBe('1030000');
  });

  it('throws for an unconfigured source option', () => {
    expect(() =>
      buildChargeRequest(
        corridor,
        { network: 'eip155:99999', asset: EVM_SOURCE.asset },
        '10000000',
      ),
    ).toThrow(/no source option/);
  });
});

describe('buildChargeRequest (multiple assets on one source)', () => {
  // Two tokens on the same chain: a single source with several `assets`, sharing the
  // escrow/role/verifier fields.
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
  const multi: typeof corridor = {
    ...corridor,
    sources: [
      {
        ...corridor.sources[0]!,
        assets: [
          { address: USDC, symbol: 'USDC', decimals: 6 },
          { address: USDT, symbol: 'USDT', decimals: 6 },
        ],
      },
    ],
  };

  it('validateCorridor accepts a source listing several assets', () => {
    expect(() => validateCorridor(multi)).not.toThrow();
  });

  it('selects the requested token among several on one chain', () => {
    const first = buildChargeRequest(multi, { network: 'eip155:8453', asset: USDC }, '10000000');
    const second = buildChargeRequest(multi, { network: 'eip155:8453', asset: USDT }, '10000000');
    expect(first.source.asset).toBe(USDC);
    expect(second.source.asset).toBe(USDT);
  });

  it("throws for a token not in the source's asset list", () => {
    expect(() =>
      buildChargeRequest(
        multi,
        { network: 'eip155:8453', asset: '0x0000000000000000000000000000000000000abc' },
        '10000000',
      ),
    ).toThrow(/no source option/);
  });

  it("matches an EVM token case-insensitively but emits the merchant's stored casing", () => {
    const r = buildChargeRequest(
      multi,
      { network: 'eip155:8453', asset: USDT.toLowerCase() },
      '10000000',
    );
    // Selected by case-insensitive EVM match, but the wire challenge carries the
    // merchant's canonical (checksummed) form, not the payer's lowercased query.
    expect(r.source.asset).toBe(USDT);
  });

  it('selects a Solana token case-sensitively — a base58 case variant does not match', () => {
    const mint = solanaCorridor.sources[0]!.assets[0]!.address;
    expect(() =>
      buildChargeRequest(
        solanaCorridor,
        { network: solanaCorridor.sources[0]!.network, asset: mint.toLowerCase() },
        '10000000',
      ),
    ).toThrow(/no source option/);
  });
});

describe('buildChargeRequest (issuedAt, Solana)', () => {
  const solSelect = {
    network: solanaCorridor.sources[0]!.network,
    asset: solanaCorridor.sources[0]!.assets[0]!.address,
  };
  it('stamps a merchant-provided issuedAt into extra for a Solana source', () => {
    const r = buildChargeRequest(solanaCorridor, solSelect, '10000000', { issuedAt: '1700000000' });
    expect(r.extra.issuedAt).toBe('1700000000');
  });
  it('omits issuedAt when none is provided', () => {
    const r = buildChargeRequest(solanaCorridor, solSelect, '10000000');
    expect(r.extra.issuedAt).toBeUndefined();
  });
  it('ignores issuedAt for a non-Solana (EVM) source', () => {
    const r = buildChargeRequest(corridor, EVM_SOURCE, '10000000', { issuedAt: '1700000000' });
    expect(r.extra.issuedAt).toBeUndefined();
  });
  it('rejects a non-numeric issuedAt for a Solana source', () => {
    expect(() =>
      buildChargeRequest(solanaCorridor, solSelect, '10000000', { issuedAt: 'not-a-number' }),
    ).toThrow(/issuedAt must be epoch seconds/);
  });
});

describe('ChargeRequestSchema (wire validation)', () => {
  // The framework validates an incoming challenge.request against this schema before the
  // client reads it, so a malformed wire issuedAt is rejected here — never reaching BigInt().
  it('rejects a non-numeric issuedAt received on the wire', () => {
    const bad = { ...solanaRequest, extra: { ...solanaRequest.extra, issuedAt: 'abc' } };
    expect(ChargeRequestSchema.safeParse(bad).success).toBe(false);
  });
  it('accepts a valid epoch-seconds issuedAt', () => {
    const ok = { ...solanaRequest, extra: { ...solanaRequest.extra, issuedAt: '1700000000' } };
    expect(ChargeRequestSchema.safeParse(ok).success).toBe(true);
  });
});

describe('validateCorridor', () => {
  it('rejects out-of-order deadline budgets', () => {
    expect(() =>
      validateCorridor({ ...corridor, quoteDeadlineSeconds: 300, fulfillmentDeadlineSeconds: 20 }),
    ).toThrow(/strictly less than/);
  });
  it('rejects a negative markup', () => {
    expect(() => validateCorridor({ ...corridor, markupBps: -1 })).toThrow(/markupBps/);
  });
  it('rejects an empty sources list', () => {
    expect(() => validateCorridor({ ...corridor, sources: [] })).toThrow(/at least one source/);
  });
  it('rejects a Solana source missing its domain fields', () => {
    expect(() =>
      validateCorridor({
        ...corridor,
        sources: [{ ...corridor.sources[0]!, network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }],
      }),
    ).toThrow(/svmSignatureClusterId/);
  });

  it('rejects a Tron source on an unmapped network (fails at startup)', () => {
    // The Permit2 verifying contract is fixed per-network (not carried on the wire), so a
    // network absent from the known map fails loudly at corridor validation, not at pay time.
    expect(() =>
      validateCorridor({
        ...corridor,
        sources: [{ ...corridor.sources[0]!, network: 'tron:nile' }],
      }),
    ).toThrow(/no Permit2 address known/);
  });

  it('rejects a Solana source when the fulfillment budget exceeds the replay window', () => {
    // corridor.fulfillmentDeadlineSeconds is 300 — fine for EVM, too long for Solana.
    expect(() =>
      validateCorridor({
        ...corridor,
        sources: [
          {
            ...corridor.sources[0]!,
            network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
            svmSignatureClusterId: 'mainnet',
            svmSignatureDomainVersion: 5,
          },
        ],
      }),
    ).toThrow(/replay window/);
  });
});

describe('corridorFromDefaults', () => {
  it('assembles a corridor from gateway /defaults', async () => {
    const defaults = {
      fetchChainDefaults: async (chainId: string) => ({
        escrowContract: `escrow-${chainId}`,
        quoteSelector: `reserver-${chainId}`,
        fulfillmentVerifierAccount: `releaser-${chainId}`,
        fulfillmentVerifierEndpoint: `https://verifier/${chainId}`,
        fulfillmentProxy: `proxy-${chainId}`,
      }),
    };
    const built = await corridorFromDefaults(defaults, {
      destination: corridor.destination,
      sources: [
        {
          network: EVM_SOURCE.network,
          assets: [{ address: EVM_SOURCE.asset, symbol: 'USDC', decimals: 6 }],
        },
      ],
      markupBps: 300,
      quoteDeadlineSeconds: 20,
      fulfillmentDeadlineSeconds: 300,
    });
    expect(built.fulfillmentProxy).toBe('proxy-eip155:42161');
    expect(built.sources[0]!.escrow).toBe('escrow-eip155:8453');
    expect(built.sources[0]!.reserver).toBe('reserver-eip155:8453');
    expect(built.sources[0]!.releaser).toBe('releaser-eip155:8453');
  });
});

describe('verify (EVM)', () => {
  it('verifies a valid credential and maps the receipt', async () => {
    const cred = await buildCredential();
    const server = registerServer({ submitter: okSubmitter, now });
    const receipt = await server.verify({ credential: cred as any, request });
    expect(receipt.status).toBe('success');
    expect(receipt.method).toBe('atum-escrow');
    expect(receipt.reference).toBe('0xdestination');
    expect(receipt.paymentId).toBe('pay_1');
    expect(receipt.state).toBe('completed');
    expect(receipt.destinationChainId).toBe('eip155:42161');
  });

  it('resolves with the settlement details typed, without an assertion', async () => {
    const cred = await buildCredential();
    const server = registerServer({ submitter: okSubmitter, now });
    // Also a compile-time check: the annotations below hold only if `verify` is declared to
    // resolve with the Atum receipt.
    const receipt: AtumEscrowReceipt = await server.verify({ credential: cred as any, request });
    const payout: string = receipt.reference;
    const chain: string = receipt.destinationChainId;
    expect([payout, chain]).toEqual(['0xdestination', 'eip155:42161']);
  });

  it('throws when the destination is tampered', async () => {
    const cred = await buildCredential();
    cred.payload.paymentRequest.destination[0].account =
      '0x000000000000000000000000000000000000dEaD';
    const server = registerServer({ submitter: okSubmitter, now });
    await expect(server.verify({ credential: cred as any, request })).rejects.toThrow(
      /destination account/,
    );
  });

  // A contract account (ERC-1271, such as a Safe) signs with an owner key, which never recovers to
  // the payer: the client will not sign for one, and the server recovers the signer off chain.
  it('does not take a contract-account payer at either end', async () => {
    await expect(buildContractAccountCredential()).rejects.toThrow(
      /does not match the sender address 0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe/,
    );
    const cred = await buildCredential();
    cred.payload.paymentRequest.source.account = SAFE_PAYER;
    const server = registerServer({ submitter: okSubmitter, now });
    await expect(server.verify({ credential: cred as any, request })).rejects.toThrow(
      /does not recover to the payment's source account/,
    );
  });

  it('throws when the signature does not recover to source.account', async () => {
    const cred = await buildCredential();
    cred.payload.paymentRequest.source.account = '0x000000000000000000000000000000000000bEEF';
    const server = registerServer({ submitter: okSubmitter, now });
    await expect(server.verify({ credential: cred as any, request })).rejects.toThrow(
      /does not recover/,
    );
  });
});

// The payer signs a deposit to a payee of their choosing and names the merchant in the unsigned
// copy, so every check against the challenge passes and only the signed destination can refuse it.
describe('verify — the payee the payer signed', () => {
  const attacker = '0x000000000000000000000000000000000000dEaD';
  const selfPaying = <C extends { request: { extra: { destination: { address: string } } } }>(
    base: C,
  ): C => {
    const copy = structuredClone(base);
    copy.request.extra.destination.address = attacker;
    return copy;
  };
  const cases: Array<[string, () => Promise<TestCredential>, typeof request]> = [
    ['EVM', () => buildCredential(selfPaying(challenge)), request],
    ['Tron', () => buildTronCredential(selfPaying(tronChallenge)), tronRequest],
    ['Solana', () => buildSolanaCredential(selfPaying(solanaChallenge)), solanaRequest],
  ];
  for (const [chain, build, merchantRequest] of cases) {
    it(`refuses a ${chain} deposit signed to another payee, and never submits it`, async () => {
      const cred = await build();
      cred.payload.paymentRequest.destination[0].account =
        merchantRequest.extra.destination.address;
      let submitted = 0;
      const server = registerServer({
        submitter: {
          submit: async () => {
            submitted++;
            return COMPLETED;
          },
        },
        now,
      });
      await expect(
        server.verify({ credential: cred as any, request: merchantRequest }),
      ).rejects.toThrow(/the payer signed a deposit payable to/);
      expect(submitted).toBe(0);
    });
  }
});

describe('verify — onCommitmentResult', () => {
  it('reports the verified result with its log fields', async () => {
    const seen: Array<Record<string, string>> = [];
    const server = registerServer({
      submitter: okSubmitter,
      now,
      onCommitmentResult: (_result, fields) => seen.push(fields),
    });
    await server.verify({ credential: (await buildCredential()) as any, request });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sender_auth_result).toBe('verified');
  });

  it('refuses, with a fixed message and without submitting, when the callback throws on an admission', async () => {
    let submitted = 0;
    const server = registerServer({
      submitter: {
        submit: async () => {
          submitted++;
          return COMPLETED;
        },
      },
      now,
      onCommitmentResult: () => {
        throw new Error('metrics backend down');
      },
    });
    const outcome = server.verify({ credential: (await buildCredential()) as any, request });
    await expect(outcome).rejects.toThrow(/the payment could not be recorded, so it is refused/);
    await expect(outcome).rejects.not.toThrow(/metrics backend down/);
    expect(submitted).toBe(0);
  });

  it('reports a refusal before it is thrown', async () => {
    const seen: Array<Record<string, string>> = [];
    const cred = await buildCredential({
      ...challenge,
      request: {
        ...request,
        extra: {
          ...request.extra,
          destination: {
            ...request.extra.destination,
            address: '0x000000000000000000000000000000000000dEaD',
          },
        },
      },
    });
    cred.payload.paymentRequest.destination[0].account = request.extra.destination.address;
    const server = registerServer({
      submitter: okSubmitter,
      now,
      onCommitmentResult: (_result, fields) => seen.push(fields),
    });
    await expect(server.verify({ credential: cred as any, request })).rejects.toThrow(
      /the payer signed a deposit payable to/,
    );
    expect(seen.map((f) => f.sender_auth_result)).toEqual(['destination_mismatch']);

    // A callback that throws on a refusal leaves the refusal as it was.
    const throwing = registerServer({
      submitter: okSubmitter,
      now,
      onCommitmentResult: () => {
        throw new Error('metrics backend down');
      },
    });
    await expect(throwing.verify({ credential: cred as any, request })).rejects.toThrow(
      /the payer signed a deposit payable to/,
    );
    expect(seen[0]!.signed_destination).toContain('@0x000000000000000000000000000000000000dead');
  });
});

describe('verify — the relayed request reads the same to every reader where it is read', () => {
  const verifyWith = async (mutate: (pr: any) => void) => {
    const cred = await buildCredential();
    mutate(cred.payload.paymentRequest);
    const server = registerServer({ submitter: okSubmitter, now });
    return server.verify({ credential: cred as any, request }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
  };

  it('rejects a request that spells one member two ways', async () => {
    const err = await verifyWith((pr) => {
      pr.Destination = [
        { ...pr.destination[0], account: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' },
      ];
    });
    expect(err?.message).toMatch(/two members that differ only in letter case, at \$\.Destination/);
  });

  it('rejects a request carrying a signed message besides the deposit', async () => {
    const err = await verifyWith((pr) => {
      pr.sender_auth.signed_messages.push({ ...pr.sender_auth.signed_messages[0] });
    });
    expect(err?.message).toMatch(/exactly one signed message/);
  });
});

/**
 * The gateway de-duplicates on `request_id`. The deposit commits to it, so a request_id swapped
 * after signing is refused, and verification re-derives it from the challenge's purchase
 * identifier, so a payer cannot sign a deposit for another purchase's request_id either.
 */
describe("verify — request_id must be anchored to the challenge's purchase", () => {
  const verifyWith = async (mutate: (cred: any) => void | Promise<void>) => {
    const cred = await buildCredential();
    await mutate(cred);
    const server = registerServer({ submitter: okSubmitter, now });
    return server.verify({ credential: cred as any, request }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
  };

  // Re-signs the deposit for `requestId`, as a payer signing for another purchase would.
  const signedFor = (requestId: string) => async (cred: any) => {
    const deposit = cred.payload.paymentRequest.sender_auth.signed_messages[0];
    const prehash = JSON.parse(deposit.message_prehash);
    prehash.message.witness.depositRequestHash = deriveDepositRequestHash(requestId);
    deposit.message_prehash = JSON.stringify(prehash);
    deposit.message = hashPermitWitnessTransferFrom(prehash);
    deposit.signature = await wallet.signTypedData(prehash.domain, prehash.types, prehash.message);
    cred.payload.paymentRequest.request_id = requestId;
  };

  it('rejects a request_id swapped after signing', async () => {
    // Keep a valid credential but point its request_id at a purchase that already settled with
    // identical terms, which would serve the resource twice for one charge.
    const err = await verifyWith((cred) => {
      cred.payload.paymentRequest.request_id = chargeRequestId('some-other-order', PAYER);
    });

    // The server reads v2 too, so the detail names both candidates the deposit matches neither of.
    expect(err?.message).toMatch(/request_hash_mismatch: .*is neither keccak256 of request_id/);
  });

  it('rejects a deposit signed for a request_id derived from a different purchase', async () => {
    const err = await verifyWith(signedFor(chargeRequestId('some-other-order', PAYER)));

    expect(err?.message).toMatch(/request_id is not derived from the challenge's purchase/);
  });

  it('rejects a deposit signed for a request_id that is merely well-formed', async () => {
    const err = await verifyWith(signedFor('req_mpp_deadbeefdeadbeefdeadbeef'));

    expect(err?.message).toMatch(/request_id is not derived from the challenge's purchase/);
  });

  it('rejects a deposit signed for a request_id anchored to the right purchase but a different payer', async () => {
    // The account is folded into the derivation, so one payer cannot ride another's payment.
    const err = await verifyWith(
      signedFor(chargeRequestId(INTENT_ID, '0x000000000000000000000000000000000000dEaD')),
    );

    expect(err?.message).toMatch(/request_id is not derived from the challenge's purchase/);
  });

  it('refuses a challenge that carries no purchase identifier', async () => {
    const err = await verifyWith((cred) => {
      delete cred.challenge.meta;
      delete cred.challenge.opaque;
    });

    expect(err?.message).toMatch(/carries no 'atumIntentId' metadata/);
  });

  it('accepts the identifier in its serialized wire form', async () => {
    // Over HTTP the framework re-parses `opaque` into `meta`, but a merchant driving the method
    // directly gets only `opaque`; both must resolve to the same identifier.
    const cred = await buildCredential();
    expect(cred.challenge?.meta).toBeUndefined();
    expect(cred.challenge?.opaque).toBeTypeOf('string');

    const server = registerServer({ submitter: okSubmitter, now });
    await expect(server.verify({ credential: cred as any, request })).resolves.toMatchObject({
      status: 'success',
    });
  });
});

/**
 * A settlement with no receipt is either still in flight or terminal, and those call for
 * opposite payer behaviour: retry this purchase, or start a new one.
 */
describe('verify — settlement did not produce a receipt', () => {
  const settle = async (result: PaymentSubmitResult) => {
    const cred = await buildCredential();
    const server = registerServer({ submitter: { submit: async () => result }, now });
    return server.verify({ credential: cred as any, request }).then(
      () => undefined,
      (e: unknown) => e,
    );
  };
  // What verify throws when the submitter throws `thrown`.
  const refuse = async (thrown: () => unknown) => {
    const cred = await buildCredential();
    const server = registerServer({
      submitter: {
        submit: async () => {
          throw thrown();
        },
      },
      now,
    });
    return server.verify({ credential: cred as any, request }).then(
      () => undefined,
      (e: unknown) => e,
    );
  };

  it('reports a still-settling payment as pending, carrying the payment id', async () => {
    const err = await settle({ payment_id: 'pay_1', status: 'pending', transactions: undefined });

    expect(isSettlementPending(err)).toBe(true);
    expect(isSettlementFailed(err)).toBe(false);
    expect((err as SettlementPendingError).paymentId).toBe('pay_1');
    // A signed credential cannot be re-presented once its quote window closes, so the message
    // names what stays (the intent id) and what must be rebuilt (the challenge).
    expect((err as Error).message).toMatch(/re-attempt the purchase/);
    expect((err as Error).message).toMatch(/fresh challenge/);
    expect((err as Error).message).toMatch(/SAME intent id/);
  });

  it('reports a failed payment as terminal, and says a new purchase is required', async () => {
    const err = await settle({ payment_id: 'pay_2', status: 'failed', transactions: undefined });

    expect(isSettlementFailed(err)).toBe(true);
    expect(isSettlementPending(err)).toBe(false);
    expect((err as SettlementFailedError).paymentId).toBe('pay_2');
    expect((err as SettlementFailedError).state).toBe('failed');
    expect((err as Error).message).toMatch(/new purchase under a new identifier/);
  });

  const PAYOUT = { transaction_hash: '0xpayout', chain_id: 'eip155:42161', block_number: 7 };
  const settleWith = async (result: PaymentSubmitResult, settleAt?: SettleAt) => {
    const cred = await buildCredential();
    const server = registerServer({
      submitter: { submit: async () => result },
      now,
      ...(settleAt ? { settleAt } : {}),
    });
    return server.verify({ credential: cred as any, request });
  };

  it('settles at finalizing by default: the receipt names the payout, the payment and its state', async () => {
    const receipt = await settleWith({
      payment_id: 'pay_5',
      status: 'finalizing',
      transactions: { fulfillment: PAYOUT },
    });

    expect(receipt.status).toBe('success');
    expect(receipt.reference).toBe('0xpayout');
    expect(receipt.paymentId).toBe('pay_5');
    expect(receipt.state).toBe('finalizing');
    expect(receipt.destinationChainId).toBe('eip155:42161');
  });

  it("with settleAt 'completed', a finalizing payment is still pending", async () => {
    const err = await settleWith(
      { payment_id: 'pay_6', status: 'finalizing', transactions: { fulfillment: PAYOUT } },
      'completed',
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(isSettlementPending(err)).toBe(true);
    expect((err as SettlementPendingError).paymentId).toBe('pay_6');
  });

  it('settles a completed payment from its transactions alone', async () => {
    const receipt = await settleWith({
      payment_id: 'pay_7',
      status: 'completed',
      transactions: { fulfillment: PAYOUT },
    });

    expect(receipt.reference).toBe('0xpayout');
    expect(receipt.state).toBe('completed');
  });

  it('stamps the receipt with the time it was issued', async () => {
    const receipt = await settleWith({
      payment_id: 'pay_8',
      status: 'completed',
      transactions: { fulfillment: PAYOUT },
    });

    expect(receipt.timestamp).toBe(new Date(now()).toISOString());
  });

  it('never reports success for a failed payment, even with a payout transaction', async () => {
    // A payout a reorganization dropped leaves the payment failed with the old transaction listed.
    const err = await settleWith({
      payment_id: 'pay_9',
      status: 'failed',
      transactions: { fulfillment: PAYOUT },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(isSettlementFailed(err)).toBe(true);
  });

  it('makes an adapter state transactions, so the faster answer cannot be dropped silently', () => {
    // @ts-expect-error transactions is a required key: pass the gateway's value, or undefined
    const missing: PaymentSubmitResult = { payment_id: 'p', status: 'pending' };
    const stated: PaymentSubmitResult = {
      payment_id: 'p',
      status: 'pending',
      transactions: undefined,
    };
    expect([missing, stated]).toHaveLength(2);
  });

  const failure = (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (e: unknown) => e,
    );

  it('reports pending for a completed status that names no payout transaction, and says so', async () => {
    // The buyer is told to wait (never that it failed), and that the payout is not reported yet. The
    // buyer cannot act on the cause, so the message names none.
    const err = await failure(
      settleWith({ payment_id: 'pay_e', status: 'completed', transactions: undefined }),
    );
    expect(isSettlementPending(err)).toBe(true);
    expect((err as SettlementPendingError).paymentId).toBe('pay_e');
    expect((err as Error).message).toMatch(
      /The payment is completed, but its payout is not reported yet/,
    );
    expect((err as Error).message).not.toMatch(/submitter/);
  });

  it.each([
    ['finalizing', { deposit: PAYOUT }],
    ['completed', { fulfillment: { ...PAYOUT, chain_id: '' } }],
  ] as const)(
    'reports pending, saying the payout is not reported yet, for %s with transactions %j',
    async (status, transactions) => {
      const err = await failure(settleWith({ payment_id: 'pay_m', status, transactions }));
      expect(isSettlementPending(err)).toBe(true);
      expect((err as Error).message).toMatch(/its payout is not reported yet/);
    },
  );

  it('says nothing about a missing payout while the payment is genuinely in flight', async () => {
    const err = await failure(
      settleWith({ payment_id: 'pay_q', status: 'pending', transactions: undefined }),
    );
    expect(isSettlementPending(err)).toBe(true);
    expect((err as Error).message).not.toMatch(/payout is not reported/);
  });

  it('reports pending for a payout hash on a pending payment', async () => {
    const err = await failure(
      settleWith({ payment_id: 'pay_p', status: 'pending', transactions: { fulfillment: PAYOUT } }),
    );
    expect(isSettlementPending(err)).toBe(true);
  });

  it('reports pending for a payout hash with no status', async () => {
    const err = await failure(
      settleWith({ payment_id: 'pay_n', transactions: { fulfillment: PAYOUT } }),
    );
    expect(isSettlementPending(err)).toBe(true);
  });

  it('never returns a receipt without a payment id', async () => {
    const err = await failure(
      settleWith({ status: 'completed', transactions: { fulfillment: PAYOUT } }),
    );
    expect(isSettlementPending(err)).toBe(true);
  });

  it("settles a completed payment under settleAt 'completed'", async () => {
    const receipt = await settleWith(
      { payment_id: 'pay_c', status: 'completed', transactions: { fulfillment: PAYOUT } },
      'completed',
    );
    expect(receipt.state).toBe('completed');
    expect(receipt.reference).toBe('0xpayout');
  });

  it('refuses an unknown settleAt', () => {
    expect(() =>
      registerServer({ submitter: okSubmitter, now, settleAt: 'later' as SettleAt }),
    ).toThrow(/settleAt must be 'finalizing' or 'completed'/);
  });

  it('reports a refunded payment as terminal, and says a new purchase is required', async () => {
    const err = await settle({ payment_id: 'pay_5', status: 'refunded', transactions: undefined });

    expect(isSettlementFailed(err)).toBe(true);
    expect((err as SettlementFailedError).state).toBe('refunded');
    expect((err as Error).message).toMatch(/new purchase under a new identifier/);
  });

  it.each(['refunding', 'refund_available'] as const)(
    'treats a %s payment as pending, never as terminal',
    async (state) => {
      // The deposit is still in escrow and a late delivery can still complete it, so paying again
      // under a new identifier could pay the recipient twice.
      const err = await settle({ payment_id: 'pay_6', status: state, transactions: undefined });

      expect(isSettlementPending(err)).toBe(true);
      expect((err as SettlementPendingError).toProblemDetails()).toMatchObject({ state });
      expect((err as Error).message.includes('refund_signature')).toBe(
        state === 'refund_available',
      );
    },
  );

  it('treats a finalizing payment without a payout transaction as pending, never as terminal', async () => {
    // An adapter that does not pass `transactions` through leaves nothing to settle against.
    const err = await settle({
      payment_id: 'pay_3',
      status: 'finalizing',
      transactions: undefined,
    });

    expect(isSettlementPending(err)).toBe(true);
    expect(isSettlementFailed(err)).toBe(false);
    expect((err as SettlementPendingError).paymentId).toBe('pay_3');
  });

  it('defaults to pending when the gateway reports no status', async () => {
    // Reading an absent status as failure would tell a payer whose payment is in flight to start
    // a second one, so absence means "still settling".
    const err = await settle({ payment_id: 'pay_4', transactions: undefined });

    expect(isSettlementPending(err)).toBe(true);
  });

  it('still reports pending when the payment was never given an id', async () => {
    const err = await settle({ transactions: undefined });

    expect(isSettlementPending(err)).toBe(true);
    expect((err as SettlementPendingError).paymentId).toBeUndefined();
  });

  it('lets a gateway refusal through with its code intact', async () => {
    // A refusal is neither pending nor failed: nothing is in flight and nothing was charged, so
    // the payer can fix the request and keep the same identifier.
    const err = await refuse(
      () =>
        new PaymentRejectedError({
          code: 'IDEMPOTENCY_TERMS_MISMATCH',
          detail: 'this purchase identifier was already used with different terms',
        }),
    );

    expect(isPaymentRejected(err)).toBe(true);
    expect(isSettlementFailed(err)).toBe(false);
    expect(isSettlementPending(err)).toBe(false);
    expect((err as PaymentRejectedError).code).toBe('IDEMPOTENCY_TERMS_MISMATCH');
  });

  it('lets a retryable gateway refusal through as retryable, not as a rejection', async () => {
    // The gateway could not take the payment this time and nothing was created, so the payer
    // must be told to re-attempt shortly rather than to fix the request.
    const err = await refuse(() => {
      const answer = new ApiError(
        { method: 'POST', url: '/v1/payments' },
        {
          url: 'https://gateway.example/v1/payments',
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          body: {
            code: 'AUTHORIZATION_UNAVAILABLE',
            message:
              'This payment could not be authorized because a check could not be completed. ' +
              'It was not declined.',
            retry_classification: 'RETRY_AFTER_DELAY',
            request_id_reusable: true,
          },
        },
        'Service Unavailable',
      );
      return gatewayRefusalOf(answer) ?? answer;
    });

    expect(isPaymentRetryable(err)).toBe(true);
    expect(isPaymentRejected(err)).toBe(false);
    expect(isSettlementFailed(err)).toBe(false);
    expect(isSettlementPending(err)).toBe(false);
    expect((err as PaymentRetryableError).toProblemDetails()).toMatchObject({
      status: 402,
      type: 'https://paymentauth.org/problems/payment-action-required',
      code: 'AUTHORIZATION_UNAVAILABLE',
    });
  });
});

describe('buildChargeChallenge', () => {
  it('returns the terms and the per-purchase identifier in the shape the framework expects', () => {
    const built = buildChargeChallenge(corridor, EVM_SOURCE, '10000000', { intentId: 'order-9' });

    // The terms are identical to the request-only builder; the helper only adds metadata.
    expect(built.request).toEqual(buildChargeRequest(corridor, EVM_SOURCE, '10000000'));
    expect(built.meta).toEqual({ [INTENT_ID_META_KEY]: 'order-9' });
    // The payer reads the identifier from challenge metadata, not from the request.
    expect(built.request).not.toHaveProperty('meta');
    expect(JSON.stringify(built.request)).not.toContain('order-9');
  });

  it('refuses an empty identifier rather than emitting an unpayable challenge', () => {
    expect(() => buildChargeChallenge(corridor, EVM_SOURCE, '10000000', { intentId: '' })).toThrow(
      /non-empty per-purchase identifier/,
    );
  });

  it('still validates the corridor and the source selection', () => {
    expect(() =>
      buildChargeChallenge(corridor, { network: 'eip155:1', asset: EVM_SOURCE.asset }, '10000000', {
        intentId: 'order-9',
      }),
    ).toThrow(/no source option configured/);
  });

  it('passes Solana options through to the request builder', () => {
    const built = buildChargeChallenge(
      solanaCorridor,
      {
        network: solanaCorridor.sources[0]!.network,
        asset: solanaCorridor.sources[0]!.assets[0]!.address,
      },
      '10000000',
      { intentId: 'order-9', issuedAt: '1700000000' },
    );
    expect(built.request.extra.issuedAt).toBe('1700000000');
  });
});

describe('verify — tamper rejections (EVM)', () => {
  const OTHER_ADDR = '0x000000000000000000000000000000000000dEaD';

  // Build a valid credential, mutate one field of the (plaintext) payment request, and
  // assert verify() rejects with the matching message.
  async function expectReject(mutate: (pr: any) => void, pattern: RegExp) {
    const cred = await buildCredential();
    mutate(cred.payload.paymentRequest);
    const server = registerServer({ submitter: okSubmitter, now });
    await expect(server.verify({ credential: cred as any, request })).rejects.toThrow(pattern);
  }

  it('rejects an EVM payment relabelled with another scheme', () =>
    expectReject((pr) => {
      pr.sender_auth.message_scheme = 'EVM_PERMIT2_ESCROW';
    }, /unsupported message_scheme for eip155:.*: EVM_PERMIT2_ESCROW/));

  it('rejects a tampered destination asset', () =>
    expectReject((pr) => {
      pr.destination[0].asset_identifier = `eip155:42161/erc20:${OTHER_ADDR}`;
    }, /destination asset/));

  it('rejects a mismatched fulfillment_amount', () =>
    expectReject((pr) => {
      pr.fulfillment_amount = '999';
    }, /fulfillment_amount/));

  it('rejects max_source_amount exceeding the source cap', () =>
    expectReject((pr) => {
      pr.max_source_amount = '999999999999999';
    }, /exceeds the source cap/));

  it('rejects a max_source_amount spelled other than as a decimal integer', () =>
    expectReject((pr) => {
      pr.max_source_amount = '0xf4240';
    }, /max_source_amount is not a decimal integer string/));

  it('rejects a tampered escrow_contract_address', () =>
    expectReject((pr) => {
      pr.escrow_contract_address = OTHER_ADDR;
    }, /escrow_contract_address/));

  it('rejects a tampered quote_selector', () =>
    expectReject((pr) => {
      pr.quote_selector = OTHER_ADDR;
    }, /quote_selector/));

  it('rejects a tampered fulfillment_proxy', () =>
    expectReject((pr) => {
      pr.fulfillment_proxy = OTHER_ADDR;
    }, /fulfillment_proxy/));

  it('rejects a tampered fulfillment_verifier.account', () =>
    expectReject((pr) => {
      pr.fulfillment_verifier.account = OTHER_ADDR;
    }, /fulfillment_verifier\.account/));

  it('rejects a tampered fulfillment_verifier.endpoint', () =>
    expectReject((pr) => {
      pr.fulfillment_verifier.endpoint = 'https://evil.example.com';
    }, /fulfillment_verifier\.endpoint/));

  it('rejects a stretched fulfillment_deadline beyond the advertised budget', () =>
    expectReject((pr) => {
      pr.fulfillment_deadline = new Date(NOW + 10_000_000_000).toISOString();
    }, /fulfillment_deadline exceeds/));

  it('rejects a stretched quote_deadline beyond the advertised budget', () =>
    // Still before fulfillment (NOW+300s) so ordering passes, but past the 20s quote budget
    // (+60s skew) — isolates the quote-budget upper bound from the ordering check.
    expectReject((pr) => {
      pr.quote_deadline = new Date(NOW + 200_000).toISOString();
    }, /quote_deadline exceeds/));

  // A closed quote window (typically a re-presented credential) and out-of-order deadlines have
  // different remedies, so they are reported differently.
  it('tells a caller whose quote window has closed to re-run the purchase', () =>
    expectReject((pr) => {
      // Ordering still holds (quote < fulfillment); only freshness fails.
      pr.quote_deadline = new Date(NOW - 1_000).toISOString();
    }, /quote window has already closed/));

  it('names the intent id as the thing that must NOT change when re-running', () =>
    expectReject((pr) => {
      pr.quote_deadline = new Date(NOW - 1_000).toISOString();
    }, /SAME intent id/));

  it('surfaces a closed quote window as a typed PaymentActionRequiredError, not a plain Error', async () => {
    // mppx's request routing replaces any error that is not an Errors.PaymentError with a
    // generic message before it reaches the wire, so this must be typed to reach an HTTP payer.
    const cred = await buildCredential();
    cred.payload.paymentRequest.quote_deadline = new Date(NOW - 1_000).toISOString();
    const server = registerServer({ submitter: okSubmitter, now });
    const error = await server
      .verify({ credential: cred as any, request })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Errors.PaymentActionRequiredError);
    expect((error as Errors.PaymentActionRequiredError).type).toBe(
      'https://paymentauth.org/problems/payment-action-required',
    );
  });

  it('reports deadlines in the wrong order as a malformed request, not a stale one', () =>
    // Both in the future, so freshness passes and only ordering fails.
    expectReject((pr) => {
      pr.quote_deadline = new Date(NOW + 250_000).toISOString();
      pr.fulfillment_deadline = new Date(NOW + 100_000).toISOString();
    }, /quote_deadline must be before fulfillment_deadline/));

  it('rejects max_source_amount that is under the cap but not equal to the signed permit amount', () =>
    // maxSource (10_000_000) < cap (10_300_000) so the cap check passes, but the permit
    // authorized the full cap — isolates the permit-amount-vs-max_source_amount branch.
    expectReject((pr) => {
      pr.max_source_amount = '10000000';
    }, /permit amount does not match max_source_amount/));

  it('rejects when the permit spender is not the challenge escrow', async () => {
    // Built for the real corridor (escrow X); verified against a challenge advertising a
    // different escrow (Y). The signature still recovers (the signed message carries X),
    // so the spender equality check — not the recovery check — is what rejects it.
    const cred = await buildCredential();
    const otherRequest = buildChargeRequest(
      { ...corridor, sources: [{ ...corridor.sources[0]!, escrow: OTHER_ADDR }] },
      EVM_SOURCE,
      '10000000',
    );
    const server = registerServer({ submitter: okSubmitter, now });
    await expect(server.verify({ credential: cred as any, request: otherRequest })).rejects.toThrow(
      /permit spender/,
    );
  });
});

describe('verify (Tron)', () => {
  it('verifies a Tron credential end to end', async () => {
    const cred = await buildTronCredential();
    const pr = cred.payload.paymentRequest;
    expect(pr.source.asset_identifier).toBe(
      `tron:mainnet/trc20:${tronCorridor.sources[0]!.assets[0]!.address}`,
    );
    expect(pr.sender_auth.message_scheme).toBe('EVM_PERMIT2');
    const server = registerServer({ submitter: okSubmitter, now });
    const receipt = await server.verify({ credential: cred as any, request: tronRequest });
    expect(receipt.status).toBe('success');
  });

  it('rejects a signature that does not recover to source.account', async () => {
    const cred = await buildTronCredential();
    cred.payload.paymentRequest.sender_auth.signed_messages[0].signature = '0x' + '11'.repeat(65);
    const server = registerServer({ submitter: okSubmitter, now });
    await expect(server.verify({ credential: cred as any, request: tronRequest })).rejects.toThrow(
      /does not recover/,
    );
  });

  it('rejects a Tron payment relabelled with the TRON scheme', async () => {
    const cred = await buildTronCredential();
    cred.payload.paymentRequest.sender_auth.message_scheme = 'TRON';
    const server = registerServer({ submitter: okSubmitter, now });
    await expect(server.verify({ credential: cred as any, request: tronRequest })).rejects.toThrow(
      /unsupported message_scheme for tron:mainnet: TRON/,
    );
  });

  // The Tron Permit2 verifying contract is not carried on the wire: signing and verification
  // both derive it from `resolveTronPermit2`, so a challenge cannot name a different Permit2.
});

describe('verify (Solana)', () => {
  it('verifies the ed25519 deposit signature end to end', async () => {
    const cred = await buildSolanaCredential();
    const server = registerServer({ submitter: okSubmitter, now });
    const receipt = await server.verify({ credential: cred as any, request: solanaRequest });
    expect(receipt.status).toBe('success');
  });

  it('rejects a tampered deposit signature', async () => {
    const cred = await buildSolanaCredential();
    cred.payload.paymentRequest.sender_auth.signed_messages[0].signature = '0x' + '22'.repeat(64);
    const server = registerServer({ submitter: okSubmitter, now });
    await expect(
      server.verify({ credential: cred as any, request: solanaRequest }),
    ).rejects.toThrow(/the ed25519 signature does not verify/);
  });

  it('rejects a Solana payment relabelled with the EVM scheme', async () => {
    const cred = await buildSolanaCredential();
    cred.payload.paymentRequest.sender_auth.message_scheme = 'EVM_PERMIT2';
    const server = registerServer({ submitter: okSubmitter, now });
    await expect(
      server.verify({ credential: cred as any, request: solanaRequest }),
    ).rejects.toThrow(/unsupported message_scheme for solana:.*: EVM_PERMIT2/);
  });

  it('rejects a delegate signer that is not the source account', async () => {
    const cred = await buildSolanaCredential();
    cred.payload.paymentRequest.sender_auth.signed_messages[0].payload.delegate_signer = b58(9);
    const server = registerServer({ submitter: okSubmitter, now });
    await expect(
      server.verify({ credential: cred as any, request: solanaRequest }),
    ).rejects.toThrow(/the delegate signer is not the payment's source account/);
  });
});

// A Solana pubkey is base58 with no checksum, so a case variant is a different, valid key.
// These routing fields are not covered by the deposit signature, so their equality check must
// reject a lowercased variant.
describe('verify — base58 case-variant rejections (Solana)', () => {
  async function expectSolanaReject(mutate: (pr: any) => void, pattern: RegExp) {
    const cred = await buildSolanaCredential();
    mutate(cred.payload.paymentRequest);
    const server = registerServer({ submitter: okSubmitter, now });
    await expect(
      server.verify({ credential: cred as any, request: solanaRequest }),
    ).rejects.toThrow(pattern);
  }

  it('rejects an escrow_contract_address that only differs by base58 case', () =>
    expectSolanaReject((pr) => {
      pr.escrow_contract_address = pr.escrow_contract_address.toLowerCase();
    }, /escrow_contract_address/));

  it('rejects a quote_selector (reserver) that only differs by base58 case', () =>
    expectSolanaReject((pr) => {
      pr.quote_selector = pr.quote_selector.toLowerCase();
    }, /quote_selector/));

  it('rejects a fulfillment_verifier.account (releaser) that only differs by base58 case', () =>
    expectSolanaReject((pr) => {
      pr.fulfillment_verifier.account = pr.fulfillment_verifier.account.toLowerCase();
    }, /fulfillment_verifier\.account/));
});
