import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Wallet, getBytes, hexlify, sha256, Signature } from 'ethers';
import { hashPermitWitnessTransferFrom } from '@atum-labs/evm-escrow-encoding';
import { hashTvmPermitWitnessTransferFrom } from '@atum-labs/tvm-escrow-encoding';
import { computeDepositHashV2 } from '@atum-labs/solana-escrow-encoding';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { getChainAdapter } from './adapters/index.js';
import { evmAdapter } from './adapters/evm.js';
import { tronAdapter } from './adapters/tron.js';
import { solanaAdapter } from './adapters/solana.js';
import {
  MalformedPrehashError,
  PermitAmountMismatchError,
  RecoveryFailedError,
  SignerMismatchError,
} from './errors.js';
import { CommitmentError, commitmentResultOf } from './commitment-rules.js';
import { readSolanaRecord, solanaEscrowDomain } from './commitment-solana.js';
import type { CommitmentExpectation, CommitmentOutcome } from './commitment-rules.js';
import {
  deterministicPermitNonce,
  deterministicSolanaNonce,
  deterministicFullRequestId,
  deterministicRequestId,
} from './utils.js';
import type { AuthTerms, SignedMessageInput, SourceRef, VerifyExpectations } from './types.js';
import {
  IDENTITY_POINT,
  SMALL_ORDER_KEY,
  nonCanonicalEd25519,
  smallOrderKeySignature,
  smallOrderRSignature,
} from './test-helpers.js';

// Frozen conformance vectors read by this test and the Go conformance test
// (../../go/sender-auth/senderauth/conformance_test.go), from the language-neutral
// v1/conformance/ directory. Each case must verify identically in both languages.
const VECTORS_PATH = resolve(__dirname, '../../../../conformance/sender-auth-vectors.json');
const COMMENT =
  'Frozen sender_auth conformance vectors. Verified by TS (bindings/typescript/sender-auth/src/conformance.test.ts) ' +
  'and Go (bindings/go/sender-auth/senderauth/conformance_test.go). Regenerate: REGEN_VECTORS=1 pnpm --filter ' +
  '@atum-labs/payment-request-sender-auth exec vitest run src/conformance.test.ts';

interface Vector {
  name: string;
  network: string;
  source: SourceRef;
  commitment: CommitmentExpectation;
  expected: VerifyExpectations;
  signed: SignedMessageInput;
  expectedTerms: AuthTerms;
}

/**
 * A frozen REJECT vector: an input both languages must reject identically. `call` selects the
 * entry point; `expect` is the error class the throw/error must map to (typed sentinel, or
 * `Rejected` for a generic bind rejection whose message both languages share via
 * `expectMessageContains`). This locks Go↔TS *reject*-parity, not just accept-parity.
 */
interface NegativeVector {
  name: string;
  network: string;
  call: 'recoverSigner' | 'recoverAndVerify';
  source: SourceRef;
  commitment?: CommitmentExpectation;
  expected?: VerifyExpectations;
  signed: SignedMessageInput;
  expect:
    | 'MalformedPrehash'
    | 'RecoveryFailed'
    | 'SignerMismatch'
    | 'Rejected'
    | 'PermitAmountMismatch'
    | 'Commitment';
  /** For `expect: "Commitment"` and `"MalformedPrehash"`: the commitment outcome both languages must report. */
  expectOutcome?: CommitmentOutcome;
  /** With `expectOutcome`: the commitment detail both languages must report. */
  expectDetail?: string;
  /** For `expect: "Rejected"`: the byte-identical substring both languages' error must contain. */
  expectMessageContains?: string;
}

/**
 * A frozen deterministic-nonce vector: fixed identity → fixed nonce. Asserted in Go and TS
 * so the derivation is byte-identical across languages (idempotency depends on it).
 */
interface NonceVector {
  name: string;
  kind: 'permit' | 'solana';
  requestId: string;
  depositor: string;
  /** Decimal string of the derived nonce. */
  expectedNonce: string;
}

function generateNonceVectors(): NonceVector[] {
  const inputs: Omit<NonceVector, 'expectedNonce'>[] = [
    {
      name: 'evm-permit-nonce',
      kind: 'permit',
      requestId: 'req_vec_evm',
      depositor: '0x5555555555555555555555555555555555555555',
    },
    {
      name: 'tron-permit-nonce',
      kind: 'permit',
      requestId: 'req_vec_tron',
      depositor: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    },
    {
      name: 'solana-deposit-nonce',
      kind: 'solana',
      requestId: 'req_vec_sol',
      depositor: 'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse',
    },
    // Case-invariance pair: a checksummed EVM depositor and its lowercase form must derive the
    // SAME nonce (0x hex is case-insensitive). The two entries below share requestId + underlying
    // address and differ only in casing, so their frozen expectedNonce must be identical; this
    // pins `canonicalDepositor` in both languages. The other EVM vector (0x5555…) has no
    // alphabetic hex and so cannot catch a missing canonicalization.
    {
      name: 'evm-permit-nonce-checksummed',
      kind: 'permit',
      requestId: 'req_vec_case',
      depositor: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
    },
    {
      name: 'evm-permit-nonce-lowercase',
      kind: 'permit',
      requestId: 'req_vec_case',
      depositor: '0xabcdef0123456789abcdef0123456789abcdef01',
    },
    // Same account again, but with an UPPERCASE `0X` prefix: canonicalization must lowercase the
    // prefix too, so this derives the SAME nonce as the pair above. Pins the `0X` branch of
    // `canonicalDepositor` in both languages — the pair only exercises the lowercase `0x` prefix.
    {
      name: 'evm-permit-nonce-uppercase-prefix',
      kind: 'permit',
      requestId: 'req_vec_case',
      depositor: '0XABCDEF0123456789ABCDEF0123456789ABCDEF01',
    },
  ];
  return inputs.map((i) => ({
    ...i,
    expectedNonce: (i.kind === 'solana'
      ? deterministicSolanaNonce({ requestId: i.requestId, depositor: i.depositor })
      : deterministicPermitNonce({ requestId: i.requestId, depositor: i.depositor })
    ).toString(),
  }));
}

/**
 * A frozen `request_id` vector. The request_id is the gateway's idempotency key, so it must
 * derive identically in both languages.
 */
interface RequestIdVector {
  name: string;
  anchor: string;
  account: string;
  prefix: string;
  expectedRequestId: string;
}

function generateRequestIdVectors(): RequestIdVector[] {
  const inputs: Omit<RequestIdVector, 'expectedRequestId'>[] = [
    {
      name: 'evm-request-id',
      anchor: 'order-4711',
      account: '0x5555555555555555555555555555555555555555',
      prefix: 'req_x402_',
    },
    {
      name: 'tron-request-id',
      anchor: 'order-4711',
      account: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      prefix: 'req_x402_',
    },
    {
      name: 'solana-request-id',
      anchor: 'order-4711',
      account: 'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse',
      prefix: 'req_mpp_',
    },
    // Case-invariance trio, mirroring the nonce vectors: the same EVM account in checksummed,
    // lowercase and `0X`-prefixed form must derive the SAME id in both languages, pinning
    // `canonicalDepositor` on this derivation too.
    {
      name: 'evm-request-id-checksummed',
      anchor: 'order-case',
      account: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
      prefix: 'req_x402_',
    },
    {
      name: 'evm-request-id-lowercase',
      anchor: 'order-case',
      account: '0xabcdef0123456789abcdef0123456789abcdef01',
      prefix: 'req_x402_',
    },
    {
      name: 'evm-request-id-uppercase-prefix',
      anchor: 'order-case',
      account: '0XABCDEF0123456789ABCDEF0123456789ABCDEF01',
      prefix: 'req_x402_',
    },
  ];
  return inputs.map((i) => ({ ...i, expectedRequestId: deterministicRequestId(i) }));
}

/** secp256k1 group order N. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Force a valid low-s secp256k1 signature into its non-canonical high-s (EIP-2) twin. */
function toHighS(signature: string): string {
  const sig = Signature.from(signature);
  const sHigh = (SECP256K1_N - BigInt(sig.s)).toString(16).padStart(64, '0');
  const v = sig.v.toString(16).padStart(2, '0');
  return '0x' + sig.r.slice(2) + sHigh + v;
}

function evmToTronAddress(evmAddress: string): string {
  const payload = new Uint8Array([0x41, ...getBytes(evmAddress)]);
  const checksum = getBytes(sha256(sha256(payload))).slice(0, 4);
  return bs58.encode(new Uint8Array([...payload, ...checksum]));
}
const b58 = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));

async function generateCases(): Promise<Vector[]> {
  const cases: Vector[] = [];

  // EVM — fixed key, fixed nonce, fixed absolute deadline (2030) for determinism.
  {
    const wallet = new Wallet('0x' + '11'.repeat(32));
    const defaults = {
      escrowContract: '0x1111111111111111111111111111111111111111',
      quoteSelector: '0x2222222222222222222222222222222222222222',
      fulfillmentVerifierAccount: '0x3333333333333333333333333333333333333333',
      fulfillmentVerifierEndpoint: 'https://verifier.example',
      fulfillmentProxy: '0x4444444444444444444444444444444444444444',
    };
    const TOKEN = '0x5555555555555555555555555555555555555555';
    const built = await evmAdapter.buildAuthMessage({
      sourceAsset: `eip155:1/erc20:${TOKEN}`,
      depositor: wallet.address,
      maxSourceAmount: '1000000',
      requestId: 'req_evm',
      sourceDefaults: defaults,
      nonce: 123n,
      deadline: 1924991999n,
      destinationAsset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      destinationAccount: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
    });
    const signed: SignedMessageInput = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
    };
    signed.signature = await evmAdapter.sign(signed, wallet.privateKey);
    const source: SourceRef = { network: 'eip155:1', asset: TOKEN, account: wallet.address };
    // Pin nowSec so the freshness check (deadline 2030) is clock-independent — otherwise the
    // frozen vector would start failing once the wall clock passes the deadline.
    const expected: VerifyExpectations = {
      ...defaults,
      maxSourceAmount: '1000000',
      reserver: defaults.quoteSelector,
      releaser: defaults.fulfillmentVerifierAccount,
      nowSec: 1700000000,
    };
    const commitment = commit(
      'req_evm',
      'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
    );
    const r = getChainAdapter('eip155:1').recoverAndVerify(signed, source, commitment, expected);
    cases.push({
      name: 'evm-permit2',
      network: 'eip155:1',
      source,
      commitment,
      expected,
      signed,
      expectedTerms: { amount: r.amount, deadlineSec: r.deadlineSec },
    });
  }

  // Tron — fixed key, fixed nonce, fixed absolute deadline (2030); permit2 falls back to pinned mainnet.
  {
    const wallet = new Wallet('0x' + '22'.repeat(32));
    const defaults = {
      escrowContract: 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp',
      quoteSelector: 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m',
      fulfillmentVerifierAccount: 'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S',
      fulfillmentVerifierEndpoint: 'https://verifier.example.com',
      fulfillmentProxy: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    };
    const TOKEN = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const built = await tronAdapter.buildAuthMessage({
      sourceAsset: `tron:mainnet/trc20:${TOKEN}`,
      depositor: 'unused',
      maxSourceAmount: '10000000',
      requestId: 'req_tron',
      sourceDefaults: defaults,
      nonce: 456n,
      deadline: 1924991999n,
      destinationAsset: 'tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      destinationAccount: 'TQ5NMqJjW8sTHhcNJ6VhVnQ2gPTBqLPRLB',
    });
    const signed: SignedMessageInput = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
    };
    signed.signature = await tronAdapter.sign(signed, wallet.privateKey);
    const source: SourceRef = {
      network: 'tron:mainnet',
      asset: TOKEN,
      account: evmToTronAddress(wallet.address),
    };
    const expected: VerifyExpectations = {
      ...defaults,
      maxSourceAmount: '10000000',
      reserver: defaults.quoteSelector,
      releaser: defaults.fulfillmentVerifierAccount,
      nowSec: 1700000000,
    };
    const commitment = commit(
      'req_tron',
      'tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      'TQ5NMqJjW8sTHhcNJ6VhVnQ2gPTBqLPRLB',
    );
    const r = getChainAdapter('tron:mainnet').recoverAndVerify(
      signed,
      source,
      commitment,
      expected,
    );
    cases.push({
      name: 'tron-tip712',
      network: 'tron:mainnet',
      source,
      commitment,
      expected,
      signed,
      expectedTerms: { amount: r.amount, deadlineSec: r.deadlineSec },
    });
  }

  // Solana — fixed seed, fixed clock (issued_at), deterministic nonce; fully byte-stable across regens.
  {
    const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const depositor = bs58.encode(kp.publicKey);
    const MINT = b58(9);
    const defaults = {
      escrowContract: b58(1),
      quoteSelector: b58(2),
      fulfillmentVerifierAccount: b58(3),
      fulfillmentVerifierEndpoint: 'https://verifier.example',
      fulfillmentProxy: b58(4),
      svmSignatureClusterId: 'devnet',
      svmSignatureDomainVersion: 5,
    };
    const built = await solanaAdapter.buildAuthMessage({
      sourceAsset: `solana:mainnet/spl:${MINT}`,
      depositor,
      maxSourceAmount: '1000000',
      requestId: 'req_sol',
      sourceDefaults: defaults,
      destinationAsset:
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo',
      destinationAccount: '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4',
      nonce: deterministicSolanaNonce({ requestId: 'req_sol', depositor }),
      solanaClockReader: async () => 1700000000n,
    });
    const signed: SignedMessageInput = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
      payload: { delegate_signer: depositor },
    };
    signed.signature = await solanaAdapter.sign(signed, bs58.encode(kp.secretKey));
    const source: SourceRef = { network: 'solana:mainnet', asset: MINT, account: depositor };
    const expected: VerifyExpectations = {
      ...defaults,
      maxSourceAmount: '1000000',
      reserver: defaults.quoteSelector,
      releaser: defaults.fulfillmentVerifierAccount,
    };
    const commitment = commit('req_sol', SOL_DESTINATION_ASSET, SOL_DESTINATION_ACCOUNT);
    const r = getChainAdapter('solana:mainnet').recoverAndVerify(
      signed,
      source,
      commitment,
      expected,
    );
    cases.push({
      name: 'solana-ed25519',
      network: 'solana:mainnet',
      source,
      commitment,
      expected,
      signed,
      expectedTerms: { amount: r.amount, deadlineSec: r.deadlineSec },
    });
  }

  // Solana at signature_domain_version 4, the lowest version that commits the destination.
  {
    const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4));
    const depositor = bs58.encode(kp.publicKey);
    const MINT = b58(9);
    const defaults = {
      escrowContract: b58(1),
      quoteSelector: b58(2),
      fulfillmentVerifierAccount: b58(3),
      fulfillmentVerifierEndpoint: 'https://verifier.example',
      fulfillmentProxy: b58(4),
      svmSignatureClusterId: 'devnet',
      svmSignatureDomainVersion: 4,
    };
    const built = await solanaAdapter.buildAuthMessage({
      sourceAsset: `solana:mainnet/spl:${MINT}`,
      depositor,
      maxSourceAmount: '1000000',
      requestId: 'req_sol_v2',
      sourceDefaults: defaults,
      // Base58 segments are case-significant and must survive composition byte-for-byte.
      destinationAsset:
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo',
      destinationAccount: '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4',
      nonce: deterministicSolanaNonce({ requestId: 'req_sol_v2', depositor }),
      solanaClockReader: async () => 1700000000n,
    });
    const signed: SignedMessageInput = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
      payload: { delegate_signer: depositor },
    };
    signed.signature = await solanaAdapter.sign(signed, bs58.encode(kp.secretKey));
    const source: SourceRef = { network: 'solana:mainnet', asset: MINT, account: depositor };
    const expected: VerifyExpectations = {
      ...defaults,
      maxSourceAmount: '1000000',
      reserver: defaults.quoteSelector,
      releaser: defaults.fulfillmentVerifierAccount,
    };
    const commitment = commit('req_sol_v2', SOL_DESTINATION_ASSET, SOL_DESTINATION_ACCOUNT);
    const r = getChainAdapter('solana:mainnet').recoverAndVerify(
      signed,
      source,
      commitment,
      expected,
    );
    cases.push({
      name: 'solana-ed25519-v2-destination',
      network: 'solana:mainnet',
      source,
      commitment,
      expected,
      signed,
      expectedTerms: { amount: r.amount, deadlineSec: r.deadlineSec },
    });

    // delegate_signer is optional: without it the signature is checked against the depositor.
    const withoutDelegate: SignedMessageInput = {
      message: signed.message,
      message_prehash: signed.message_prehash,
      signature: signed.signature,
    };
    const r2 = getChainAdapter('solana:mainnet').recoverAndVerify(
      withoutDelegate,
      source,
      commitment,
      expected,
    );
    cases.push({
      name: 'solana-ed25519-v2-without-delegate-signer',
      network: 'solana:mainnet',
      source,
      commitment,
      expected,
      signed: withoutDelegate,
      expectedTerms: { amount: r2.amount, deadlineSec: r2.deadlineSec },
    });
  }

  return cases;
}

async function generateNegativeCases(): Promise<NegativeVector[]> {
  const neg: NegativeVector[] = [];

  // ── EVM fixture (same key/defaults as the accept vector) ──
  const wallet = new Wallet('0x' + '11'.repeat(32));
  const defaults = {
    escrowContract: '0x1111111111111111111111111111111111111111',
    quoteSelector: '0x2222222222222222222222222222222222222222',
    fulfillmentVerifierAccount: '0x3333333333333333333333333333333333333333',
    fulfillmentVerifierEndpoint: 'https://verifier.example',
    fulfillmentProxy: '0x4444444444444444444444444444444444444444',
  };
  const TOKEN = '0x5555555555555555555555555555555555555555';
  const built = await evmAdapter.buildAuthMessage({
    sourceAsset: `eip155:1/erc20:${TOKEN}`,
    depositor: wallet.address,
    maxSourceAmount: '1000000',
    requestId: 'req_evm_neg',
    sourceDefaults: defaults,
    nonce: 123n,
    deadline: 1924991999n,
    destinationAsset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    destinationAccount: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
  });
  const signed: SignedMessageInput = {
    message: built.messageHash,
    message_prehash: built.messagePrehash,
    signature: '',
  };
  signed.signature = await evmAdapter.sign(signed, wallet.privateKey);
  const source: SourceRef = { network: 'eip155:1', asset: TOKEN, account: wallet.address };
  const expected: VerifyExpectations = {
    ...defaults,
    maxSourceAmount: '1000000',
    reserver: defaults.quoteSelector,
    releaser: defaults.fulfillmentVerifierAccount,
    nowSec: 1700000000,
  };
  const commitment = commit(
    'req_evm_neg',
    'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
  );

  neg.push({
    name: 'evm-wrong-signer',
    network: 'eip155:1',
    call: 'recoverSigner',
    source: { ...source, account: '0x9999999999999999999999999999999999999999' },
    signed,
    expect: 'SignerMismatch',
  });
  neg.push({
    name: 'evm-high-s-malleability',
    network: 'eip155:1',
    call: 'recoverSigner',
    source,
    signed: { ...signed, signature: toHighS(signed.signature) },
    expect: 'RecoveryFailed',
  });
  // A secp256k1 signature has one accepted spelling: 0x, 65 bytes, recovery id 0, 1, 27 or 28.
  for (const [label, spelled] of evmSignatureSpellings(signed.signature)) {
    neg.push({
      name: `evm-recover-signer-signature-${label}`,
      network: 'eip155:1',
      call: 'recoverSigner',
      source,
      signed: { ...signed, signature: spelled },
      expect: 'RecoveryFailed',
    });
    neg.push({
      name: `evm-signature-${label}`,
      network: 'eip155:1',
      call: 'recoverAndVerify',
      source,
      commitment,
      expected,
      signed: { ...signed, signature: spelled },
      expect: 'Commitment',
      expectOutcome: 'signer_mismatch',
    });
  }
  // recoverAndVerify authenticates key accounts off chain, so a contract account (ERC-1271), whose
  // deposit is signed by an owner key, is refused here and admitted by the payee check alone.
  neg.push({
    name: 'evm-contract-account-payer',
    network: 'eip155:1',
    call: 'recoverAndVerify',
    source: { ...source, account: '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe' },
    commitment,
    expected,
    signed,
    expect: 'Commitment',
    expectOutcome: 'signer_mismatch',
  });
  neg.push({
    name: 'evm-recover-signer-message-without-prefix',
    network: 'eip155:1',
    call: 'recoverSigner',
    source,
    signed: { ...signed, message: signed.message.slice(2) },
    expect: 'RecoveryFailed',
  });
  neg.push({
    name: 'evm-malformed-prehash',
    network: 'eip155:1',
    call: 'recoverAndVerify',
    source,
    commitment,
    expected,
    signed: { ...signed, message_prehash: 'not json' },
    expect: 'MalformedPrehash',
    expectOutcome: 'prehash_mismatch',
  });
  neg.push({
    name: 'evm-tampered-amount',
    network: 'eip155:1',
    call: 'recoverAndVerify',
    source,
    commitment,
    expected: { ...expected, maxSourceAmount: '999' },
    signed,
    expect: 'Rejected',
    expectMessageContains: 'permit amount does not match max_source_amount',
  });
  // A deposit that pays a chosen quote: the permit must authorize exactly the quote's
  // source_amount, which replaces max_source_amount.
  for (const [name, quote] of [
    ['evm-quote-amount-above-permit', '1000001'],
    ['evm-quote-amount-below-permit', '999999'],
  ] as const) {
    neg.push({
      name,
      network: 'eip155:1',
      call: 'recoverAndVerify',
      source,
      commitment,
      expected: { ...expected, maxSourceAmount: '', quoteSourceAmount: quote },
      signed,
      expect: 'PermitAmountMismatch',
      expectMessageContains: 'permit amount does not match the quote source_amount',
    });
  }
  neg.push({
    name: 'evm-quote-amount-with-max-source-amount',
    network: 'eip155:1',
    call: 'recoverAndVerify',
    source,
    commitment,
    expected: { ...expected, quoteSourceAmount: '1000000' },
    signed,
    expect: 'Commitment',
    expectOutcome: 'verifier_misconfigured',
  });
  for (const [label, quote] of [
    ['zero', '0'],
    ['leading-zero', '01000000'],
    ['exponent', '1e6'],
    ['plus-sign', '+1000000'],
    ['padded', ' 1000000'],
  ] as const) {
    neg.push({
      name: `evm-quote-amount-${label}`,
      network: 'eip155:1',
      call: 'recoverAndVerify',
      source,
      commitment,
      expected: { ...expected, maxSourceAmount: '', quoteSourceAmount: quote },
      signed,
      expect: 'Commitment',
      expectOutcome: 'verifier_misconfigured',
    });
  }
  neg.push({
    name: 'evm-stale-deadline',
    network: 'eip155:1',
    call: 'recoverAndVerify',
    source,
    commitment,
    expected: { ...expected, nowSec: 4000000000 },
    signed,
    expect: 'Rejected',
    expectMessageContains: 'permit deadline is not in the future',
  });
  // A chain id above the EIP-2294 maximum. Both bindings must refuse it at the same entry point,
  // since above it TS and Go would read the id differently.
  neg.push({
    name: 'evm-chain-id-above-max',
    network: 'eip155:1',
    call: 'recoverAndVerify',
    source: { ...source, network: 'eip155:9007199254740993' },
    commitment,
    expected,
    signed,
    expect: 'MalformedPrehash',
    expectOutcome: 'prehash_mismatch',
  });
  neg.push({
    name: 'evm-commitment-destination-mismatch',
    network: 'eip155:1',
    call: 'recoverAndVerify',
    source,
    commitment: {
      ...commitment,
      destinations: [
        { ...commitment.destinations[0]!, account: '0x1111111111111111111111111111111111111111' },
      ],
    },
    expected,
    signed,
    expect: 'Commitment',
    expectOutcome: 'destination_mismatch',
  });
  neg.push({
    name: 'evm-commitment-request-hash-mismatch',
    network: 'eip155:1',
    call: 'recoverAndVerify',
    source,
    commitment: { ...commitment, requestId: 'req_other' },
    expected,
    signed,
    expect: 'Commitment',
    expectOutcome: 'request_hash_mismatch',
  });
  const evmEdited = async (
    edit: (prehash: any) => void,
    resign = true,
  ): Promise<SignedMessageInput> => {
    const prehash = JSON.parse(signed.message_prehash!);
    edit(prehash);
    const out: SignedMessageInput = {
      message: signed.message,
      message_prehash: JSON.stringify(prehash),
      signature: signed.signature,
    };
    if (resign) {
      out.message = hashPermitWitnessTransferFrom(prehash);
      out.signature = await evmAdapter.sign(out, wallet.privateKey);
    }
    return out;
  };
  neg.push({
    name: 'evm-message-not-the-permit-digest',
    network: 'eip155:1',
    call: 'recoverAndVerify',
    source,
    commitment,
    expected,
    signed: { ...signed, message: '0x' + 'ab'.repeat(32) },
    expect: 'Commitment',
    expectOutcome: 'prehash_mismatch',
  });
  neg.push({
    name: 'evm-signed-destination-oversized',
    network: 'eip155:1',
    call: 'recoverAndVerify',
    source,
    commitment,
    expected,
    signed: await evmEdited((ph) => (ph.message.witness.destination = 'a'.repeat(300)), false),
    expect: 'Commitment',
    expectOutcome: 'destination_mismatch',
  });
  for (const [label, surrogate] of [
    ['high', 'ud800'],
    ['low', 'udc00'],
  ] as const) {
    neg.push({
      name: `evm-signed-destination-lone-${label}-surrogate`,
      network: 'eip155:1',
      call: 'recoverAndVerify',
      source,
      commitment,
      expected,
      signed: {
        ...signed,
        message_prehash: signed.message_prehash!.replace(
          '"destination":"',
          '"destination":"' + String.fromCharCode(0x5c) + surrogate,
        ),
      },
      expect: 'Commitment',
      expectOutcome: 'prehash_mismatch',
    });
  }
  neg.push({
    name: 'evm-signed-destination-not-string',
    network: 'eip155:1',
    call: 'recoverAndVerify',
    source,
    commitment,
    expected,
    signed: await evmEdited((ph) => (ph.message.witness.destination = 1), false),
    expect: 'MalformedPrehash',
    expectOutcome: 'prehash_mismatch',
  });
  neg.push({
    name: 'evm-request-hash-absent',
    network: 'eip155:1',
    call: 'recoverAndVerify',
    source,
    commitment,
    expected,
    signed: await evmEdited((ph) => delete ph.message.witness.depositRequestHash, false),
    expect: 'Commitment',
    expectOutcome: 'commitment_absent',
  });
  neg.push({
    name: 'evm-request-hash-malformed',
    network: 'eip155:1',
    call: 'recoverAndVerify',
    source,
    commitment,
    expected,
    signed: await evmEdited((ph) => (ph.message.witness.depositRequestHash = '0x12'), false),
    expect: 'MalformedPrehash',
    expectOutcome: 'prehash_mismatch',
  });
  neg.push({
    name: 'evm-permit2-override-not-an-address',
    network: 'eip155:1',
    call: 'recoverAndVerify',
    source,
    commitment,
    expected: { ...expected, permit2Contract: '0x12' },
    signed,
    expect: 'Rejected',
    expectMessageContains: 'is not an address',
  });
  neg.push({
    name: 'evm-deadline-beyond-safe-integer',
    network: 'eip155:1',
    call: 'recoverAndVerify',
    source,
    commitment,
    expected,
    signed: await evmEdited((ph) => (ph.message.deadline = (2n ** 53n).toString())),
    expect: 'MalformedPrehash',
    expectOutcome: 'prehash_mismatch',
  });

  // ── Tron fixture ──
  {
    const tronWallet = new Wallet('0x' + '22'.repeat(32));
    const tronDefaults = {
      escrowContract: 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp',
      quoteSelector: 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m',
      fulfillmentVerifierAccount: 'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S',
      fulfillmentVerifierEndpoint: 'https://verifier.example.com',
      fulfillmentProxy: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    };
    const tronToken = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const tronCommitment = commit(
      'req_tron_neg',
      'tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      'TQ5NMqJjW8sTHhcNJ6VhVnQ2gPTBqLPRLB',
    );
    const tronBuilt = await tronAdapter.buildAuthMessage({
      sourceAsset: `tron:mainnet/trc20:${tronToken}`,
      depositor: 'unused',
      maxSourceAmount: '10000000',
      requestId: tronCommitment.requestId,
      sourceDefaults: tronDefaults,
      nonce: 456n,
      deadline: 1924991999n,
      destinationAsset: tronCommitment.destinations[0]!.asset_identifier,
      destinationAccount: tronCommitment.destinations[0]!.account,
    });
    const tronSigned: SignedMessageInput = {
      message: tronBuilt.messageHash,
      message_prehash: tronBuilt.messagePrehash,
      signature: '',
    };
    tronSigned.signature = await tronAdapter.sign(tronSigned, tronWallet.privateKey);
    neg.push({
      name: 'tron-commitment-destination-mismatch',
      network: 'tron:mainnet',
      call: 'recoverAndVerify',
      source: {
        network: 'tron:mainnet',
        asset: tronToken,
        account: evmToTronAddress(tronWallet.address),
      },
      commitment: {
        ...tronCommitment,
        destinations: [
          { ...tronCommitment.destinations[0]!, account: 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m' },
        ],
      },
      expected: {
        ...tronDefaults,
        maxSourceAmount: '10000000',
        reserver: tronDefaults.quoteSelector,
        releaser: tronDefaults.fulfillmentVerifierAccount,
        nowSec: 1700000000,
      },
      signed: tronSigned,
      expect: 'Commitment',
      expectOutcome: 'destination_mismatch',
    });
    const tronSource: SourceRef = {
      network: 'tron:mainnet',
      asset: tronToken,
      account: evmToTronAddress(tronWallet.address),
    };
    for (const [label, spelled] of evmSignatureSpellings(tronSigned.signature)) {
      neg.push({
        name: `tron-recover-signer-signature-${label}`,
        network: 'tron:mainnet',
        call: 'recoverSigner',
        source: tronSource,
        signed: { ...tronSigned, signature: spelled },
        expect: 'RecoveryFailed',
      });
    }
    const tronExpected: VerifyExpectations = {
      ...tronDefaults,
      maxSourceAmount: '10000000',
      reserver: tronDefaults.quoteSelector,
      releaser: tronDefaults.fulfillmentVerifierAccount,
      nowSec: 1700000000,
    };
    for (const [name, quote] of [
      ['tron-quote-amount-above-permit', '10000001'],
      ['tron-quote-amount-below-permit', '9999999'],
    ] as const) {
      neg.push({
        name,
        network: 'tron:mainnet',
        call: 'recoverAndVerify',
        source: tronSource,
        commitment: tronCommitment,
        expected: { ...tronExpected, maxSourceAmount: '', quoteSourceAmount: quote },
        signed: tronSigned,
        expect: 'PermitAmountMismatch',
        expectMessageContains: 'permit amount does not match the quote source_amount',
      });
    }
    neg.push({
      name: 'tron-contract-account-payer',
      network: 'tron:mainnet',
      call: 'recoverAndVerify',
      source: { ...tronSource, account: 'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S' },
      commitment: tronCommitment,
      expected: tronExpected,
      signed: tronSigned,
      expect: 'Commitment',
      expectOutcome: 'signer_mismatch',
    });
    const tronResigned = async (edit: (prehash: any) => void): Promise<SignedMessageInput> => {
      const prehash = JSON.parse(tronSigned.message_prehash!);
      edit(prehash);
      const out: SignedMessageInput = {
        message: hashTvmPermitWitnessTransferFrom(prehash),
        message_prehash: JSON.stringify(prehash),
        signature: '',
      };
      out.signature = await tronAdapter.sign(out, tronWallet.privateKey);
      return out;
    };
    neg.push({
      name: 'tron-message-not-the-permit-digest',
      network: 'tron:mainnet',
      call: 'recoverAndVerify',
      source: tronSource,
      commitment: tronCommitment,
      expected: tronExpected,
      signed: { ...tronSigned, message: '0x' + 'ab'.repeat(32) },
      expect: 'Commitment',
      expectOutcome: 'prehash_mismatch',
    });
    neg.push({
      name: 'tron-malformed-prehash',
      network: 'tron:mainnet',
      call: 'recoverAndVerify',
      source: tronSource,
      commitment: tronCommitment,
      expected: tronExpected,
      signed: { ...tronSigned, message_prehash: 'not json' },
      expect: 'MalformedPrehash',
      expectOutcome: 'prehash_mismatch',
    });
    neg.push({
      name: 'tron-wrong-token',
      network: 'tron:mainnet',
      call: 'recoverAndVerify',
      source: { ...tronSource, asset: 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m' },
      commitment: tronCommitment,
      expected: tronExpected,
      signed: tronSigned,
      expect: 'Rejected',
      expectMessageContains: 'permit token does not match the source asset',
    });
    neg.push({
      name: 'tron-permit2-override-not-an-address',
      network: 'tron:mainnet',
      call: 'recoverAndVerify',
      source: tronSource,
      commitment: tronCommitment,
      expected: { ...tronExpected, permit2Contract: 'Tnot-an-address' },
      signed: tronSigned,
      expect: 'Rejected',
      expectMessageContains: 'is not a Tron address',
    });
    neg.push({
      name: 'tron-deadline-beyond-safe-integer',
      network: 'tron:mainnet',
      call: 'recoverAndVerify',
      source: tronSource,
      commitment: tronCommitment,
      expected: tronExpected,
      signed: await tronResigned((ph) => (ph.message.deadline = (2n ** 53n).toString())),
      expect: 'MalformedPrehash',
      expectOutcome: 'prehash_mismatch',
    });
  }

  // ── Solana fixture (same seed as the accept vector) ──
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
  const depositor = bs58.encode(kp.publicKey);
  const MINT = b58(9);
  const solDefaults = {
    escrowContract: b58(1),
    quoteSelector: b58(2),
    fulfillmentVerifierAccount: b58(3),
    fulfillmentVerifierEndpoint: 'https://verifier.example',
    fulfillmentProxy: b58(4),
    svmSignatureClusterId: 'devnet',
    svmSignatureDomainVersion: 5,
  };
  const builtSol = await solanaAdapter.buildAuthMessage({
    sourceAsset: `solana:mainnet/spl:${MINT}`,
    depositor,
    maxSourceAmount: '1000000',
    requestId: 'req_sol_neg',
    sourceDefaults: solDefaults,
    destinationAsset:
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo',
    destinationAccount: '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4',
    nonce: deterministicSolanaNonce({ requestId: 'req_sol_neg', depositor }),
    solanaClockReader: async () => 1700000000n,
  });
  const solSigned: SignedMessageInput = {
    message: builtSol.messageHash,
    message_prehash: builtSol.messagePrehash,
    signature: '',
    payload: { delegate_signer: depositor },
  };
  solSigned.signature = await solanaAdapter.sign(solSigned, bs58.encode(kp.secretKey));
  const solSource: SourceRef = { network: 'solana:mainnet', asset: MINT, account: depositor };
  const solExpected: VerifyExpectations = {
    ...solDefaults,
    maxSourceAmount: '1000000',
    reserver: solDefaults.quoteSelector,
    releaser: solDefaults.fulfillmentVerifierAccount,
  };
  const solCommitment = commit('req_sol_neg', SOL_DESTINATION_ASSET, SOL_DESTINATION_ACCOUNT);

  for (const [name, quote] of [
    ['solana-quote-amount-above-permit', '1000001'],
    ['solana-quote-amount-below-permit', '999999'],
  ] as const) {
    neg.push({
      name,
      network: 'solana:mainnet',
      call: 'recoverAndVerify',
      source: solSource,
      commitment: solCommitment,
      expected: { ...solExpected, maxSourceAmount: '', quoteSourceAmount: quote },
      signed: solSigned,
      expect: 'PermitAmountMismatch',
      expectMessageContains: 'permit amount does not match the quote source_amount',
    });
  }
  neg.push({
    name: 'solana-wrong-depositor',
    network: 'solana:mainnet',
    call: 'recoverSigner',
    source: { ...solSource, account: b58(7) },
    signed: solSigned,
    expect: 'SignerMismatch',
  });
  neg.push({
    name: 'solana-recover-signer-non-canonical-s',
    network: 'solana:mainnet',
    call: 'recoverSigner',
    source: solSource,
    signed: { ...solSigned, signature: nonCanonicalEd25519(solSigned.signature) },
    expect: 'SignerMismatch',
  });
  neg.push({
    name: 'solana-recover-signer-small-order-r',
    network: 'solana:mainnet',
    call: 'recoverSigner',
    source: solSource,
    signed: {
      ...solSigned,
      signature: smallOrderRSignature(solSigned.message, new Uint8Array(32).fill(3)),
    },
    expect: 'SignerMismatch',
  });
  neg.push({
    name: 'solana-recover-signer-small-order-key',
    network: 'solana:mainnet',
    call: 'recoverSigner',
    source: { ...solSource, account: SMALL_ORDER_KEY },
    signed: {
      ...solSigned,
      signature: smallOrderKeySignature(),
      payload: { delegate_signer: SMALL_ORDER_KEY },
    },
    expect: 'SignerMismatch',
  });
  for (const member of ['message', 'signature'] as const) {
    neg.push({
      name: `solana-recover-signer-${member}-without-prefix`,
      network: 'solana:mainnet',
      call: 'recoverSigner',
      source: solSource,
      signed: { ...solSigned, [member]: solSigned[member].slice(2) },
      expect: 'RecoveryFailed',
    });
  }
  // One delegate_signer rule everywhere: absent or null means the payer; anything else must be the payer.
  for (const [label, delegate] of [
    ['empty', ''],
    ['number', 1],
  ] as const) {
    neg.push({
      name: `solana-recover-signer-delegate-${label}`,
      network: 'solana:mainnet',
      call: 'recoverSigner',
      source: solSource,
      signed: { ...solSigned, payload: { delegate_signer: delegate } },
      expect: 'SignerMismatch',
    });
  }
  neg.push({
    name: 'solana-delegate-signer-not-the-payer',
    network: 'solana:mainnet',
    call: 'recoverAndVerify',
    source: solSource,
    commitment: solCommitment,
    expected: solExpected,
    signed: { ...solSigned, payload: { delegate_signer: b58(7) } },
    expect: 'Commitment',
    expectOutcome: 'signer_mismatch',
  });
  // The destination is committed from signature domain version 4, so a lower version is refused.
  neg.push({
    name: 'solana-domain-below-4',
    network: 'solana:mainnet',
    call: 'recoverAndVerify',
    source: solSource,
    commitment: solCommitment,
    expected: { ...solExpected, svmSignatureDomainVersion: 3 },
    signed: solSigned,
    expect: 'Commitment',
    expectOutcome: 'commitment_absent',
  });
  neg.push({
    name: 'solana-commitment-destination-mismatch',
    network: 'solana:mainnet',
    call: 'recoverAndVerify',
    source: solSource,
    commitment: {
      ...solCommitment,
      destinations: [{ ...solCommitment.destinations[0]!, account: b58(7) }],
    },
    expected: solExpected,
    signed: solSigned,
    expect: 'Commitment',
    expectOutcome: 'destination_mismatch',
  });
  const solDomain = {
    escrowProgramId: solDefaults.escrowContract,
    clusterId: 'devnet',
    domainVersion: 5,
  };
  const solEdited = (edit: (prehash: any) => void, resign = true): SignedMessageInput => {
    const prehash = JSON.parse(solSigned.message_prehash!);
    edit(prehash);
    const out: SignedMessageInput = { ...solSigned, message_prehash: JSON.stringify(prehash) };
    if (resign) {
      const record = readSolanaRecord(prehash);
      const domain = solanaEscrowDomain(solDomain);
      if (typeof record === 'string' || typeof domain === 'string')
        throw new Error('unreadable test record');
      out.message = hexlify(computeDepositHashV2(record.params, record.destination, domain));
      out.signature = hexlify(nacl.sign.detached(getBytes(out.message), kp.secretKey));
    }
    return out;
  };
  // The payer honestly signs a deposit that debits another account; only the depositor rule refuses it.
  neg.push({
    name: 'solana-depositor-not-the-payer',
    network: 'solana:mainnet',
    call: 'recoverAndVerify',
    source: solSource,
    commitment: solCommitment,
    expected: solExpected,
    signed: solEdited((ph) => (ph.depositor = b58(7))),
    expect: 'Commitment',
    expectOutcome: 'signer_mismatch',
  });
  neg.push({
    name: 'solana-message-not-the-deposit-hash',
    network: 'solana:mainnet',
    call: 'recoverAndVerify',
    source: solSource,
    commitment: solCommitment,
    expected: solExpected,
    signed: { ...solSigned, message: '0x' + 'ab'.repeat(32) },
    expect: 'Commitment',
    expectOutcome: 'prehash_mismatch',
  });
  neg.push({
    name: 'solana-malformed-prehash',
    network: 'solana:mainnet',
    call: 'recoverAndVerify',
    source: solSource,
    commitment: solCommitment,
    expected: solExpected,
    signed: { ...solSigned, message_prehash: 'not json' },
    expect: 'MalformedPrehash',
    expectOutcome: 'prehash_mismatch',
  });
  neg.push({
    name: 'solana-member-spelled-twice',
    network: 'solana:mainnet',
    call: 'recoverAndVerify',
    source: solSource,
    commitment: solCommitment,
    expected: solExpected,
    signed: solEdited((ph) => (ph.issuedAt = ph.issued_at), false),
    expect: 'MalformedPrehash',
    expectOutcome: 'prehash_mismatch',
  });
  neg.push({
    name: 'solana-destination-absent',
    network: 'solana:mainnet',
    call: 'recoverAndVerify',
    source: solSource,
    commitment: solCommitment,
    expected: solExpected,
    signed: solEdited((ph) => delete ph.destination, false),
    expect: 'Commitment',
    expectOutcome: 'commitment_absent',
  });
  neg.push({
    name: 'solana-request-hash-absent',
    network: 'solana:mainnet',
    call: 'recoverAndVerify',
    source: solSource,
    commitment: solCommitment,
    expected: solExpected,
    signed: solEdited((ph) => delete ph.deposit_request_hash, false),
    expect: 'Commitment',
    expectOutcome: 'commitment_absent',
  });
  neg.push({
    name: 'solana-domain-version-above-255',
    network: 'solana:mainnet',
    call: 'recoverAndVerify',
    source: solSource,
    commitment: solCommitment,
    expected: { ...solExpected, svmSignatureDomainVersion: 261 },
    signed: solSigned,
    expect: 'Commitment',
    expectOutcome: 'verifier_misconfigured',
  });
  neg.push({
    name: 'solana-deadline-beyond-safe-integer',
    network: 'solana:mainnet',
    call: 'recoverAndVerify',
    source: solSource,
    commitment: solCommitment,
    expected: solExpected,
    signed: solEdited((ph) => (ph.deadline = (2n ** 53n).toString())),
    expect: 'MalformedPrehash',
    expectOutcome: 'prehash_mismatch',
  });

  return neg;
}

const SOL_DESTINATION_ASSET =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo';
const SOL_DESTINATION_ACCOUNT = '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4';

/** Spellings of a valid secp256k1 signature that verifiers must refuse. */
function evmSignatureSpellings(signature: string): Array<[string, string]> {
  return [
    ['without-prefix', signature.slice(2)],
    ['upper-case-prefix', '0X' + signature.slice(2)],
    ['compact', Signature.from(signature).compactSerialized],
    ['eip155-recovery-id', signature.slice(0, 130) + '25'],
  ];
}

/** The commitment a fixture signed: its destination and request id. */
function commit(requestId: string, asset: string, account: string): CommitmentExpectation {
  return { destinations: [{ asset_identifier: asset, account }], requestId };
}

/** Runs a negative vector's call. */
function runNegative(v: NegativeVector): void {
  const adapter = getChainAdapter(v.network);
  if (v.call === 'recoverSigner') adapter.recoverSigner(v.signed, v.source);
  else adapter.recoverAndVerify(v.signed, v.source, v.commitment!, v.expected!);
}

/** The commitment detail a negative vector's refusal carries, recorded when the vectors are generated. */
function detailOf(v: NegativeVector): string {
  try {
    runNegative(v);
  } catch (e) {
    const detail = commitmentResultOf(e)?.detail;
    if (detail !== undefined) return detail;
  }
  throw new Error(`${v.name}: no commitment detail`);
}

/** Run a negative vector and assert it is rejected with the expected class. */
function assertRejected(v: NegativeVector): void {
  const run = () => runNegative(v);
  if (v.expectOutcome !== undefined) {
    let detail: string | undefined;
    try {
      run();
    } catch (e) {
      detail = commitmentResultOf(e)?.detail;
    }
    expect(detail).toBe(v.expectDetail);
  }
  switch (v.expect) {
    case 'MalformedPrehash': {
      let thrown: unknown;
      try {
        run();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(MalformedPrehashError);
      expect(commitmentResultOf(thrown)?.outcome).toBe(v.expectOutcome);
      break;
    }
    case 'RecoveryFailed':
      expect(run).toThrow(RecoveryFailedError);
      break;
    case 'SignerMismatch':
      expect(run).toThrow(SignerMismatchError);
      break;
    case 'Rejected':
      expect(run).toThrow(
        new RegExp(v.expectMessageContains!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      break;
    case 'PermitAmountMismatch':
      expect(run).toThrow(PermitAmountMismatchError);
      expect(run).toThrow(v.expectMessageContains!);
      break;
    case 'Commitment': {
      let outcome: string | undefined;
      try {
        run();
      } catch (e) {
        outcome =
          e instanceof CommitmentError
            ? e.result.outcome
            : `not a CommitmentError: ${(e as Error).message}`;
      }
      expect(outcome).toBe(v.expectOutcome);
      break;
    }
    default:
      throw new Error(`unknown expectation ${String(v.expect)}`);
  }
}

/** The number of vectors in each section; the Go suite asserts the same counts. */
const VECTOR_COUNTS = { cases: 5, negativeCases: 69, nonceVectors: 6, requestIdVectors: 6 };

if (process.env.REGEN_VECTORS) {
  describe('conformance vectors — REGEN', () => {
    it('writes vectors.json', async () => {
      const cases = await generateCases();
      const negativeCases = (await generateNegativeCases()).map((v) =>
        v.expectOutcome === undefined ? v : { ...v, expectDetail: detailOf(v) },
      );
      const nonceVectors = generateNonceVectors();
      const requestIdVectors = generateRequestIdVectors();
      writeFileSync(
        VECTORS_PATH,
        JSON.stringify(
          { _comment: COMMENT, cases, negativeCases, nonceVectors, requestIdVectors },
          null,
          2,
        ) + '\n',
      );
      expect(cases).toHaveLength(VECTOR_COUNTS.cases);
      expect(negativeCases).toHaveLength(VECTOR_COUNTS.negativeCases);
      expect(nonceVectors).toHaveLength(VECTOR_COUNTS.nonceVectors);
      expect(requestIdVectors).toHaveLength(VECTOR_COUNTS.requestIdVectors);
    });
  });
} else {
  const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
    cases: Vector[];
    negativeCases?: NegativeVector[];
    nonceVectors?: NonceVector[];
    requestIdVectors?: RequestIdVector[];
  };
  describe('conformance vectors — frozen (counts)', () => {
    it('carries every section in full', () => {
      expect(vectors.cases).toHaveLength(VECTOR_COUNTS.cases);
      expect(vectors.negativeCases).toHaveLength(VECTOR_COUNTS.negativeCases);
      expect(vectors.nonceVectors).toHaveLength(VECTOR_COUNTS.nonceVectors);
      expect(vectors.requestIdVectors).toHaveLength(VECTOR_COUNTS.requestIdVectors);
    });
  });
  describe('conformance vectors — frozen (accept)', () => {
    it.each(vectors.cases)('$name verifies against the frozen vector', (c) => {
      const r = getChainAdapter(c.network).recoverAndVerify(
        c.signed,
        c.source,
        c.commitment,
        c.expected,
      );
      expect({ amount: r.amount, deadlineSec: r.deadlineSec }).toEqual(c.expectedTerms);
    });
  });
  describe('conformance vectors — frozen (reject-parity)', () => {
    it.each(vectors.negativeCases ?? [])('$name is rejected as $expect', (v) => {
      assertRejected(v);
    });
  });
  describe('conformance vectors — frozen (deterministic request_id)', () => {
    it.each(vectors.requestIdVectors ?? [])('$name derives the frozen request_id', (v) => {
      expect(
        deterministicRequestId({ anchor: v.anchor, account: v.account, prefix: v.prefix }),
      ).toBe(v.expectedRequestId);
    });

    it.each(vectors.requestIdVectors ?? [])(
      '$name keeps the whole digest in the full request_id',
      (v) => {
        const full = deterministicFullRequestId({
          anchor: v.anchor,
          account: v.account,
          prefix: v.prefix,
        });
        expect(full).toMatch(new RegExp(`^${v.prefix}[0-9a-f]{64}$`));
        expect(full.startsWith(v.expectedRequestId)).toBe(true);
      },
    );

    it('derives an IDENTICAL request_id for checksummed, lowercased, and 0X-prefixed EVM accounts', () => {
      const find = (n: string) => (vectors.requestIdVectors ?? []).find((v) => v.name === n);
      const checksummed = find('evm-request-id-checksummed');
      const lowercase = find('evm-request-id-lowercase');
      const upperPrefix = find('evm-request-id-uppercase-prefix');
      expect(checksummed && lowercase && upperPrefix).toBeTruthy();
      // Pins canonicalDepositor on this derivation, inside the frozen set: a signer that returns a
      // different address casing on the retry must still derive the same idempotency key.
      expect(checksummed!.expectedRequestId).toBe(lowercase!.expectedRequestId);
      expect(upperPrefix!.expectedRequestId).toBe(lowercase!.expectedRequestId);
    });
  });

  describe('conformance vectors — frozen (deterministic nonce)', () => {
    it.each(vectors.nonceVectors ?? [])('$name derives the frozen nonce', (v) => {
      const nonce =
        v.kind === 'solana'
          ? deterministicSolanaNonce({ requestId: v.requestId, depositor: v.depositor })
          : deterministicPermitNonce({ requestId: v.requestId, depositor: v.depositor });
      expect(nonce.toString()).toBe(v.expectedNonce);
    });

    it('derives an IDENTICAL nonce for checksummed, lowercased, and 0X-prefixed EVM depositors', () => {
      const checksummed = (vectors.nonceVectors ?? []).find(
        (v) => v.name === 'evm-permit-nonce-checksummed',
      );
      const lowercase = (vectors.nonceVectors ?? []).find(
        (v) => v.name === 'evm-permit-nonce-lowercase',
      );
      const upperPrefix = (vectors.nonceVectors ?? []).find(
        (v) => v.name === 'evm-permit-nonce-uppercase-prefix',
      );
      expect(checksummed && lowercase && upperPrefix).toBeTruthy();
      // The frozen values must match, and each must equal a fresh derivation — pins that EVM
      // address casing (including an uppercase `0X` prefix) does not change the nonce
      // (canonicalDepositor), in the frozen set itself.
      expect(checksummed!.expectedNonce).toBe(lowercase!.expectedNonce);
      expect(upperPrefix!.expectedNonce).toBe(lowercase!.expectedNonce);
      expect(
        deterministicPermitNonce({
          requestId: checksummed!.requestId,
          depositor: checksummed!.depositor,
        }).toString(),
      ).toBe(
        deterministicPermitNonce({
          requestId: lowercase!.requestId,
          depositor: lowercase!.depositor,
        }).toString(),
      );
      expect(
        deterministicPermitNonce({
          requestId: upperPrefix!.requestId,
          depositor: upperPrefix!.depositor,
        }).toString(),
      ).toBe(
        deterministicPermitNonce({
          requestId: lowercase!.requestId,
          depositor: lowercase!.depositor,
        }).toString(),
      );
    });
  });
}

// The small-order vectors only prove something if plain ed25519 verification accepts them.
it('builds small-order forgeries that plain ed25519 verification accepts', () => {
  const digest = '0x' + '5a'.repeat(32);
  const seed = new Uint8Array(32).fill(3);
  const plain = (publicKey: Uint8Array, signature: string) =>
    nacl.sign.detached.verify(
      Buffer.from(digest.slice(2), 'hex'),
      Buffer.from(signature.slice(2), 'hex'),
      publicKey,
    );
  expect(plain(IDENTITY_POINT, smallOrderKeySignature())).toBe(true);
  expect(
    plain(nacl.sign.keyPair.fromSeed(seed).publicKey, smallOrderRSignature(digest, seed)),
  ).toBe(true);
});
