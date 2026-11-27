import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import nacl from 'tweetnacl';
import { Address, computeDepositHash, type EscrowDomain } from '@atum-labs/stellar-escrow-encoding';
import { getChainAdapter } from './adapters/index.js';
import { readStellarRecord, stellarEscrowDomain } from './commitment-stellar.js';
import type { StellarRecord } from './commitment-stellar.js';
import { stellarAdapter } from './adapters/stellar.js';
import { verifyPaymentRequestJSON } from './verify.js';
import {
  DelegateUnverifiedError,
  MalformedPrehashError,
  RecoveryFailedError,
  SignerMismatchError,
} from './errors.js';
import { commitmentResultOf } from './commitment-rules.js';
import { IDENTITY_POINT, nonCanonicalEd25519 } from './test-helpers.js';
import type { CommitmentExpectation, CommitmentOutcome } from './commitment-rules.js';
import type {
  BuildAuthMessageParams,
  SignedMessageInput,
  SourceRef,
  VerifyExpectations,
} from './types.js';

// Frozen Stellar sender_auth vectors, read by this test and the Go test
// (../../go/sender-auth/senderauth/stellar_conformance_test.go). Every accept and every reject must
// come out the same in both languages: the message bytes, the signature check, the commitment
// outcome and its detail. The golden case is not an output of this code: its digest and delegate
// signature are the ones contracts/stellar/source/docs/witness-layouts.md derives out of band.
const VECTORS_PATH = resolve(__dirname, '../../../../conformance/stellar-sender-auth-vectors.json');
const COMMENT =
  'Frozen Stellar sender_auth vectors. Verified by TS (bindings/typescript/sender-auth/src/stellar-conformance.test.ts) ' +
  'and Go (bindings/go/sender-auth/senderauth/stellar_conformance_test.go). Regenerate: REGEN_STELLAR_VECTORS=1 pnpm --filter ' +
  '@atum-labs/payment-request-sender-auth exec vitest run src/stellar-conformance.test.ts';

type Expect =
  | {
      kind: 'accept';
      amount: string;
      deadlineSec: number;
      delegateSigner: string;
      delegateOnchainUnverified: boolean;
      delegateEpoch: string;
    }
  | { kind: 'signer'; signer: string }
  | { kind: 'Commitment' | 'MalformedPrehash'; outcome: CommitmentOutcome; detail: string }
  | { kind: 'RecoveryFailed' | 'SignerMismatch' | 'DelegateUnverified' }
  | { kind: 'Rejected'; messageContains: string };

interface VerifyVector {
  name: string;
  call: 'recoverAndVerify' | 'recoverSigner';
  source: SourceRef;
  commitment: CommitmentExpectation;
  expected: VerifyExpectations;
  signed: SignedMessageInput;
  expect: Expect;
}

interface BuildVector {
  name: string;
  input: BuildAuthMessageParams;
  /** The digest and prehash on success, or the substring the refusal must contain. */
  messageHash?: string;
  messagePrehash?: string;
  errorContains?: string;
}

interface RequestVector {
  name: string;
  request: string;
  expected: { escrowContract?: string; reserver?: string; releaser?: string };
  expect: { amount: string } | { outcome: CommitmentOutcome } | { delegateUnverified: true };
}

// ─── The fixture ─────────────────────────────────────────────────────────────

const fill = (byte: number) => new Uint8Array(32).fill(byte);
const account = (byte: number) => Address.account(fill(byte)).toString();
const contract = (byte: number) => Address.contract(fill(byte)).toString();

const DELEGATE_KEYS = nacl.sign.keyPair.fromSeed(fill(0x77));
const DELEGATE = Address.account(DELEGATE_KEYS.publicKey).toString();
const ESCROW = contract(0xc0);
const TOKEN = contract(0xe1);
const DEPOSITOR = account(0xd1);
const RESERVER = account(0x55);
const RELEASER = account(0x66);
const DEFAULTS = {
  escrowContract: ESCROW,
  quoteSelector: RESERVER,
  fulfillmentVerifierAccount: RELEASER,
  fulfillmentVerifierEndpoint: 'https://verifier.example',
  fulfillmentProxy: contract(0xf1),
};
const PAYEE = {
  asset_identifier: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  account: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
};
// A muxed contract (W) and a muxed account (M) with valid checksums: no 33-byte form, refused.
const MUXED_CONTRACT = 'WA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSAAAAAAAAAAAAC4AS';
const MUXED_ACCOUNT = 'MA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSAAAAAAAAAAAAADCA';

// The out-of-band golden (witness-layouts.md, "Golden vectors"): testnet deposit digest and the
// delegate signature over it, from the key made of 0x77 repeated.
const GOLDEN_DIGEST = '0xd28667e7c40efa69ab7ba45db817a82044cb10840fe95a45425e7b99556f6a65';
const GOLDEN_SIGNATURE =
  '0xec48e2d9cc0bff07e1d6c5fb9820fd8cc7a269fe3d3cc752afd46809472076d45327cc4482b64e91990cde344c545a667304692261d9fa526eddf8e6cd12fe0b';
const GOLDEN_DELEGATE_PUBKEY = 'c853ad0f0cd2b619aea92ceec4fd56a24d6499d584ce79257e45cfd8139b60a7';
const GOLDEN_REQUEST_HASH = '0x' + '44'.repeat(32);
const GOLDEN_PREHASH = {
  deposit_request_hash: GOLDEN_REQUEST_HASH,
  destination:
    'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0xc0ffee254729296a45a3885639ac7e10f9d54979',
  depositor: DEPOSITOR,
  token: TOKEN,
  epoch: '1',
  amount: '1250000',
  reserver: RESERVER,
  releaser: RELEASER,
  nonce: '4294967303',
  issued_at: '1700000000',
  deadline: '1700000128',
};

const SOURCE: SourceRef = { network: 'stellar:testnet', asset: TOKEN, account: DEPOSITOR };
// A payer whose own key is its delegate signer: the only Stellar shape an offline verifier admits.
// The golden case names a separate delegate (the out-of-band values), which it refuses as
// delegate_unverified after every other check has held.
const SELF_SOURCE: SourceRef = { ...SOURCE, account: DELEGATE };
const GOLDEN_COMMITMENT: CommitmentExpectation = {
  destinations: [PAYEE],
  requestId: 'req_golden_stellar',
  depositRequestHashV2: GOLDEN_REQUEST_HASH,
};
const EXPECTED: VerifyExpectations = {
  maxSourceAmount: '1250000',
  escrowContract: ESCROW,
  reserver: RESERVER,
  releaser: RELEASER,
};
const GOLDEN_SIGNED: SignedMessageInput = {
  message: GOLDEN_DIGEST,
  message_prehash: JSON.stringify(GOLDEN_PREHASH),
  signature: GOLDEN_SIGNATURE,
  payload: { delegate_signer: DELEGATE },
};

/** A deposit by the delegate key's own account, signed by that key, the digest computed here. */
function selfDelegated(change: Record<string, unknown> = {}): SignedMessageInput {
  const prehash = { ...GOLDEN_PREHASH, depositor: DELEGATE, ...change };
  const domain = stellarEscrowDomain('stellar:testnet', ESCROW) as EscrowDomain;
  const rec = readStellarRecord(prehash) as StellarRecord;
  const digest = computeDepositHash(rec.params, domain);
  const signature = nacl.sign.detached(digest, DELEGATE_KEYS.secretKey);
  return {
    message: '0x' + Buffer.from(digest).toString('hex'),
    message_prehash: JSON.stringify(prehash),
    signature: '0x' + Buffer.from(signature).toString('hex'),
    payload: { delegate_signer: DELEGATE },
  };
}

function withPrehash(change: Record<string, unknown>, drop: string[] = []): SignedMessageInput {
  const next: Record<string, unknown> = { ...GOLDEN_PREHASH, ...change };
  for (const name of drop) delete next[name];
  return { ...GOLDEN_SIGNED, message_prehash: JSON.stringify(next) };
}

// ─── Running a vector ────────────────────────────────────────────────────────

function run(v: VerifyVector): Expect {
  const adapter = getChainAdapter(v.source.network);
  try {
    if (v.call === 'recoverSigner') {
      return { kind: 'signer', signer: adapter.recoverSigner(v.signed, v.source) };
    }
    const r = adapter.recoverAndVerify(v.signed, v.source, v.commitment, v.expected);
    return {
      kind: 'accept',
      amount: r.amount,
      deadlineSec: r.deadlineSec,
      delegateSigner: r.permit.delegateSigner ?? '',
      delegateOnchainUnverified: r.permit.delegateOnchainUnverified === true,
      delegateEpoch: r.permit.delegateEpoch ?? '',
    };
  } catch (e) {
    if (e instanceof RecoveryFailedError) return { kind: 'RecoveryFailed' };
    if (e instanceof SignerMismatchError) return { kind: 'SignerMismatch' };
    if (e instanceof DelegateUnverifiedError) return { kind: 'DelegateUnverified' };
    const result = commitmentResultOf(e);
    if (result !== undefined) {
      return {
        kind: e instanceof MalformedPrehashError ? 'MalformedPrehash' : 'Commitment',
        outcome: result.outcome,
        detail: result.detail,
      };
    }
    return { kind: 'Rejected', messageContains: (e as Error).message };
  }
}

function verifyVectors(): VerifyVector[] {
  const base = {
    source: SOURCE,
    commitment: GOLDEN_COMMITMENT,
    expected: EXPECTED,
    signed: GOLDEN_SIGNED,
  };
  const v = (
    name: string,
    patch: Partial<VerifyVector>,
    call: VerifyVector['call'] = 'recoverAndVerify',
  ): VerifyVector => ({
    name,
    call,
    ...base,
    ...patch,
    expect: {
      kind: 'accept',
      amount: '',
      deadlineSec: 0,
      delegateSigner: '',
      delegateOnchainUnverified: false,
      delegateEpoch: '',
    },
  });
  return [
    v('golden-deposit-testnet', {}),
    v('golden-recover-signer', {}, 'recoverSigner'),
    // The payer's own key as its delegate: verified, and the only shape admitted offline.
    v('self-delegated-deposit', { signed: selfDelegated(), source: SELF_SOURCE }),
    v(
      'self-delegated-recover-signer',
      { signed: selfDelegated(), source: SELF_SOURCE },
      'recoverSigner',
    ),
    // The network is part of the digest: the same message on another network does not rebuild.
    v('wrong-network-pubnet', { source: { ...SOURCE, network: 'stellar:pubnet' } }),
    v('wrong-network-unknown-reference', { source: { ...SOURCE, network: 'stellar:mainnet' } }),
    // The escrow is part of the digest, and comes from the verifier, not the payment.
    v('wrong-contract', { expected: { ...EXPECTED, escrowContract: contract(0xc1) } }),
    v('no-escrow-configured', { expected: { ...EXPECTED, escrowContract: undefined } }),
    v('escrow-is-an-account', { expected: { ...EXPECTED, escrowContract: account(0xc0) } }),
    // Muxed addresses have no 33-byte form: refused, never hashed.
    v('muxed-contract-depositor', {
      signed: withPrehash({ depositor: MUXED_CONTRACT }),
      source: { ...SOURCE, account: MUXED_CONTRACT },
    }),
    v('muxed-account-depositor', {
      signed: withPrehash({ depositor: MUXED_ACCOUNT }),
      source: { ...SOURCE, account: MUXED_ACCOUNT },
    }),
    v('muxed-token', { signed: withPrehash({ token: MUXED_CONTRACT }) }),
    v('reserver-is-a-contract', { signed: withPrehash({ reserver: contract(0x55) }) }),
    // Signature shape: ed25519 is 64 bytes.
    v('signature-65-bytes', { signed: { ...GOLDEN_SIGNED, signature: GOLDEN_SIGNATURE + '1b' } }),
    v('signature-63-bytes', {
      signed: { ...GOLDEN_SIGNED, signature: GOLDEN_SIGNATURE.slice(0, -2) },
    }),
    v(
      'signature-65-bytes-recover-signer',
      { signed: { ...GOLDEN_SIGNED, signature: GOLDEN_SIGNATURE + '1b' } },
      'recoverSigner',
    ),
    v('signature-non-canonical-s', {
      signed: { ...GOLDEN_SIGNED, signature: nonCanonicalEd25519(GOLDEN_SIGNATURE) },
    }),
    v('signature-bit-flipped', {
      signed: { ...GOLDEN_SIGNED, signature: GOLDEN_SIGNATURE.slice(0, -1) + '7' },
    }),
    v(
      'signature-bit-flipped-recover-signer',
      {
        signed: { ...GOLDEN_SIGNED, signature: GOLDEN_SIGNATURE.slice(0, -1) + '7' },
      },
      'recoverSigner',
    ),
    // The Soroban host checks with verify_strict: a small-order delegate key with a small-order R and
    // S = 0 verifies for any message under the unstrict check and is refused here.
    v('delegate-signer-small-order-key', {
      signed: {
        ...GOLDEN_SIGNED,
        payload: { delegate_signer: Address.account(IDENTITY_POINT).toString() },
        signature: '0x' + IDENTITY_POINT.toString('hex') + '00'.repeat(32),
      },
    }),
    // The signer is the delegate named in the payload, and it is required.
    v('no-delegate-signer', { signed: { ...GOLDEN_SIGNED, payload: undefined } }),
    v(
      'no-delegate-signer-recover-signer',
      { signed: { ...GOLDEN_SIGNED, payload: {} } },
      'recoverSigner',
    ),
    v('delegate-signer-did-not-sign', {
      signed: { ...GOLDEN_SIGNED, payload: { delegate_signer: account(0x78) } },
    }),
    v('delegate-signer-is-a-contract', {
      signed: { ...GOLDEN_SIGNED, payload: { delegate_signer: contract(0x77) } },
    }),
    v('delegate-signer-not-a-string', {
      signed: { ...GOLDEN_SIGNED, payload: { delegate_signer: 7 } },
    }),
    v('source-account-is-not-the-depositor', { source: { ...SOURCE, account: account(0xd2) } }),
    // Every field of the record is under the signature.
    v('tampered-amount', { signed: withPrehash({ amount: '1250001' }) }),
    v('tampered-epoch', { signed: withPrehash({ epoch: '2' }) }),
    v('epoch-missing', { signed: withPrehash({}, ['epoch']) }),
    v('epoch-zero', { signed: withPrehash({ epoch: '0' }) }),
    v('epoch-above-u64', { signed: withPrehash({ epoch: (1n << 64n).toString() }) }),
    v('epoch-not-decimal', { signed: withPrehash({ epoch: '0x1' }) }),
    v('tampered-nonce', { signed: withPrehash({ nonce: '4294967304' }) }),
    v('tampered-issued-at', { signed: withPrehash({ issued_at: '1700000001' }) }),
    v('tampered-deadline', { signed: withPrehash({ deadline: '1700000129' }) }),
    v('tampered-reserver', { signed: withPrehash({ reserver: account(0x56) }) }),
    v('tampered-releaser', { signed: withPrehash({ releaser: account(0x67) }) }),
    v('tampered-token', { signed: withPrehash({ token: contract(0xe2) }) }),
    v('tampered-destination', {
      signed: withPrehash({ destination: GOLDEN_PREHASH.destination.replace('c0ffee', 'c0ffef') }),
    }),
    v('tampered-request-hash', {
      signed: withPrehash({ deposit_request_hash: '0x' + '45'.repeat(32) }),
    }),
    v('tampered-digest', {
      signed: { ...GOLDEN_SIGNED, message: GOLDEN_DIGEST.slice(0, -1) + '9' },
    }),
    // The record is read strictly.
    v('record-has-an-extra-member', { signed: withPrehash({ spender: ESCROW }) }),
    v('record-names-a-member-twice', {
      signed: {
        ...GOLDEN_SIGNED,
        message_prehash: JSON.stringify(GOLDEN_PREHASH).replace(/}$/, ',"issuedAt":"1700000000"}'),
      },
    }),
    v('amount-above-i128', { signed: withPrehash({ amount: (1n << 127n).toString() }) }),
    v('amount-zero', { signed: withPrehash({ amount: '0' }) }),
    v('amount-not-decimal', { signed: withPrehash({ amount: '0x10' }) }),
    v('nonce-above-u64', { signed: withPrehash({ nonce: (1n << 64n).toString() }) }),
    // Fail closed: the roles are free members of the signed record, so the verifier must pin them.
    v('no-expected-reserver', { expected: { ...EXPECTED, reserver: undefined } }),
    v('no-expected-releaser', { expected: { ...EXPECTED, releaser: undefined } }),
    v('no-expected-roles', {
      expected: { ...EXPECTED, reserver: undefined, releaser: undefined },
    }),
    v('empty-expected-reserver', { expected: { ...EXPECTED, reserver: '' } }),
    // The window the contract and the builder enforce.
    v('window-one-year', { signed: withPrehash({ deadline: String(1700000000 + 31536000) }) }),
    v('window-over-a-day-by-one', {
      signed: withPrehash({ deadline: String(1700000000 + 86401) }),
    }),
    v('window-equal-times', { signed: withPrehash({ deadline: '1700000000' }) }),
    v('window-deadline-before-issued-at', { signed: withPrehash({ deadline: '1699999999' }) }),
    // Members that differ only in spelling are ambiguous to a reader that folds them.
    v('record-names-request-hash-twice', {
      signed: {
        ...GOLDEN_SIGNED,
        message_prehash: JSON.stringify(GOLDEN_PREHASH).replace(
          /}$/,
          `,"paymentId":"${GOLDEN_REQUEST_HASH}"}`,
        ),
      },
    }),
    v('record-names-destination-in-upper-case', {
      signed: {
        ...GOLDEN_SIGNED,
        message_prehash: JSON.stringify(GOLDEN_PREHASH).replace(/}$/, ',"DESTINATION":"x"}'),
      },
    }),
    // A lone surrogate in the destination is not well-formed text in either language.
    v('destination-lone-surrogate', {
      signed: {
        ...GOLDEN_SIGNED,
        message_prehash: JSON.stringify(GOLDEN_PREHASH).replace(
          /"destination":"eip155/,
          '"destination":"\\ud800eip155',
        ),
      },
    }),
    v('no-prehash', { signed: { ...GOLDEN_SIGNED, message_prehash: undefined } }),
    v('prehash-without-destination', { signed: withPrehash({}, ['destination']) }),
    // The payment's own terms are bound.
    v('payee-rewritten', {
      commitment: {
        ...GOLDEN_COMMITMENT,
        destinations: [{ ...PAYEE, account: '0x1111111111111111111111111111111111111111' }],
      },
    }),
    v('request-id-rewritten-with-no-v2', {
      commitment: { destinations: [PAYEE], requestId: 'req_other' },
    }),
    v('max-source-amount-differs', { expected: { ...EXPECTED, maxSourceAmount: '1249999' } }),
    v('source-asset-differs', { source: { ...SOURCE, asset: contract(0xe2) } }),
    v('expected-reserver-differs', { expected: { ...EXPECTED, reserver: account(0x56) } }),
    v('expected-releaser-differs', { expected: { ...EXPECTED, releaser: account(0x67) } }),
    // A deposit that pays a chosen quote binds the quote's source amount instead of the maximum.
    v('quote-source-amount-binds', {
      signed: selfDelegated(),
      source: SELF_SOURCE,
      expected: { ...EXPECTED, maxSourceAmount: '', quoteSourceAmount: '1250000' },
    }),
    v('quote-source-amount-differs', {
      signed: selfDelegated(),
      source: SELF_SOURCE,
      expected: { ...EXPECTED, maxSourceAmount: '', quoteSourceAmount: '1249999' },
    }),
    v('quote-and-max-source-amount-both', {
      expected: { ...EXPECTED, quoteSourceAmount: '1250000' },
    }),
  ].map((vec) => ({ ...vec, expect: run(vec) }));
}

function buildVectors(): BuildVector[] {
  const input: BuildAuthMessageParams = {
    sourceAsset: `stellar:testnet/sep41:${TOKEN}`,
    depositor: DEPOSITOR,
    maxSourceAmount: '1250000',
    requestId: 'req_build_stellar',
    destinationAsset: PAYEE.asset_identifier,
    destinationAccount: PAYEE.account,
    sourceDefaults: DEFAULTS,
    nonce: 4294967303n,
    issuedAt: 1700000000n,
    deadline: 1700000128n,
    delegateEpoch: 1n,
  };
  // JSON has no bigint: the vectors carry decimal strings, which both builders accept.
  const wire = (p: BuildAuthMessageParams): BuildAuthMessageParams => ({
    ...p,
    nonce: p.nonce === undefined ? undefined : String(p.nonce),
    issuedAt: p.issuedAt === undefined ? undefined : Number(p.issuedAt),
    deadline: p.deadline === undefined ? undefined : Number(p.deadline),
    delegateEpoch: p.delegateEpoch === undefined ? undefined : String(p.delegateEpoch),
  });
  const ok = (name: string, p: BuildAuthMessageParams) => ({ name, input: wire(p) });
  const bad = (name: string, p: BuildAuthMessageParams, errorContains: string) => ({
    name,
    input: wire(p),
    errorContains,
  });
  const defaults = (change: Partial<typeof DEFAULTS>) => ({
    ...input,
    sourceDefaults: { ...DEFAULTS, ...change },
  });
  return [
    ok('testnet-v1-request-hash', input),
    ok('pubnet-v1-request-hash', { ...input, sourceAsset: `stellar:pubnet/sep41:${TOKEN}` }),
    ok('standalone-network', { ...input, sourceAsset: `stellar:standalone/sep41:${TOKEN}` }),
    ok('depositor-is-a-contract-account', { ...input, depositor: contract(0xd1) }),
    ok('amount-at-i128-max', { ...input, maxSourceAmount: ((1n << 127n) - 1n).toString() }),
    ok('delegate-epoch-2', { ...input, delegateEpoch: 2n }),
    ok('delegate-epoch-u64-max', { ...input, delegateEpoch: (1n << 64n) - 1n }),
    ok('one-day-validity', { ...input, deadline: 1700000000n + 86400n }),
    bad(
      'unknown-network',
      { ...input, sourceAsset: `stellar:mainnet/sep41:${TOKEN}` },
      'network is not one the verifier knows',
    ),
    bad('no-escrow', defaults({ escrowContract: '' }), 'escrow contract was not supplied'),
    bad(
      'escrow-is-an-account',
      defaults({ escrowContract: account(0xc0) }),
      'escrow is not a contract (C...) address',
    ),
    bad(
      'muxed-depositor',
      { ...input, depositor: MUXED_CONTRACT },
      'depositor is not a G or C strkey',
    ),
    bad(
      'muxed-account-depositor',
      { ...input, depositor: MUXED_ACCOUNT },
      'depositor is not a G or C strkey',
    ),
    bad(
      'reserver-is-a-contract',
      defaults({ quoteSelector: contract(0x55) }),
      'reserver is not a G strkey',
    ),
    bad(
      'releaser-is-zero',
      defaults({ fulfillmentVerifierAccount: Address.account(new Uint8Array(32)).toString() }),
      'releaser is the zero key',
    ),
    ...['0x10', '0b1', ' 5', '+5', '5\n', '01250000', '', '1e3', '1_0'].map((amount, i) =>
      bad(
        `amount-not-plain-decimal-${i}`,
        { ...input, maxSourceAmount: amount },
        'invalid maxSourceAmount',
      ),
    ),
    ...['0x10', '', '+5', '01', ' 1', '1\n'].map((text, i) =>
      bad(
        `nonce-not-plain-decimal-${i}`,
        { ...input, nonce: text },
        'Stellar nonce must be a decimal integer string',
      ),
    ),
    bad('epoch-missing', { ...input, delegateEpoch: undefined }, 'needs delegateEpoch'),
    bad('epoch-zero', { ...input, delegateEpoch: 0n }, 'needs delegateEpoch'),
    bad('epoch-above-u64', { ...input, delegateEpoch: 1n << 64n }, 'needs delegateEpoch'),
    bad('epoch-not-decimal', { ...input, delegateEpoch: '0x1' }, 'needs delegateEpoch'),
    bad('zero-amount', { ...input, maxSourceAmount: '0' }, 'amount is zero'),
    bad(
      'amount-above-i128',
      { ...input, maxSourceAmount: (1n << 127n).toString() },
      'amount exceeds i128',
    ),
    bad('nonce-above-u64', { ...input, nonce: 1n << 64n }, 'Stellar nonce must fit'),
    bad(
      'deadline-not-after-issued-at',
      { ...input, deadline: 1700000000n },
      'deadline must be after issued_at',
    ),
    bad(
      'validity-over-a-day',
      { ...input, deadline: 1700000000n + 86401n },
      "exceeds the escrow's 86400s bound",
    ),
    // The permit amount is the chosen quote's source amount when one is set, as on the other chains.
    ok('quote-source-amount', { ...input, maxSourceAmount: '', quoteSourceAmount: '1250000' }),
    bad('quote-and-max-source-amount-both', { ...input, quoteSourceAmount: '1250000' }, 'not both'),
  ];
}

async function runBuild(
  v: BuildVector,
): Promise<{ messageHash?: string; messagePrehash?: string; error?: string }> {
  try {
    const out = await stellarAdapter.buildAuthMessage({
      ...v.input,
      // A text nonce is passed as written, so the builder's own decimal check is what refuses it.
      nonce: v.input.nonce,
      issuedAt: v.input.issuedAt === undefined ? undefined : BigInt(v.input.issuedAt),
      deadline: v.input.deadline === undefined ? undefined : BigInt(v.input.deadline),
      delegateEpoch: v.input.delegateEpoch,
    });
    expect(out.messageScheme).toBe('STELLAR');
    return { messageHash: out.messageHash, messagePrehash: out.messagePrehash };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** A built message signed by the delegate, as a full request the verifier reads as received. */
async function requestVectors(): Promise<RequestVector[]> {
  const requestId = 'req_stellar_request';
  const body = {
    version: '1.0',
    request_id: requestId,
    source: { asset_identifier: `stellar:testnet/sep41:${TOKEN}`, account: DEPOSITOR },
    destination: [PAYEE],
    fulfillment_amount: '1000000',
    max_source_amount: '1250000',
    quote_deadline: '2023-11-14T22:14:00.000Z',
    fulfillment_deadline: '2023-11-14T22:20:00.000Z',
    escrow_contract_address: ESCROW,
    quote_selector: RESERVER,
    fulfillment_verifier: { account: RELEASER, endpoint: DEFAULTS.fulfillmentVerifierEndpoint },
    fulfillment_proxy: DEFAULTS.fulfillmentProxy,
    sender_auth: {} as Record<string, unknown>,
  };
  const built = await stellarAdapter.buildAuthMessage({
    sourceAsset: body.source.asset_identifier,
    depositor: DEPOSITOR,
    maxSourceAmount: '1250000',
    sourceDefaults: DEFAULTS,
    paymentRequestJSON: JSON.stringify({ ...body, sender_auth: undefined }),
    nonce: 99n,
    issuedAt: 1700000000n,
    deadline: 1700000600n,
    delegateEpoch: 1n,
  });
  const signed: SignedMessageInput = {
    message: built.messageHash,
    message_prehash: built.messagePrehash,
    signature: '',
    payload: { delegate_signer: DELEGATE },
  };
  signed.signature = await stellarAdapter.sign(signed, Buffer.from(fill(0x77)).toString('hex'));
  // The same request from the delegate key's own account: signed by it, so an offline verifier admits it.
  const selfBody = { ...body, source: { ...body.source, account: DELEGATE } };
  const selfBuilt = await stellarAdapter.buildAuthMessage({
    sourceAsset: body.source.asset_identifier,
    depositor: DELEGATE,
    maxSourceAmount: '1250000',
    sourceDefaults: DEFAULTS,
    paymentRequestJSON: JSON.stringify({ ...selfBody, sender_auth: undefined }),
    nonce: 99n,
    issuedAt: 1700000000n,
    deadline: 1700000600n,
    delegateEpoch: 1n,
  });
  const selfSigned: SignedMessageInput = {
    message: selfBuilt.messageHash,
    message_prehash: selfBuilt.messagePrehash,
    signature: '',
    payload: { delegate_signer: DELEGATE },
  };
  selfSigned.signature = await stellarAdapter.sign(
    selfSigned,
    Buffer.from(fill(0x77)).toString('hex'),
  );
  const withAuth = (change: Record<string, unknown> = {}) =>
    JSON.stringify({
      ...body,
      ...change,
      sender_auth: { message_scheme: 'STELLAR', signed_messages: [signed] },
    });
  const expected = { escrowContract: ESCROW, reserver: RESERVER, releaser: RELEASER };
  return [
    {
      name: 'honest-request',
      request: JSON.stringify({
        ...selfBody,
        sender_auth: { message_scheme: 'STELLAR', signed_messages: [selfSigned] },
      }),
      expected,
      expect: { amount: '1250000' },
    },
    // Everything else holds, but the delegate is not the depositor: refused, never admitted offline.
    {
      name: 'separate-delegate',
      request: withAuth(),
      expected,
      expect: { delegateUnverified: true },
    },
    {
      name: 'payee-rewritten',
      request: withAuth({
        destination: [{ ...PAYEE, account: '0x1111111111111111111111111111111111111111' }],
      }),
      expected,
      expect: { outcome: 'destination_mismatch' },
    },
    {
      name: 'wrong-scheme',
      request: JSON.stringify({
        ...body,
        sender_auth: { message_scheme: 'SOLANA', signed_messages: [signed] },
      }),
      expected,
      expect: { outcome: 'scheme_mismatch' },
    },
    {
      name: 'unknown-network',
      request: withAuth({
        source: { asset_identifier: `stellar:mainnet/sep41:${TOKEN}`, account: DEPOSITOR },
      }),
      expected,
      expect: { outcome: 'scheme_mismatch' },
    },
    {
      name: 'no-expected-roles',
      request: withAuth(),
      expected: { escrowContract: ESCROW },
      expect: { outcome: 'verifier_misconfigured' },
    },
    {
      name: 'no-escrow-configured',
      request: withAuth(),
      expected: { reserver: RESERVER, releaser: RELEASER },
      expect: { outcome: 'verifier_misconfigured' },
    },
    {
      name: 'other-source-account',
      request: withAuth({
        source: { asset_identifier: body.source.asset_identifier, account: account(0xd2) },
      }),
      expected,
      expect: { outcome: 'signer_mismatch' },
    },
  ];
}

function runRequest(v: RequestVector): RequestVector['expect'] {
  try {
    const r = verifyPaymentRequestJSON(v.request, v.expected);
    return { amount: r.results[0]!.amount };
  } catch (e) {
    if (e instanceof DelegateUnverifiedError) return { delegateUnverified: true };
    const result = commitmentResultOf(e);
    if (result === undefined) throw e;
    return { outcome: result.outcome };
  }
}

// ─── The suite ───────────────────────────────────────────────────────────────

const COUNTS = { verify: 69, build: 41, requests: 8 };

if (process.env.REGEN_STELLAR_VECTORS) {
  describe('stellar conformance vectors: REGEN', () => {
    it('writes stellar-sender-auth-vectors.json', async () => {
      const verify = verifyVectors();
      const build = await Promise.all(
        buildVectors().map(async (v) => {
          const out = await runBuild(v);
          // A vector must come out as it was written: one that should be refused and builds, or is
          // refused for another reason, would otherwise be frozen as it happened to behave.
          if (out.error === undefined) {
            if (v.errorContains !== undefined) {
              throw new Error(
                `build vector ${v.name} should be refused (${v.errorContains}) but built`,
              );
            }
            return {
              name: v.name,
              input: v.input,
              messageHash: out.messageHash,
              messagePrehash: out.messagePrehash,
            };
          }
          if (v.errorContains === undefined || !out.error.includes(v.errorContains)) {
            throw new Error(
              `build vector ${v.name} was refused with "${out.error}", not "${v.errorContains}"`,
            );
          }
          return { name: v.name, input: v.input, errorContains: v.errorContains };
        }),
      );
      const requests = (await requestVectors()).map((v) => ({ ...v, expect: runRequest(v) }));
      writeFileSync(
        VECTORS_PATH,
        JSON.stringify({ _comment: COMMENT, verify, build, requests }, null, 2) + '\n',
      );
      expect(verify).toHaveLength(COUNTS.verify);
      expect(build).toHaveLength(COUNTS.build);
      expect(requests).toHaveLength(COUNTS.requests);
    });
  });
} else {
  const doc = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
    verify: VerifyVector[];
    build: BuildVector[];
    requests: RequestVector[];
  };

  describe('stellar conformance vectors (frozen)', () => {
    it('has every vector the Go suite counts', () => {
      expect(doc.verify).toHaveLength(COUNTS.verify);
      expect(doc.build).toHaveLength(COUNTS.build);
      expect(doc.requests).toHaveLength(COUNTS.requests);
    });

    it('anchors the golden case to the out-of-band digest and signature', () => {
      const golden = doc.verify.find((v) => v.name === 'golden-deposit-testnet')!;
      expect(golden.signed.message).toBe(GOLDEN_DIGEST);
      expect(golden.signed.signature).toBe(GOLDEN_SIGNATURE);
      expect(Buffer.from(DELEGATE_KEYS.publicKey).toString('hex')).toBe(GOLDEN_DELEGATE_PUBKEY);
      // The digest, the signature, the record and the commitment all verify; the delegate is not the
      // depositor, so the verdict is delegate_unverified, not an acceptance.
      expect(golden.expect).toEqual({ kind: 'DelegateUnverified' });
    });

    it.each(doc.verify.map((v) => [v.name, v] as const))('verify: %s', (_name, v) => {
      const got = run(v);
      if (v.expect.kind === 'Rejected') {
        expect(got.kind).toBe('Rejected');
        expect((got as { messageContains: string }).messageContains).toContain(
          v.expect.messageContains,
        );
      } else {
        expect(got).toEqual(v.expect);
      }
    });

    it.each(doc.build.map((v) => [v.name, v] as const))('build: %s', async (_name, v) => {
      const out = await runBuild(v);
      if (v.errorContains !== undefined) {
        expect(out.error).toContain(v.errorContains);
      } else {
        expect(out.error).toBeUndefined();
        expect(out.messageHash).toBe(v.messageHash);
        expect(out.messagePrehash).toBe(v.messagePrehash);
      }
    });

    it.each(doc.requests.map((v) => [v.name, v] as const))('request: %s', (_name, v) => {
      expect(runRequest(v)).toEqual(v.expect);
    });
  });
}
