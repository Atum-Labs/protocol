import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Wallet, hexlify } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { computeDepositHashV2 } from '@atum-labs/solana-escrow-encoding';
import { isWellFormedText } from './commitment-rules.js';
import { hashPermitWitnessTransferFrom } from '@atum-labs/evm-escrow-encoding';
import { hashTvmPermitWitnessTransferFrom } from '@atum-labs/tvm-escrow-encoding';

import { evmAdapter } from './adapters/evm.js';
import { tronAdapter } from './adapters/tron.js';
import { solanaAdapter } from './adapters/solana.js';
import { readSolanaRecord, solanaEscrowDomain } from './commitment-solana.js';
import { deterministicSolanaNonce } from './utils.js';
import {
  buildEscrowDestination,
  deriveDepositRequestHash,
  MAX_DESTINATION_BYTES,
} from './destination.js';
import {
  CommitmentError,
  commitmentLogFields,
  compareCommitment,
  verifyCommitment,
  verifyRequestCommitment,
} from './commitment.js';
import type { CommitmentExpectation, CommitmentResult, SolanaDomain } from './commitment.js';
import type { ChainAdapter, SignedMessageInput } from './types.js';
import { SMALL_ORDER_KEY, smallOrderKeySignature, smallOrderRSignature } from './test-helpers.js';

// The shared vectors both languages assert. Regenerate with REGEN_COMMITMENT_VECTORS=1; inputs are
// fixed (keys, nonces, deadlines), so regeneration is byte-stable.
const VECTORS = resolve(__dirname, '../../../../conformance/commitment-vectors.json');
// Honest payments built by the Go SDK, written by the Go suite.
const GO_BUILT = resolve(__dirname, '../../../../conformance/commitment-go-built.json');

interface Want {
  outcome: CommitmentResult['outcome'];
  detailContains?: string;
  signedDestination?: string;
  expectedDestination?: string;
  signedDepositRequestHash?: string;
  expectedDepositRequestHash?: string;
}
interface RequestCase {
  name: string;
  request: string;
  solana: SolanaDomain | null;
  /** The verifier's own Tron chain ids, left out when none are supplied. */
  tronChainIds?: Record<string, number>;
  want: Want;
  /** The complete result, recorded at generation; Go must return exactly this. */
  result?: CommitmentResult;
}
interface CompareCase {
  name: string;
  signedDestination: string;
  signedDepositRequestHash: string;
  expected: CommitmentExpectation;
  want: Want;
  result?: CommitmentResult;
}
interface Vectors {
  _comment: string;
  requests: RequestCase[];
  compare: CompareCase[];
}

function outcomeOf(check: () => CommitmentResult): CommitmentResult {
  try {
    return check();
  } catch (e) {
    if (e instanceof CommitmentError) return e.result;
    throw e;
  }
}

function assertWant(result: CommitmentResult, want: Want): void {
  expect(result.outcome).toBe(want.outcome);
  if (want.detailContains !== undefined) expect(result.detail).toContain(want.detailContains);
  for (const key of [
    'signedDestination',
    'expectedDestination',
    'signedDepositRequestHash',
    'expectedDepositRequestHash',
  ] as const) {
    if (want[key] !== undefined) expect(result[key]).toBe(want[key]);
  }
}

// ─── Generation ──────────────────────────────────────────────────────────────

type Json = any;

interface Base {
  prefix: string;
  request: Json;
  wallet: Wallet;
  adapter: ChainAdapter;
  hash: (prehash: Json) => string;
  committed: string;
}

interface Mutation {
  prehash?: (prehash: Json) => void;
  prehashText?: (text: string) => string;
  /** Recompute the digest and signature over the edited prehash, as an honest but wrong payer would. */
  resign?: boolean;
  request?: (request: Json) => void;
  requestText?: (text: string) => string;
}

const EVM_DESTINATION_ASSET = 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const EVM_DESTINATION_ACCOUNT = '0xC0FFEE254729296a45a3885639AC7E10F9d54979';
const TRON_DESTINATION_ASSET = 'tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRON_DESTINATION_ACCOUNT = 'TQ5NMqJjW8sTHhcNJ6VhVnQ2gPTBqLPRLB';
const ATTACKER_EVM = '0x1111111111111111111111111111111111111111';
const ATTACKER_TRON = 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m';
/** Contract accounts whose deposits are signed by a separate owner key. */
const SAFE_EVM = '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe';
const SAFE_TRON = 'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S';
/**
 * The chain id of a local Tron node (tronbox/tre), which no built-in table knows. Above 2^31, so a
 * signed 32-bit reading of it would differ. Any id the table lacks would serve.
 */
const TRON_LOCALNET_CHAIN_ID = 0xc845df2f;

async function honestEvm(): Promise<Base> {
  const wallet = new Wallet('0x' + '11'.repeat(32));
  const token = '0x5555555555555555555555555555555555555555';
  const built = await evmAdapter.buildAuthMessage({
    sourceAsset: `eip155:1/erc20:${token}`,
    depositor: wallet.address,
    maxSourceAmount: '1000000',
    requestId: 'req_commit_evm',
    sourceDefaults: {
      escrowContract: '0x1111111111111111111111111111111111111111',
      quoteSelector: '0x2222222222222222222222222222222222222222',
      fulfillmentVerifierAccount: '0x3333333333333333333333333333333333333333',
      fulfillmentVerifierEndpoint: 'https://verifier.example',
      fulfillmentProxy: '0x4444444444444444444444444444444444444444',
    },
    nonce: 123n,
    deadline: 1924991999n,
    destinationAsset: EVM_DESTINATION_ASSET,
    destinationAccount: EVM_DESTINATION_ACCOUNT,
  });
  const signed: SignedMessageInput = {
    message: built.messageHash,
    message_prehash: built.messagePrehash,
    signature: '',
  };
  signed.signature = await evmAdapter.sign(signed, wallet.privateKey);
  return {
    prefix: 'evm',
    wallet,
    adapter: evmAdapter,
    hash: hashPermitWitnessTransferFrom,
    committed: buildEscrowDestination(EVM_DESTINATION_ASSET, EVM_DESTINATION_ACCOUNT),
    request: {
      request_id: 'req_commit_evm',
      source: { asset_identifier: `eip155:1/erc20:${token}`, account: wallet.address },
      destination: [{ asset_identifier: EVM_DESTINATION_ASSET, account: EVM_DESTINATION_ACCOUNT }],
      sender_auth: { message_scheme: built.messageScheme, signed_messages: [signed] },
    },
  };
}

async function honestTron(): Promise<Base> {
  const wallet = new Wallet('0x' + '22'.repeat(32));
  const token = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const built = await tronAdapter.buildAuthMessage({
    sourceAsset: `tron:mainnet/trc20:${token}`,
    depositor: 'unused',
    maxSourceAmount: '10000000',
    requestId: 'req_commit_tron',
    sourceDefaults: {
      escrowContract: 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp',
      quoteSelector: 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m',
      fulfillmentVerifierAccount: 'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S',
      fulfillmentVerifierEndpoint: 'https://verifier.example.com',
      fulfillmentProxy: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    },
    nonce: 456n,
    deadline: 1924991999n,
    destinationAsset: TRON_DESTINATION_ASSET,
    destinationAccount: TRON_DESTINATION_ACCOUNT,
  });
  const signed: SignedMessageInput = {
    message: built.messageHash,
    message_prehash: built.messagePrehash,
    signature: '',
  };
  signed.signature = await tronAdapter.sign(signed, wallet.privateKey);
  return {
    prefix: 'tron',
    wallet,
    adapter: tronAdapter,
    hash: hashTvmPermitWitnessTransferFrom,
    committed: buildEscrowDestination(TRON_DESTINATION_ASSET, TRON_DESTINATION_ACCOUNT),
    request: {
      request_id: 'req_commit_tron',
      source: {
        asset_identifier: `tron:mainnet/trc20:${token}`,
        account: 'TBvJUBXorwBPzqvV38vjDgegj5Eh6g2Tsq',
      },
      destination: [
        { asset_identifier: TRON_DESTINATION_ASSET, account: TRON_DESTINATION_ACCOUNT },
      ],
      sender_auth: { message_scheme: built.messageScheme, signed_messages: [signed] },
    },
  };
}

async function variant(base: Base, mutation: Mutation): Promise<string> {
  const request = structuredClone(base.request);
  const deposit = request.sender_auth.signed_messages[0];
  if (mutation.prehash || mutation.prehashText) {
    let text: string = deposit.message_prehash;
    if (mutation.prehash) {
      const prehash = JSON.parse(text);
      mutation.prehash(prehash);
      text = JSON.stringify(prehash);
    }
    if (mutation.prehashText) text = mutation.prehashText(text);
    deposit.message_prehash = text;
    if (mutation.resign) {
      deposit.message = base.hash(JSON.parse(text));
      deposit.signature = await base.adapter.sign(deposit, base.wallet.privateKey);
    }
  }
  if (mutation.request) mutation.request(request);
  const text = JSON.stringify(request);
  return mutation.requestText ? mutation.requestText(text) : text;
}

const BACKSLASH = String.fromCharCode(0x5c);
const LONE_SURROGATE_ESCAPE = BACKSLASH + 'ud800';
const withWitness = (prehash: Json, edit: (witness: Json) => void) => edit(prehash.message.witness);

async function generateVectors(): Promise<Vectors> {
  const requests: RequestCase[] = [];
  const add = (
    name: string,
    request: string,
    want: Want,
    solana: SolanaDomain | null = null,
    tronChainIds?: Record<string, number>,
  ) =>
    requests.push({
      name,
      request,
      solana,
      ...(tronChainIds === undefined ? {} : { tronChainIds }),
      want,
    });

  for (const base of [await honestEvm(), await honestTron()]) {
    const p = base.prefix;
    const attacker = p === 'evm' ? ATTACKER_EVM : ATTACKER_TRON;
    const destinationAsset = p === 'evm' ? EVM_DESTINATION_ASSET : TRON_DESTINATION_ASSET;
    const requestHash = deriveDepositRequestHash(base.request.request_id).toLowerCase();
    const honestWant: Want = {
      outcome: 'verified',
      signedDestination: base.committed,
      expectedDestination: base.committed,
      expectedDepositRequestHash: requestHash,
    };
    const v = (m: Mutation) => variant(base, m);

    add(`${p}-honest`, await v({}), honestWant);
    // A contract account (a Safe, via ERC-1271) pays with a signature from an owner key, so the
    // signer never recovers to the payer. Permit2 checks it on chain; the payee check admits it.
    add(
      `${p}-contract-account-payer`,
      await v({ request: (r) => (r.source.account = p === 'evm' ? SAFE_EVM : SAFE_TRON) }),
      honestWant,
    );
    add(
      `${p}-scheme-evm-permit2-escrow`,
      await v({ request: (r) => (r.sender_auth.message_scheme = 'EVM_PERMIT2_ESCROW') }),
      honestWant,
    );
    add(
      `${p}-scheme-tron`,
      await v({ request: (r) => (r.sender_auth.message_scheme = 'TRON') }),
      p === 'tron'
        ? honestWant
        : {
            outcome: 'scheme_mismatch',
            detailContains: 'cannot authorise a payment sourced on eip155',
          },
    );
    add(
      `${p}-scheme-relabelled-solana`,
      await v({ request: (r) => (r.sender_auth.message_scheme = 'SOLANA') }),
      { outcome: 'scheme_mismatch' },
    );
    add(`${p}-scheme-empty`, await v({ request: (r) => (r.sender_auth.message_scheme = '') }), {
      outcome: 'scheme_mismatch',
    });
    add(`${p}-scheme-absent`, await v({ request: (r) => delete r.sender_auth.message_scheme }), {
      outcome: 'scheme_mismatch',
    });
    add(
      `${p}-source-namespace-uppercase`,
      await v({
        request: (r) =>
          (r.source.asset_identifier = r.source.asset_identifier.replace(
            /^[a-z0-9]+/,
            (ns: string) => ns.toUpperCase(),
          )),
      }),
      { outcome: 'scheme_mismatch', detailContains: 'has no destination commitment rule' },
    );
    add(
      `${p}-source-chain-swapped`,
      await v({
        request: (r) =>
          (r.source.asset_identifier =
            p === 'evm'
              ? r.source.asset_identifier.replace('eip155:1/', 'eip155:137/')
              : r.source.asset_identifier.replace('tron:mainnet/', 'tron:shasta/')),
      }),
      { outcome: 'prehash_mismatch', detailContains: 'domain.chainId is not the source chain' },
    );
    add(
      `${p}-source-asset-invalid`,
      await v({
        request: (r) => (r.source.asset_identifier = r.source.asset_identifier.split('/')[0]),
      }),
      { outcome: 'scheme_mismatch', detailContains: 'is not a valid CAIP-19 asset' },
    );
    add(`${p}-no-sender-auth`, await v({ request: (r) => delete r.sender_auth }), {
      outcome: 'commitment_absent',
      detailContains: 'no signed messages',
    });
    add(
      `${p}-no-signed-messages`,
      await v({ request: (r) => (r.sender_auth.signed_messages = []) }),
      { outcome: 'commitment_absent', detailContains: 'no signed messages' },
    );
    add(
      `${p}-prehash-absent`,
      await v({ request: (r) => delete r.sender_auth.signed_messages[0].message_prehash }),
      { outcome: 'commitment_absent', detailContains: 'no message_prehash' },
    );
    add(
      `${p}-prehash-null`,
      await v({ request: (r) => (r.sender_auth.signed_messages[0].message_prehash = null) }),
      { outcome: 'commitment_absent', detailContains: 'no message_prehash' },
    );
    add(
      `${p}-prehash-blank`,
      await v({ request: (r) => (r.sender_auth.signed_messages[0].message_prehash = ' \n\t ') }),
      { outcome: 'commitment_absent', detailContains: 'no message_prehash' },
    );
    add(`${p}-prehash-not-json`, await v({ prehashText: (t) => t.slice(0, -1) }), {
      outcome: 'prehash_mismatch',
      detailContains: 'not a single valid JSON document',
    });
    add(`${p}-prehash-array`, await v({ prehashText: () => '[]' }), {
      outcome: 'prehash_mismatch',
      detailContains: 'the document is not an object',
    });
    add(
      `${p}-prehash-destination-twin`,
      await v({
        prehashText: (t) =>
          t.replace(
            '"witness":{',
            `"witness":{"Destination":${JSON.stringify(buildEscrowDestination(destinationAsset, attacker))},`,
          ),
      }),
      {
        outcome: 'prehash_mismatch',
        detailContains: 'differ only in letter case, at $.message.witness.destination',
      },
    );
    add(
      `${p}-prehash-context-twin`,
      await v({ prehashText: (t) => '{"@context":{"A":1,"a":2},' + t.slice(1) }),
      {
        outcome: 'prehash_mismatch',
        detailContains: 'differ only in letter case, at $.@context.a',
      },
    );
    add(
      `${p}-two-member-witness`,
      await v({
        prehash: (ph) =>
          withWitness(ph, (w) => {
            delete w.destination;
            delete w.depositRequestHash;
          }),
      }),
      { outcome: 'commitment_absent', detailContains: 'commits no destination' },
    );
    add(
      `${p}-destination-empty`,
      await v({ prehash: (ph) => withWitness(ph, (w) => (w.destination = '')) }),
      { outcome: 'commitment_absent', detailContains: 'commits no destination' },
    );
    add(
      `${p}-destination-whitespace`,
      await v({ prehash: (ph) => withWitness(ph, (w) => (w.destination = ' \t')) }),
      { outcome: 'commitment_absent', detailContains: 'commits no destination' },
    );
    add(
      `${p}-destination-null`,
      await v({ prehash: (ph) => withWitness(ph, (w) => (w.destination = null)) }),
      { outcome: 'commitment_absent', detailContains: 'commits no destination' },
    );
    add(
      `${p}-destination-number`,
      await v({ prehash: (ph) => withWitness(ph, (w) => (w.destination = 0)) }),
      { outcome: 'prehash_mismatch', detailContains: 'is not a string' },
    );
    add(
      `${p}-destination-object`,
      await v({ prehash: (ph) => withWitness(ph, (w) => (w.destination = {})) }),
      { outcome: 'prehash_mismatch', detailContains: 'is not a string' },
    );
    add(`${p}-witness-not-object`, await v({ prehash: (ph) => (ph.message.witness = 'x') }), {
      outcome: 'prehash_mismatch',
      detailContains: 'message.witness is not an object',
    });
    add(`${p}-message-null`, await v({ prehash: (ph) => (ph.message = null) }), {
      outcome: 'commitment_absent',
      detailContains: 'commits no destination',
    });
    add(
      `${p}-request-hash-absent`,
      await v({ prehash: (ph) => withWitness(ph, (w) => delete w.depositRequestHash) }),
      { outcome: 'commitment_absent', detailContains: 'commits no depositRequestHash' },
    );
    add(
      `${p}-request-hash-uppercase-prefix`,
      await v({
        prehash: (ph) =>
          withWitness(ph, (w) => (w.depositRequestHash = '0X' + w.depositRequestHash.slice(2))),
      }),
      { outcome: 'prehash_mismatch', detailContains: 'is not a 32-byte hex value' },
    );
    add(
      `${p}-request-hash-padded`,
      await v({
        prehash: (ph) =>
          withWitness(ph, (w) => (w.depositRequestHash = w.depositRequestHash + ' ')),
      }),
      { outcome: 'prehash_mismatch', detailContains: 'is not a 32-byte hex value' },
    );
    add(
      `${p}-request-hash-short`,
      await v({
        prehash: (ph) =>
          withWitness(ph, (w) => (w.depositRequestHash = w.depositRequestHash.slice(0, -1))),
      }),
      { outcome: 'prehash_mismatch', detailContains: 'is not a 32-byte hex value' },
    );
    add(
      `${p}-request-hash-bare-hex`,
      await v({
        prehash: (ph) =>
          withWitness(ph, (w) => (w.depositRequestHash = w.depositRequestHash.slice(2))),
      }),
      { ...honestWant, signedDepositRequestHash: requestHash.slice(2) },
    );
    add(
      `${p}-request-hash-uppercase-hex`,
      await v({
        prehash: (ph) =>
          withWitness(
            ph,
            (w) => (w.depositRequestHash = '0x' + w.depositRequestHash.slice(2).toUpperCase()),
          ),
      }),
      honestWant,
    );
    add(
      `${p}-payee-rewritten`,
      await v({ request: (r) => (r.destination[0].account = attacker) }),
      {
        outcome: 'destination_mismatch',
        detailContains: 'the payer signed a deposit payable to',
        signedDestination: base.committed,
        expectedDestination: buildEscrowDestination(destinationAsset, attacker),
      },
    );
    // The order of the checks, which this arm spells out for itself. Mirrors the compare-order
    // vectors. The signed hash is parsed before the destination is compared, so a rewritten payee
    // whose hash is unreadable is refused for the hash, and no destination is composed. (An
    // unreadable hash cannot be signed over, so that digest is stale too; the digest is bound only
    // after both checks.) A readable hash is compared only after the destination, so a rewritten
    // payee is named as one even when the payer signed a hash for another request as well.
    add(
      `${p}-order-hash-parsed-before-destination`,
      await v({
        prehash: (ph) => withWitness(ph, (w) => (w.depositRequestHash = 'garbage')),
        request: (r) => (r.destination[0].account = attacker),
      }),
      {
        outcome: 'prehash_mismatch',
        detailContains: 'is not a 32-byte hex value',
        expectedDestination: '',
      },
    );
    add(
      `${p}-order-destination-before-hash-value`,
      await v({
        prehash: (ph) =>
          withWitness(
            ph,
            (w) => (w.depositRequestHash = deriveDepositRequestHash('req_other').toLowerCase()),
          ),
        resign: true,
        request: (r) => (r.destination[0].account = attacker),
      }),
      {
        outcome: 'destination_mismatch',
        detailContains: 'the payer signed a deposit payable to',
        signedDestination: base.committed,
        expectedDestination: buildEscrowDestination(destinationAsset, attacker),
        expectedDepositRequestHash: '',
      },
    );
    add(
      `${p}-asset-rewritten`,
      await v({
        request: (r) =>
          (r.destination[0].asset_identifier =
            p === 'evm'
              ? 'eip155:8453/erc20:0x0000000000000000000000000000000000000001'
              : 'tron:0x2b6653dc/trc20:TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp'),
      }),
      { outcome: 'destination_mismatch', detailContains: 'the payer signed a deposit payable to' },
    );
    add(`${p}-two-legs`, await v({ request: (r) => r.destination.push({ ...r.destination[0] }) }), {
      outcome: 'destination_mismatch',
      detailContains: 'names 2 destinations',
    });
    add(`${p}-no-legs`, await v({ request: (r) => (r.destination = []) }), {
      outcome: 'destination_mismatch',
      detailContains: 'names 0 destinations',
    });
    add(
      `${p}-leg-not-committable`,
      await v({ request: (r) => (r.destination[0].account = 'a@b') }),
      { outcome: 'destination_mismatch', detailContains: 'cannot be committed to' },
    );
    add(
      `${p}-signed-destination-padded`,
      await v({
        prehash: (ph) => withWitness(ph, (w) => (w.destination = ' ' + w.destination)),
        resign: true,
      }),
      {
        outcome: 'destination_mismatch',
        detailContains: 'the payer signed a deposit payable to',
        signedDestination: ' ' + base.committed,
      },
    );
    add(
      `${p}-signed-destination-case-changed`,
      await v({
        prehash: (ph) =>
          withWitness(
            ph,
            (w) =>
              (w.destination =
                p === 'evm'
                  ? w.destination
                      .toUpperCase()
                      .replace('EIP155', 'eip155')
                      .replace('ERC20', 'erc20')
                  : w.destination.replace('@TQ5N', '@tQ5N')),
          ),
        resign: true,
      }),
      { outcome: 'destination_mismatch', detailContains: 'the payer signed a deposit payable to' },
    );
    add(
      `${p}-signed-destination-not-well-formed`,
      await v({
        prehashText: (t) => t.replace(`"destination":"`, `"destination":"${LONE_SURROGATE_ESCAPE}`),
      }),
      { outcome: 'prehash_mismatch', detailContains: 'not well-formed text' },
    );
    add(`${p}-request-id-changed`, await v({ request: (r) => (r.request_id = 'req_other') }), {
      outcome: 'request_hash_mismatch',
      detailContains: 'is not keccak256 of request_id',
    });
    add(`${p}-request-id-empty`, await v({ request: (r) => (r.request_id = '') }), {
      outcome: 'request_hash_mismatch',
      detailContains: 'request_id is empty',
    });
    add(
      `${p}-request-id-not-well-formed`,
      await v({
        requestText: (t) => t.replace(`"request_id":"`, `"request_id":"${LONE_SURROGATE_ESCAPE}`),
      }),
      { outcome: 'request_hash_mismatch', detailContains: 'not well-formed text' },
    );
    add(
      `${p}-witness-rewritten-not-resigned`,
      await v({
        prehash: (ph) =>
          withWitness(
            ph,
            (w) => (w.destination = buildEscrowDestination(destinationAsset, attacker)),
          ),
        request: (r) => (r.destination[0].account = attacker),
      }),
      {
        outcome: 'prehash_mismatch',
        detailContains: 'the signed digest is not the EIP-712 hash of message_prehash',
      },
    );
    add(
      `${p}-verifying-contract-changed`,
      await v({ prehash: (ph) => (ph.domain.verifyingContract = '0x' + '9'.repeat(40)) }),
      {
        outcome: 'prehash_mismatch',
        detailContains: 'the signed digest is not the EIP-712 hash of message_prehash',
      },
    );
    add(
      `${p}-digest-padded`,
      await v({
        request: (r) =>
          (r.sender_auth.signed_messages[0].message =
            ' ' + r.sender_auth.signed_messages[0].message),
      }),
      { outcome: 'prehash_mismatch', detailContains: 'is not a 32-byte hex digest' },
    );
    add(
      `${p}-digest-empty`,
      await v({ request: (r) => (r.sender_auth.signed_messages[0].message = '') }),
      { outcome: 'prehash_mismatch', detailContains: 'is not a 32-byte hex digest' },
    );
    add(
      `${p}-digest-uppercase-hex`,
      await v({
        request: (r) =>
          (r.sender_auth.signed_messages[0].message =
            '0x' + r.sender_auth.signed_messages[0].message.slice(2).toUpperCase()),
      }),
      honestWant,
    );
    add(
      `${p}-primary-type-changed`,
      await v({ prehash: (ph) => (ph.primaryType = 'TokenPermissions') }),
      {
        outcome: 'prehash_mismatch',
        detailContains: 'primaryType is not PermitWitnessTransferFrom',
      },
    );
    add(
      `${p}-types-extra-member`,
      await v({ prehash: (ph) => ph.types.DepositWitness.push({ name: 'memo', type: 'string' }) }),
      {
        outcome: 'prehash_mismatch',
        detailContains: 'types are not the Permit2 deposit witness types',
      },
    );
    add(
      `${p}-types-with-domain-type`,
      await v({
        prehash: (ph) =>
          (ph.types.EIP712Domain = [
            { name: 'name', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ]),
      }),
      honestWant,
    );
    add(
      `${p}-domain-extra-fields`,
      await v({ prehash: (ph) => Object.assign(ph.domain, { version: '', salt: '' }) }),
      honestWant,
    );
    add(
      `${p}-amount-json-number`,
      await v({
        prehash: (ph) => (ph.message.permitted.amount = Number(ph.message.permitted.amount)),
      }),
      {
        outcome: 'prehash_mismatch',
        detailContains: 'message.permitted.amount is not a decimal integer string',
      },
    );
    add(
      `${p}-amount-exponent`,
      await v({ prehash: (ph) => (ph.message.permitted.amount = '1e6') }),
      { outcome: 'prehash_mismatch', detailContains: 'is not a decimal integer string' },
    );
    add(
      `${p}-amount-negative`,
      await v({ prehash: (ph) => (ph.message.permitted.amount = '-1') }),
      { outcome: 'prehash_mismatch', detailContains: 'is not a decimal integer string' },
    );
    add(
      `${p}-nonce-leading-zero`,
      await v({ prehash: (ph) => (ph.message.nonce = '0' + ph.message.nonce) }),
      {
        outcome: 'prehash_mismatch',
        detailContains: 'message.nonce is not a decimal integer string',
      },
    );
    add(
      `${p}-deadline-over-uint256`,
      await v({ prehash: (ph) => (ph.message.deadline = (1n << 256n).toString()) }),
      { outcome: 'prehash_mismatch', detailContains: 'exceeds uint256' },
    );
    add(`${p}-spender-not-address`, await v({ prehash: (ph) => (ph.message.spender = '0x1234') }), {
      outcome: 'prehash_mismatch',
      detailContains: 'message.spender is not a 0x-prefixed 20-byte hex address',
    });
    // Address case never changes a digest, so an invalid EIP-55 checksum must not refuse a payment.
    add(
      `${p}-address-case-ignored`,
      await v({
        prehash: (ph) =>
          (ph.domain.verifyingContract = '0x' + ph.domain.verifyingContract.slice(2).toUpperCase()),
      }),
      honestWant,
    );
    add(`${p}-domain-chain-id-lie`, await v({ prehash: (ph) => (ph.domain.chainId = '0x89') }), {
      outcome: 'prehash_mismatch',
      detailContains: 'domain.chainId is not the source chain',
    });
    add(
      `${p}-domain-chain-id-leading-zero`,
      await v({ prehash: (ph) => (ph.domain.chainId = '0x0' + ph.domain.chainId.slice(2)) }),
      { outcome: 'prehash_mismatch', detailContains: 'domain.chainId is not the source chain' },
    );
    add(`${p}-domain-name-lie`, await v({ prehash: (ph) => (ph.domain.name = 'Permit3') }), {
      outcome: 'prehash_mismatch',
      detailContains: 'domain.name is not Permit2',
    });
    add(`${p}-domain-version-set`, await v({ prehash: (ph) => (ph.domain.version = '1') }), {
      outcome: 'prehash_mismatch',
      detailContains: 'domain.version must be empty',
    });
    add(`${p}-extra-message-member`, await v({ prehash: (ph) => (ph.message.memo = 'x') }), {
      outcome: 'prehash_mismatch',
      detailContains: 'message carries a member the Permit2 deposit typed data does not define',
    });
    add(
      `${p}-extra-witness-member`,
      await v({ prehash: (ph) => (ph.message.witness.memo = 'x') }),
      { outcome: 'prehash_mismatch', detailContains: 'message.witness carries a member' },
    );
    add(`${p}-extra-top-level-member`, await v({ prehash: (ph) => (ph.memo = 'x') }), {
      outcome: 'prehash_mismatch',
      detailContains: 'the typed data carries a member',
    });
    add(`${p}-types-reordered`, await v({ prehash: (ph) => ph.types.DepositWitness.reverse() }), {
      outcome: 'prehash_mismatch',
      detailContains: 'types are not the Permit2 deposit witness types',
    });
    add(`${p}-types-missing`, await v({ prehash: (ph) => delete ph.types.TokenPermissions }), {
      outcome: 'prehash_mismatch',
      detailContains: 'types are not the Permit2 deposit witness types',
    });
    // Only signed_messages[0] is the deposit; a later message is not what any consumer deposits.
    add(
      `${p}-second-signed-message-ignored`,
      await v({
        request: (r) =>
          r.sender_auth.signed_messages.push({
            message: '0x' + '00'.repeat(32),
            signature: '0x',
            message_prehash: '{}',
          }),
      }),
      honestWant,
    );
    add(
      `${p}-split-surrogate-destination`,
      await v({
        prehashText: (t) =>
          t.replace(
            `"destination":"`,
            `"destination":"${BACKSLASH}ud83d${String.fromCharCode(0xde00)}`,
          ),
      }),
      { outcome: 'prehash_mismatch', detailContains: 'not well-formed text' },
    );
    add(
      `${p}-split-surrogate-request-id`,
      await v({
        requestText: (t) =>
          t.replace(
            `"request_id":"`,
            `"request_id":"${BACKSLASH}ud83d${String.fromCharCode(0xde00)}`,
          ),
      }),
      { outcome: 'request_hash_mismatch', detailContains: 'not well-formed text' },
    );
    add(
      `${p}-request-twin`,
      await v({
        requestText: (t) =>
          t.replace(
            '"destination":[',
            `"Destination":[{"asset_identifier":${JSON.stringify(destinationAsset)},"account":${JSON.stringify(attacker)}}],"destination":[`,
          ),
      }),
      {
        outcome: 'request_malformed',
        detailContains: 'differ only in letter case, at $.destination',
      },
    );
    add(`${p}-request-not-json`, await v({ requestText: (t) => t.slice(0, -1) }), {
      outcome: 'request_malformed',
      detailContains: 'not a single valid JSON document',
    });
    add(
      `${p}-request-destination-not-array`,
      await v({ request: (r) => (r.destination = r.destination[0]) }),
      { outcome: 'request_malformed', detailContains: 'destination is not an array' },
    );
    add(`${p}-request-id-not-string`, await v({ request: (r) => (r.request_id = 7) }), {
      outcome: 'request_malformed',
      detailContains: 'request_id is not a string',
    });
    // An absent request_id is a request of the wrong shape, as a non-string one is. It is not read as
    // an empty id, which would be refused for the hash instead.
    add(`${p}-request-id-absent`, await v({ request: (r) => delete r.request_id }), {
      outcome: 'request_malformed',
      detailContains: 'request_id is not a string',
    });
    add(`${p}-request-source-absent`, await v({ request: (r) => delete r.source }), {
      outcome: 'request_malformed',
      detailContains: 'source is not an object',
    });
    add(
      `${p}-request-prehash-object`,
      await v({
        request: (r) =>
          (r.sender_auth.signed_messages[0].message_prehash = JSON.parse(
            r.sender_auth.signed_messages[0].message_prehash,
          )),
      }),
      { outcome: 'request_malformed', detailContains: 'message_prehash is not a string' },
    );
    add(`${p}-request-not-object`, await v({ requestText: () => '[]' }), {
      outcome: 'request_malformed',
      detailContains: 'the document is not an object',
    });
    // JSON null is not an object either, although JavaScript's typeof calls it one.
    add(`${p}-request-null`, await v({ requestText: () => 'null' }), {
      outcome: 'request_malformed',
      detailContains: 'the document is not an object',
    });
    add(
      `${p}-request-source-asset-not-string`,
      await v({ request: (r) => (r.source.asset_identifier = 1) }),
      { outcome: 'request_malformed', detailContains: 'source.asset_identifier is not a string' },
    );
    add(
      `${p}-request-source-account-not-string`,
      await v({ request: (r) => (r.source.account = null) }),
      { outcome: 'request_malformed', detailContains: 'source.account is not a string' },
    );
    add(`${p}-request-leg-not-object`, await v({ request: (r) => (r.destination = ['x']) }), {
      outcome: 'request_malformed',
      detailContains: 'destination[0] is not an object',
    });
    add(
      `${p}-request-leg-account-not-string`,
      await v({ request: (r) => (r.destination[0].account = ['x']) }),
      {
        outcome: 'request_malformed',
        detailContains: 'asset_identifier and account must be strings',
      },
    );
    add(`${p}-request-sender-auth-not-object`, await v({ request: (r) => (r.sender_auth = 'x') }), {
      outcome: 'request_malformed',
      detailContains: 'sender_auth is not an object',
    });
    add(
      `${p}-request-scheme-not-string`,
      await v({ request: (r) => (r.sender_auth.message_scheme = 0) }),
      { outcome: 'request_malformed', detailContains: 'message_scheme is not a string' },
    );
    // A null member reads as absent, not as a member of the wrong type.
    add(
      `${p}-request-scheme-null`,
      await v({ request: (r) => (r.sender_auth.message_scheme = null) }),
      { outcome: 'scheme_mismatch' },
    );
    add(
      `${p}-request-signed-messages-not-array`,
      await v({ request: (r) => (r.sender_auth.signed_messages = {}) }),
      { outcome: 'request_malformed', detailContains: 'signed_messages is not an array' },
    );
    add(
      `${p}-request-signed-message-not-object`,
      await v({ request: (r) => (r.sender_auth.signed_messages = ['x']) }),
      { outcome: 'request_malformed', detailContains: 'signed_messages[0] is not an object' },
    );
    add(
      `${p}-request-message-not-string`,
      await v({ request: (r) => (r.sender_auth.signed_messages[0].message = 0) }),
      { outcome: 'request_malformed', detailContains: '.message is not a string' },
    );
    add(
      `${p}-request-message-null`,
      await v({ request: (r) => (r.sender_auth.signed_messages[0].message = null) }),
      { outcome: 'prehash_mismatch', detailContains: 'is not a 32-byte hex digest' },
    );
    add(
      `${p}-request-signature-not-string`,
      await v({ request: (r) => (r.sender_auth.signed_messages[0].signature = 0) }),
      { outcome: 'request_malformed', detailContains: '.signature is not a string' },
    );
    // An absent signature still verifies: on EVM and Tron the commitment check verifies no
    // signature; Permit2 does, on chain.
    add(
      `${p}-request-signature-null`,
      await v({ request: (r) => (r.sender_auth.signed_messages[0].signature = null) }),
      honestWant,
    );
    add(
      `${p}-request-payload-not-object`,
      await v({ request: (r) => (r.sender_auth.signed_messages[0].payload = '') }),
      { outcome: 'request_malformed', detailContains: '.payload is not an object' },
    );
    add(
      `${p}-request-payload-null`,
      await v({ request: (r) => (r.sender_auth.signed_messages[0].payload = null) }),
      honestWant,
    );
    add(
      `${p}-source-chain-reference-non-canonical`,
      await v({
        request: (r) =>
          (r.source.asset_identifier =
            p === 'evm'
              ? r.source.asset_identifier.replace('eip155:1/', 'eip155:01/')
              : r.source.asset_identifier.replace('tron:mainnet/', 'tron:0x2b6653dc/')),
      }),
      {
        outcome: 'scheme_mismatch',
        detailContains: `is not a supported ${p === 'evm' ? 'eip155' : 'tron'} network`,
      },
    );
    add(`${p}-domain-not-object`, await v({ prehash: (ph) => (ph.domain = 'x') }), {
      outcome: 'prehash_mismatch',
    });
    add(`${p}-permitted-not-object`, await v({ prehash: (ph) => (ph.message.permitted = 'x') }), {
      outcome: 'prehash_mismatch',
    });
    add(`${p}-types-absent`, await v({ prehash: (ph) => delete ph.types }), {
      outcome: 'prehash_mismatch',
    });
    add(`${p}-types-not-object`, await v({ prehash: (ph) => (ph.types = []) }), {
      outcome: 'prehash_mismatch',
    });
    add(
      `${p}-leg-non-ascii`,
      await v({ request: (r) => (r.destination[0].account = r.destination[0].account + '\u0130') }),
      { outcome: 'destination_mismatch', detailContains: 'must be printable ASCII' },
    );
    add(
      `${p}-leg-asset-namespace-non-ascii`,
      await v({
        request: (r) =>
          (r.destination[0].asset_identifier = r.destination[0].asset_identifier.replace(
            /\/([a-z0-9]+):/,
            '/$1\ua7cb:',
          )),
      }),
      { outcome: 'destination_mismatch', detailContains: 'must be printable ASCII' },
    );
    add(
      `${p}-leg-oversized`,
      await v({ request: (r) => (r.destination[0].account = '@' + 'a'.repeat(100000)) }),
      { outcome: 'destination_mismatch', detailContains: 'cannot be committed to' },
    );
    add(
      `${p}-request-id-quoted`,
      await v({ request: (r) => (r.request_id = 'req"\\\u0001' + 'x'.repeat(600)) }),
      { outcome: 'request_hash_mismatch', detailContains: 'is not keccak256 of request_id' },
    );
    add(
      `${p}-request-hash-lone-surrogate`,
      await v({
        prehashText: (t) =>
          t.replace(
            /"depositRequestHash":"[^"]*"/,
            `"depositRequestHash":"${LONE_SURROGATE_ESCAPE}"`,
          ),
      }),
      { outcome: 'prehash_mismatch', detailContains: 'is not a 32-byte hex value' },
    );
  }

  // A payment relabelled from EVM to Tron keeps its EVM prehash: rebuilt for Tron, the digest differs.
  {
    const base = await honestEvm();
    add(
      'evm-relabelled-tron-source',
      await variant(base, {
        request: (r) => {
          r.source.asset_identifier = 'tron:mainnet/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
          r.sender_auth.message_scheme = 'EVM_PERMIT2';
        },
      }),
      { outcome: 'prehash_mismatch', detailContains: 'domain.chainId is not the source chain' },
    );
  }

  // A Tron prehash relabelled as the EIP-155 chain with the same numeric id commits the same payee;
  // recoverAndVerify binds the source chain.
  {
    const base = await honestTron();
    add(
      'tron-prehash-on-eip155-same-chain-id',
      await variant(base, {
        request: (r) =>
          (r.source.asset_identifier =
            'eip155:728126428/erc20:0x5555555555555555555555555555555555555555'),
      }),
      { outcome: 'verified' },
    );
  }

  // A Tron network no built-in table knows, such as a local node's, is checked with the chain id the
  // verifier supplies. The table stays authoritative for the clusters it knows, only the source's
  // own cluster is read, and an id no Tron escrow could be deployed with is refused.
  {
    const base = await honestTron();
    const local = await variant(base, {
      prehash: (ph) => (ph.domain.chainId = '0x' + TRON_LOCALNET_CHAIN_ID.toString(16)),
      resign: true,
      request: (r) =>
        (r.source.asset_identifier = r.source.asset_identifier.replace(
          'tron:mainnet/',
          'tron:localnet/',
        )),
    });
    const mainnet = await variant(base, {});
    const verified: Want = {
      outcome: 'verified',
      signedDestination: base.committed,
      expectedDestination: base.committed,
      expectedDepositRequestHash: deriveDepositRequestHash('req_commit_tron').toLowerCase(),
    };
    const unsupported: Want = {
      outcome: 'scheme_mismatch',
      detailContains: 'source chain "tron:localnet" is not a supported tron network',
    };
    const outOfRange: Want = {
      outcome: 'verifier_misconfigured',
      detailContains:
        'the Tron chain id supplied for cluster "localnet" is not an integer in 1..4294967295',
    };
    const otherChain: Want = {
      outcome: 'prehash_mismatch',
      detailContains: 'domain.chainId is not the source chain',
    };
    add('tron-localnet-chain-id-supplied', local, verified, null, {
      localnet: TRON_LOCALNET_CHAIN_ID,
    });
    add('tron-localnet-chain-id-not-supplied', local, unsupported);
    add('tron-localnet-chain-id-supplied-for-other-cluster', local, unsupported, null, {
      nile: TRON_LOCALNET_CHAIN_ID,
    });
    // The supplied id is the one the digest is rebuilt with, not only a gate.
    add('tron-localnet-chain-id-supplied-other-id', local, otherChain, null, {
      localnet: TRON_LOCALNET_CHAIN_ID + 1,
    });
    add('tron-localnet-chain-id-supplied-max', local, otherChain, null, { localnet: 0xffffffff });
    add('tron-localnet-chain-id-supplied-zero', local, outOfRange, null, { localnet: 0 });
    add('tron-localnet-chain-id-supplied-negative', local, outOfRange, null, { localnet: -1 });
    add('tron-localnet-chain-id-supplied-over-uint32', local, outOfRange, null, {
      localnet: 0x100000000,
    });
    add('tron-mainnet-chain-id-supplied-agrees', mainnet, verified, null, {
      mainnet: 728126428,
    });
    add(
      'tron-mainnet-chain-id-supplied-disagrees',
      mainnet,
      {
        outcome: 'verifier_misconfigured',
        detailContains: `the Tron chain id supplied for cluster "mainnet" is ${TRON_LOCALNET_CHAIN_ID}, but the built-in table has 728126428`,
      },
      null,
      { mainnet: TRON_LOCALNET_CHAIN_ID },
    );
    add('tron-mainnet-chain-id-out-of-range-for-other-cluster', mainnet, verified, null, {
      localnet: 0,
    });
    // The source chain is checked before message_scheme, so the refusal names the configuration.
    add(
      'tron-mainnet-chain-id-disagrees-scheme-relabelled-solana',
      await variant(base, { request: (r) => (r.sender_auth.message_scheme = 'SOLANA') }),
      { outcome: 'verifier_misconfigured', detailContains: 'but the built-in table has 728126428' },
      null,
      { mainnet: TRON_LOCALNET_CHAIN_ID },
    );
    // A built-in id under another cluster name would make that name an alias of the built-in
    // network, so the mainnet permit, relabelled and not re-signed, would verify under it.
    const aliasOfMainnet = (cluster: string): Want => ({
      outcome: 'verifier_misconfigured',
      detailContains: `the Tron chain id supplied for cluster "${cluster}" is 728126428, which the built-in table gives cluster "mainnet"`,
    });
    const relabelled = (cluster: string) =>
      variant(base, {
        request: (r) =>
          (r.source.asset_identifier = r.source.asset_identifier.replace(
            'tron:mainnet/',
            `tron:${cluster}/`,
          )),
      });
    add(
      'tron-localnet-chain-id-supplied-mainnet-id',
      await relabelled('localnet'),
      aliasOfMainnet('localnet'),
      null,
      { localnet: 728126428 },
    );
    // The non-canonical alias tron-source-chain-reference-non-canonical refuses stays refused.
    add(
      'tron-source-chain-reference-non-canonical-chain-id-supplied',
      await relabelled('0x2b6653dc'),
      aliasOfMainnet('0x2b6653dc'),
      null,
      { '0x2b6653dc': 728126428 },
    );
    // The signed messages are checked before the source chain, so a deposit with none is reported
    // as such even when the verifier's chain id is unusable.
    add(
      'tron-no-signed-messages-chain-id-disagrees',
      await variant(base, { request: (r) => (r.sender_auth.signed_messages = []) }),
      { outcome: 'commitment_absent', detailContains: 'no signed messages' },
      null,
      { mainnet: TRON_LOCALNET_CHAIN_ID },
    );
  }
  // Tron chain ids are read for a Tron source only.
  add(
    'evm-tron-chain-ids-not-read',
    await variant(await honestEvm(), {}),
    { outcome: 'verified' },
    null,
    { mainnet: 1, localnet: 0 },
  );

  const other = (request: Json) => JSON.stringify(request);
  add(
    'unknown-source-namespace',
    other({
      request_id: 'req_x',
      source: { asset_identifier: 'cosmos:cosmoshub-4/slip44:118', account: 'cosmos1x' },
      destination: [{ asset_identifier: EVM_DESTINATION_ASSET, account: EVM_DESTINATION_ACCOUNT }],
      sender_auth: {
        message_scheme: 'EVM_PERMIT2',
        signed_messages: [
          { message: '0x' + '00'.repeat(32), signature: '0x', message_prehash: '{}' },
        ],
      },
    }),
    { outcome: 'scheme_mismatch', detailContains: 'has no destination commitment rule' },
  );
  add(
    'unsupported-tron-network',
    other({
      request_id: 'req_x',
      source: {
        asset_identifier: 'tron:nile/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        account: 'TBvJUBXorwBPzqvV38vjDgegj5Eh6g2Tsq',
      },
      destination: [
        { asset_identifier: TRON_DESTINATION_ASSET, account: TRON_DESTINATION_ACCOUNT },
      ],
      sender_auth: {
        message_scheme: 'EVM_PERMIT2',
        signed_messages: [
          { message: '0x' + '00'.repeat(32), signature: '0x', message_prehash: '{}' },
        ],
      },
    }),
    { outcome: 'scheme_mismatch', detailContains: 'is not a supported tron network' },
  );
  // ─── Solana ───
  const b58 = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));
  const SOL_MINT = b58(9);
  const SOL_DEST_ASSET =
    'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo';
  const SOL_DEST_ACCOUNT = '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4';
  const SOL_ATTACKER = b58(7);
  const solanaDomain = (domainVersion: number): SolanaDomain => ({
    escrowProgramId: b58(1),
    clusterId: 'devnet',
    domainVersion,
  });
  const keyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
  const payer = bs58.encode(keyPair.publicKey);
  const hashRecord = (prehash: Json, domain: SolanaDomain): string => {
    const rec = readSolanaRecord(prehash);
    const d = solanaEscrowDomain(domain);
    if (typeof rec === 'string' || typeof d === 'string') throw new Error('unreadable test record');
    return hexlify(computeDepositHashV2(rec.params, rec.destination, d));
  };
  const signDigest = (digest: string, secretKey: Uint8Array) =>
    '0x' +
    Buffer.from(
      nacl.sign.detached(Uint8Array.from(Buffer.from(digest.slice(2), 'hex')), secretKey),
    ).toString('hex');
  const honestSolana = async (domainVersion: number): Promise<Json> => {
    const built = await solanaAdapter.buildAuthMessage({
      sourceAsset: `solana:mainnet/spl:${SOL_MINT}`,
      depositor: payer,
      maxSourceAmount: '1000000',
      requestId: 'req_commit_sol',
      sourceDefaults: {
        escrowContract: b58(1),
        quoteSelector: b58(2),
        fulfillmentVerifierAccount: b58(3),
        fulfillmentVerifierEndpoint: 'https://verifier.example',
        fulfillmentProxy: b58(4),
        svmSignatureClusterId: 'devnet',
        svmSignatureDomainVersion: domainVersion,
      },
      destinationAsset: SOL_DEST_ASSET,
      destinationAccount: SOL_DEST_ACCOUNT,
      nonce: deterministicSolanaNonce({ requestId: 'req_commit_sol', depositor: payer }),
      solanaClockReader: async () => 1700000000n,
    });
    return {
      request_id: 'req_commit_sol',
      source: { asset_identifier: `solana:mainnet/spl:${SOL_MINT}`, account: payer },
      destination: [{ asset_identifier: SOL_DEST_ASSET, account: SOL_DEST_ACCOUNT }],
      sender_auth: {
        message_scheme: 'SOLANA',
        signed_messages: [
          {
            message: built.messageHash,
            signature: signDigest(built.messageHash, keyPair.secretKey),
            message_prehash: built.messagePrehash,
            payload: { delegate_signer: payer },
          },
        ],
      },
    };
  };
  const solBase = await honestSolana(5);
  const solCommitted = buildEscrowDestination(SOL_DEST_ASSET, SOL_DEST_ACCOUNT);
  const solHash = deriveDepositRequestHash('req_commit_sol').toLowerCase();
  const solHonest: Want = {
    outcome: 'verified',
    signedDestination: solCommitted,
    expectedDestination: solCommitted,
    expectedDepositRequestHash: solHash,
  };
  /** A Solana variant. `resign` recomputes the deposit hash and signs it with `signer` (the payer by default). */
  const sol = (m: {
    prehash?: (ph: Json) => void;
    prehashText?: (t: string) => string;
    request?: (r: Json) => void;
    resign?: Uint8Array | true;
    base?: Json;
  }) => {
    const request = structuredClone(m.base ?? solBase);
    const deposit = request.sender_auth.signed_messages[0];
    if (m.prehash || m.prehashText) {
      let text: string = deposit.message_prehash;
      if (m.prehash) {
        const ph = JSON.parse(text);
        m.prehash(ph);
        text = JSON.stringify(ph);
      }
      if (m.prehashText) text = m.prehashText(text);
      deposit.message_prehash = text;
      if (m.resign) {
        deposit.message = hashRecord(JSON.parse(text), solanaDomain(5));
        deposit.signature = signDigest(
          deposit.message,
          m.resign === true ? keyPair.secretKey : m.resign,
        );
      }
    }
    if (m.request) m.request(request);
    return JSON.stringify(request);
  };
  const D5 = solanaDomain(5);
  add('solana-honest', sol({}), solHonest, D5);
  add(
    'solana-honest-without-delegate-signer',
    sol({ request: (r) => delete r.sender_auth.signed_messages[0].payload }),
    solHonest,
    D5,
  );
  add(
    'solana-honest-domain-version-4',
    JSON.stringify(await honestSolana(4)),
    solHonest,
    solanaDomain(4),
  );
  add(
    'solana-domain-version-4-hash-for-5',
    sol({}),
    { outcome: 'prehash_mismatch', detailContains: 'not the Solana deposit hash' },
    solanaDomain(4),
  );
  add(
    'solana-domain-version-3',
    sol({}),
    {
      outcome: 'commitment_absent',
      detailContains: 'signature domain version 3 commits no destination',
    },
    solanaDomain(3),
  );
  add('solana-domain-not-supplied', sol({}), {
    outcome: 'verifier_misconfigured',
    detailContains: 'was not supplied',
  });
  add(
    'solana-domain-version-0',
    sol({}),
    { outcome: 'verifier_misconfigured', detailContains: 'between 1 and 255' },
    solanaDomain(0),
  );
  add(
    'solana-domain-version-256',
    sol({}),
    { outcome: 'verifier_misconfigured', detailContains: 'between 1 and 255' },
    solanaDomain(256),
  );
  add(
    'solana-domain-program-id-invalid',
    sol({}),
    { outcome: 'verifier_misconfigured', detailContains: 'program id' },
    { ...D5, escrowProgramId: 'not-base58!' },
  );
  add(
    'solana-domain-cluster-empty',
    sol({}),
    { outcome: 'verifier_misconfigured', detailContains: 'cluster id is empty' },
    { ...D5, clusterId: '' },
  );
  add(
    'solana-domain-other-program',
    sol({}),
    { outcome: 'prehash_mismatch', detailContains: 'not the Solana deposit hash' },
    { ...D5, escrowProgramId: b58(6) },
  );
  add(
    'solana-domain-other-cluster',
    sol({}),
    { outcome: 'prehash_mismatch', detailContains: 'not the Solana deposit hash' },
    { ...D5, clusterId: 'mainnet' },
  );
  add(
    'solana-scheme-relabelled-evm',
    sol({ request: (r) => (r.sender_auth.message_scheme = 'EVM_PERMIT2') }),
    { outcome: 'scheme_mismatch' },
    D5,
  );
  add(
    'solana-prehash-absent',
    sol({ request: (r) => delete r.sender_auth.signed_messages[0].message_prehash }),
    { outcome: 'commitment_absent', detailContains: 'no message_prehash' },
    D5,
  );
  add(
    'solana-v1-record',
    sol({
      prehash: (ph) => {
        ph.payment_id = ph.deposit_request_hash;
        delete ph.deposit_request_hash;
        delete ph.destination;
      },
    }),
    { outcome: 'commitment_absent', detailContains: 'commits no destination' },
    D5,
  );
  add(
    'solana-destination-blank',
    sol({ prehash: (ph) => (ph.destination = ' ') }),
    { outcome: 'commitment_absent', detailContains: 'commits no destination' },
    D5,
  );
  add(
    'solana-destination-respelled',
    sol({
      prehash: (ph) => {
        ph.Destination = ph.destination;
        delete ph.destination;
      },
    }),
    { outcome: 'commitment_absent', detailContains: 'commits no destination' },
    D5,
  );
  add(
    'solana-destination-twin',
    sol({
      prehashText: (t) =>
        t.replace(
          '"destination":',
          `"Destination":${JSON.stringify(buildEscrowDestination(SOL_DEST_ASSET, SOL_ATTACKER))},"destination":`,
        ),
    }),
    { outcome: 'prehash_mismatch', detailContains: 'differ only in letter case, at $.destination' },
    D5,
  );
  add(
    'solana-request-hash-camel-case-spelling',
    sol({ prehash: (ph) => (ph.depositRequestHash = ph.deposit_request_hash) }),
    { outcome: 'prehash_mismatch', detailContains: 'spells one member two ways' },
    D5,
  );
  // Every underscore is set aside, wherever it falls, so a second snake_case spelling is the same
  // member too, even when both carry the same value.
  add(
    'solana-request-hash-second-snake-case-spelling',
    sol({ prehash: (ph) => (ph.depositRequest_hash = ph.deposit_request_hash) }),
    { outcome: 'prehash_mismatch', detailContains: 'spells one member two ways' },
    D5,
  );
  add(
    'solana-request-hash-payment-id-spelling',
    sol({ prehash: (ph) => (ph.payment_id = ph.deposit_request_hash) }),
    { outcome: 'prehash_mismatch', detailContains: 'spells one member two ways' },
    D5,
  );
  add(
    'solana-issued-at-camel-case-spelling',
    sol({ prehash: (ph) => (ph.issuedAt = ph.issued_at) }),
    { outcome: 'prehash_mismatch', detailContains: 'spells one member two ways' },
    D5,
  );
  add(
    'solana-extra-member',
    sol({ prehash: (ph) => (ph.memo = 'x') }),
    { outcome: 'prehash_mismatch', detailContains: 'does not define' },
    D5,
  );
  add(
    'solana-payee-rewritten',
    sol({ request: (r) => (r.destination[0].account = SOL_ATTACKER) }),
    {
      outcome: 'destination_mismatch',
      detailContains: 'the payer signed a deposit payable to',
      signedDestination: solCommitted,
      expectedDestination: buildEscrowDestination(SOL_DEST_ASSET, SOL_ATTACKER),
    },
    D5,
  );
  // The order of the checks in the Solana arm, which spells it out for itself. Mirrors the evm and
  // tron order vectors: an unreadable hash is refused before the destination is compared, and a
  // readable one is compared only after it.
  add(
    'solana-order-hash-parsed-before-destination',
    sol({
      prehash: (ph) => (ph.deposit_request_hash = 'garbage'),
      request: (r) => (r.destination[0].account = SOL_ATTACKER),
    }),
    {
      outcome: 'prehash_mismatch',
      detailContains: 'is not a 32-byte hex value',
      expectedDestination: '',
    },
    D5,
  );
  add(
    'solana-order-destination-before-hash-value',
    sol({
      prehash: (ph) =>
        (ph.deposit_request_hash = deriveDepositRequestHash('req_other').toLowerCase()),
      resign: true,
      request: (r) => (r.destination[0].account = SOL_ATTACKER),
    }),
    {
      outcome: 'destination_mismatch',
      detailContains: 'the payer signed a deposit payable to',
      signedDestination: solCommitted,
      expectedDestination: buildEscrowDestination(SOL_DEST_ASSET, SOL_ATTACKER),
      expectedDepositRequestHash: '',
    },
    D5,
  );
  add(
    'solana-mint-rewritten',
    sol({
      request: (r) =>
        (r.destination[0].asset_identifier = `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:${SOL_MINT}`),
    }),
    { outcome: 'destination_mismatch' },
    D5,
  );
  add(
    'solana-two-legs',
    sol({ request: (r) => r.destination.push({ ...r.destination[0] }) }),
    { outcome: 'destination_mismatch', detailContains: 'names 2 destinations' },
    D5,
  );
  add(
    'solana-account-case-flipped',
    sol({
      request: (r) => (r.destination[0].account = '7HEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4'),
    }),
    { outcome: 'destination_mismatch' },
    D5,
  );
  add(
    'solana-signed-destination-padded',
    sol({ prehash: (ph) => (ph.destination = ' ' + ph.destination) }),
    { outcome: 'destination_mismatch', signedDestination: ' ' + solCommitted },
    D5,
  );
  add(
    'solana-signed-destination-padded-resigned',
    sol({ prehash: (ph) => (ph.destination = ' ' + ph.destination), resign: true }),
    { outcome: 'destination_mismatch' },
    D5,
  );
  add(
    'solana-request-id-changed',
    sol({ request: (r) => (r.request_id = 'req_other') }),
    { outcome: 'request_hash_mismatch' },
    D5,
  );
  add(
    'solana-request-hash-bare-hex',
    sol({ prehash: (ph) => (ph.deposit_request_hash = ph.deposit_request_hash.slice(2)) }),
    { ...solHonest, signedDepositRequestHash: solHash.slice(2) },
    D5,
  );
  add(
    'solana-request-hash-malformed',
    sol({ prehash: (ph) => (ph.deposit_request_hash = '0x12') }),
    { outcome: 'prehash_mismatch', detailContains: 'is not a 32-byte hex value' },
    D5,
  );
  add(
    'solana-record-rewritten-not-resigned',
    sol({
      prehash: (ph) => (ph.destination = buildEscrowDestination(SOL_DEST_ASSET, SOL_ATTACKER)),
      request: (r) => (r.destination[0].account = SOL_ATTACKER),
    }),
    { outcome: 'prehash_mismatch', detailContains: 'not the Solana deposit hash' },
    D5,
  );
  add(
    'solana-record-fabricated-with-payer-signature',
    sol({
      prehash: (ph) => (ph.destination = buildEscrowDestination(SOL_DEST_ASSET, SOL_ATTACKER)),
      request: (r) => {
        r.destination[0].account = SOL_ATTACKER;
        const deposit = r.sender_auth.signed_messages[0];
        deposit.message = hashRecord(JSON.parse(deposit.message_prehash), D5);
      },
    }),
    { outcome: 'signer_mismatch', detailContains: 'ed25519 signature does not verify' },
    D5,
  );
  const attackerKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
  add(
    'solana-record-fabricated-with-attacker-signature',
    sol({
      prehash: (ph) => (ph.destination = buildEscrowDestination(SOL_DEST_ASSET, SOL_ATTACKER)),
      resign: attackerKeys.secretKey,
      request: (r) => (r.destination[0].account = SOL_ATTACKER),
    }),
    { outcome: 'signer_mismatch', detailContains: 'ed25519 signature does not verify' },
    D5,
  );
  add(
    'solana-source-account-rewritten',
    sol({
      request: (r) => {
        r.source.account = bs58.encode(attackerKeys.publicKey);
        delete r.sender_auth.signed_messages[0].payload;
      },
    }),
    {
      outcome: 'signer_mismatch',
      detailContains: "depositor is not the payment's source account",
    },
    D5,
  );
  // The payer honestly signs a deposit that debits another account: the digest, the signature and
  // the delegate signer all check out, so only the depositor rule refuses it.
  add(
    'solana-depositor-not-source-account',
    sol({ prehash: (ph) => (ph.depositor = SOL_ATTACKER), resign: true }),
    {
      outcome: 'signer_mismatch',
      detailContains: "depositor is not the payment's source account",
    },
    D5,
  );
  add(
    'solana-delegate-signer-other',
    sol({
      request: (r) => (r.sender_auth.signed_messages[0].payload.delegate_signer = SOL_ATTACKER),
    }),
    { outcome: 'signer_mismatch', detailContains: 'delegate signer' },
    D5,
  );
  add(
    'solana-delegate-signer-number',
    sol({ request: (r) => (r.sender_auth.signed_messages[0].payload.delegate_signer = 1) }),
    { outcome: 'signer_mismatch', detailContains: 'delegate signer' },
    D5,
  );
  add(
    'solana-signature-malformed',
    sol({ request: (r) => (r.sender_auth.signed_messages[0].signature = '0x1234') }),
    { outcome: 'signer_mismatch', detailContains: '64-byte hex ed25519 signature' },
    D5,
  );
  add(
    'solana-signature-non-canonical-s',
    sol({
      request: (r) => {
        const deposit = r.sender_auth.signed_messages[0];
        const bytes = Buffer.from(deposit.signature.slice(2), 'hex');
        let s = 0n;
        for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(bytes[i]!);
        s += (1n << 252n) + 27742317777372353535851937790883648493n;
        for (let i = 32; i < 64; i++) {
          bytes[i] = Number(s & 0xffn);
          s >>= 8n;
        }
        deposit.signature = '0x' + bytes.toString('hex');
      },
    }),
    { outcome: 'signer_mismatch', detailContains: 'ed25519 signature does not verify' },
    D5,
  );
  // Solana's ed25519 program refuses a small-order public key or R; so does the commitment check.
  add(
    'solana-depositor-small-order',
    sol({
      prehash: (ph) => (ph.depositor = SMALL_ORDER_KEY),
      request: (r) => {
        r.source.account = SMALL_ORDER_KEY;
        const deposit = r.sender_auth.signed_messages[0];
        deposit.payload.delegate_signer = SMALL_ORDER_KEY;
        deposit.message = hashRecord(JSON.parse(deposit.message_prehash), D5);
        deposit.signature = smallOrderKeySignature();
      },
    }),
    { outcome: 'signer_mismatch', detailContains: 'ed25519 signature does not verify' },
    D5,
  );
  add(
    'solana-signature-small-order-r',
    sol({
      request: (r) => {
        const deposit = r.sender_auth.signed_messages[0];
        deposit.signature = smallOrderRSignature(deposit.message, new Uint8Array(32).fill(5));
      },
    }),
    { outcome: 'signer_mismatch', detailContains: 'ed25519 signature does not verify' },
    D5,
  );
  add(
    'solana-digest-malformed',
    sol({ request: (r) => (r.sender_auth.signed_messages[0].message = '0x12') }),
    { outcome: 'prehash_mismatch', detailContains: '32-byte hex digest' },
    D5,
  );
  add(
    'solana-amount-zero',
    sol({ prehash: (ph) => (ph.amount = '0') }),
    { outcome: 'prehash_mismatch', detailContains: 'amount is zero' },
    D5,
  );
  add(
    'solana-amount-json-number',
    sol({ prehash: (ph) => (ph.amount = 1000000) }),
    { outcome: 'prehash_mismatch', detailContains: 'amount is not a string' },
    D5,
  );
  add(
    'solana-amount-over-u64',
    sol({ prehash: (ph) => (ph.amount = (1n << 64n).toString()) }),
    { outcome: 'prehash_mismatch', detailContains: 'exceeds u64' },
    D5,
  );
  add(
    'solana-mint-not-base58',
    sol({ prehash: (ph) => (ph.mint = '0' + ph.mint.slice(1)) }),
    { outcome: 'prehash_mismatch', detailContains: 'mint is not a non-zero base58' },
    D5,
  );
  add(
    'solana-reserver-zero-key',
    sol({ prehash: (ph) => (ph.reserver = '11111111111111111111111111111111') }),
    { outcome: 'prehash_mismatch', detailContains: 'reserver is not a non-zero base58' },
    D5,
  );
  add(
    'solana-request-hash-absent',
    sol({ prehash: (ph) => delete ph.deposit_request_hash }),
    { outcome: 'commitment_absent', detailContains: 'commits no depositRequestHash' },
    D5,
  );
  add(
    'solana-request-hash-not-string',
    sol({ prehash: (ph) => (ph.deposit_request_hash = 0) }),
    { outcome: 'prehash_mismatch', detailContains: 'is not a string' },
    D5,
  );
  add(
    'solana-request-hash-lone-surrogate',
    sol({
      prehashText: (t) =>
        t.replace(
          /"deposit_request_hash":"[^"]*"/,
          `"deposit_request_hash":"${LONE_SURROGATE_ESCAPE}"`,
        ),
    }),
    { outcome: 'prehash_mismatch', detailContains: 'is not a 32-byte hex value' },
    D5,
  );
  add(
    'solana-nonce-not-decimal',
    sol({ prehash: (ph) => (ph.nonce = '1e3') }),
    { outcome: 'prehash_mismatch' },
    D5,
  );
  add(
    'solana-domain-cluster-too-long',
    sol({}),
    { outcome: 'verifier_misconfigured', detailContains: 'longer than 32 bytes' },
    { ...D5, clusterId: 'c'.repeat(33) },
  );
  add(
    'solana-domain-program-id-zero',
    sol({}),
    { outcome: 'verifier_misconfigured', detailContains: 'zero key' },
    { ...D5, escrowProgramId: '11111111111111111111111111111111' },
  );

  const evm = await honestEvm();
  const evmHash = deriveDepositRequestHash('req_commit_evm').toLowerCase();
  const evmExpected: CommitmentExpectation = {
    destinations: evm.request.destination,
    requestId: 'req_commit_evm',
  };
  // A payee one byte over the escrow's MAX_DESTINATION_BYTES once composed: the contract reverts
  // DestinationTooLong, so no deposit can pay it, even one that signed exactly that destination. The
  // refusal's detail is the destination builder's message, which both languages must report alike.
  const overMaxAccount =
    '0x' + 'a'.repeat(MAX_DESTINATION_BYTES + 1 - `${EVM_DESTINATION_ASSET}@0x`.length);
  const overMaxDestination = `${EVM_DESTINATION_ASSET}@${overMaxAccount}`.toLowerCase();
  // The destination is compared byte for byte, so any difference from the payment's, however small,
  // is another payee: the same token and account on another chain, or the honest destination with a
  // trailing space, a trailing newline, or its last character cut off.
  const otherPayee = (name: string, signedDestination: string): CompareCase => ({
    name,
    signedDestination,
    signedDepositRequestHash: evmHash,
    expected: evmExpected,
    want: {
      outcome: 'destination_mismatch',
      detailContains: 'the payer signed a deposit payable to',
      signedDestination,
      expectedDestination: evm.committed,
    },
  });
  // The signed hash is exactly 32 bytes of hex with nothing around it. A value that only contains
  // the honest hash (one byte longer, after a leading space, or before a trailing line break) is
  // refused rather than read as the hash inside it, and so is a value of the right length with one
  // digit that is not hex. The line breaks are where regex anchoring differs between engines and
  // modes: a `$` that also matches before a line break would read the hash in front of it.
  const malformedHash = (name: string, signedDepositRequestHash: string): CompareCase => ({
    name,
    signedDestination: evm.committed,
    signedDepositRequestHash,
    expected: evmExpected,
    want: { outcome: 'prehash_mismatch', detailContains: 'is not a 32-byte hex value' },
  });
  const compare: CompareCase[] = [
    {
      name: 'compare-destination-over-max-bytes',
      signedDestination: overMaxDestination,
      signedDepositRequestHash: evmHash,
      expected: {
        destinations: [{ asset_identifier: EVM_DESTINATION_ASSET, account: overMaxAccount }],
        requestId: 'req_commit_evm',
      },
      want: {
        outcome: 'destination_mismatch',
        detailContains:
          "composed destination is 257 bytes, over the escrow's MAX_DESTINATION_BYTES of 256",
        expectedDestination: '',
      },
    },
    {
      name: 'compare-honest',
      signedDestination: evm.committed,
      signedDepositRequestHash: evmHash,
      expected: evmExpected,
      want: {
        outcome: 'verified',
        signedDestination: evm.committed,
        expectedDestination: evm.committed,
        expectedDepositRequestHash: evmHash,
      },
    },
    {
      name: 'compare-bare-hex-hash',
      signedDestination: evm.committed,
      signedDepositRequestHash: evmHash.slice(2),
      expected: evmExpected,
      want: { outcome: 'verified' },
    },
    {
      name: 'compare-blank-destination',
      signedDestination: ' ',
      signedDepositRequestHash: evmHash,
      expected: evmExpected,
      want: { outcome: 'commitment_absent', detailContains: 'commits no destination' },
    },
    {
      name: 'compare-blank-hash',
      signedDestination: evm.committed,
      signedDepositRequestHash: '',
      expected: evmExpected,
      want: { outcome: 'commitment_absent', detailContains: 'commits no depositRequestHash' },
    },
    {
      name: 'compare-malformed-hash',
      signedDestination: evm.committed,
      signedDepositRequestHash: '0x1234',
      expected: evmExpected,
      want: { outcome: 'prehash_mismatch', detailContains: 'is not a 32-byte hex value' },
    },
    {
      name: 'compare-destination-mismatch',
      signedDestination: evm.committed,
      signedDepositRequestHash: evmHash,
      expected: {
        destinations: [{ asset_identifier: EVM_DESTINATION_ASSET, account: ATTACKER_EVM }],
        requestId: 'req_commit_evm',
      },
      want: {
        outcome: 'destination_mismatch',
        detailContains: 'the payer signed a deposit payable to',
      },
    },
    {
      name: 'compare-request-hash-mismatch',
      signedDestination: evm.committed,
      signedDepositRequestHash: evmHash,
      expected: { destinations: evm.request.destination, requestId: 'req_other' },
      want: { outcome: 'request_hash_mismatch' },
    },
    otherPayee(
      'compare-destination-other-chain',
      buildEscrowDestination(
        EVM_DESTINATION_ASSET.replace('eip155:8453/', 'eip155:42161/'),
        EVM_DESTINATION_ACCOUNT,
      ),
    ),
    otherPayee('compare-destination-trailing-space', evm.committed + ' '),
    otherPayee('compare-destination-trailing-newline', evm.committed + '\n'),
    otherPayee('compare-destination-truncated', evm.committed.slice(0, -1)),
    malformedHash('compare-hash-33-bytes', evmHash + 'ab'),
    malformedHash('compare-hash-non-hex', evmHash.slice(0, -1) + 'g'),
    malformedHash('compare-hash-leading-space', ' ' + evmHash),
    malformedHash('compare-hash-trailing-newline', evmHash + '\n'),
    malformedHash('compare-hash-trailing-crlf', evmHash + '\r\n'),
    // The order of the checks. A blank destination is refused as absent before the hash is read at
    // all, so it is reported as the missing commitment it is even when the hash is unreadable too.
    // The signed hash is parsed before any destination is compared, so a rewritten payee whose hash
    // is unreadable is refused for the hash, and no destination is composed. A readable hash is
    // compared only after the destination, so a rewritten payee is named as one even when its hash
    // commits to another request as well.
    {
      name: 'compare-order-blank-destination-before-hash',
      signedDestination: ' ',
      signedDepositRequestHash: 'garbage',
      expected: evmExpected,
      want: { outcome: 'commitment_absent', detailContains: 'commits no destination' },
    },
    {
      name: 'compare-order-hash-parsed-before-destination',
      signedDestination: evm.committed + 'x',
      signedDepositRequestHash: 'garbage',
      expected: evmExpected,
      want: {
        outcome: 'prehash_mismatch',
        detailContains: 'is not a 32-byte hex value',
        expectedDestination: '',
      },
    },
    {
      name: 'compare-order-destination-before-hash-value',
      signedDestination: evm.committed + 'x',
      signedDepositRequestHash: deriveDepositRequestHash('req_other').toLowerCase(),
      expected: evmExpected,
      want: {
        outcome: 'destination_mismatch',
        detailContains: 'the payer signed a deposit payable to',
        expectedDepositRequestHash: '',
      },
    },
  ];

  for (const c of requests)
    c.result = outcomeOf(() =>
      verifyRequestCommitment(c.request, c.solana ?? undefined, { tronChainIds: c.tronChainIds }),
    );
  for (const c of compare)
    c.result = outcomeOf(() =>
      compareCommitment(c.signedDestination, c.signedDepositRequestHash, c.expected),
    );

  return {
    _comment:
      'Destination-commitment vectors asserted by the Go and TypeScript sender-auth tests. requests: ' +
      'verifyRequestCommitment(request, solana, {tronChainIds}) must return want.outcome (and each other ' +
      'want field); tronChainIds is left out when the verifier supplies none. ' +
      'compare: compareCommitment(signedDestination, signedDepositRequestHash, expected). result is the ' +
      'complete result, which both languages must return exactly. Honest payments ' +
      'are built by the TypeScript SDK with fixed keys; each other case is one named mutation of one. ' +
      'Regenerate: REGEN_COMMITMENT_VECTORS=1 pnpm --filter @atum-labs/payment-request-sender-auth exec vitest run src/commitment.test.ts',
    requests,
    compare,
  };
}

// ─── Assertions ──────────────────────────────────────────────────────────────

describe('destination commitment vectors', async () => {
  if (process.env.REGEN_COMMITMENT_VECTORS === '1') {
    writeFileSync(VECTORS, JSON.stringify(await generateVectors(), null, 2) + '\n');
  }
  const vectors = JSON.parse(readFileSync(VECTORS, 'utf8')) as Vectors;

  it('carries unique case names', () => {
    const names = [...vectors.requests, ...vectors.compare].map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives Tron chain ids as an object or leaves them out', () => {
    // Never null, which TypeScript would read as ids supplied and Go as none.
    for (const c of vectors.requests) {
      if ('tronChainIds' in c) expect(c.tronChainIds, c.name).toBeInstanceOf(Object);
    }
  });

  it.each(vectors.requests.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const result = outcomeOf(() =>
      verifyRequestCommitment(c.request, c.solana ?? undefined, { tronChainIds: c.tronChainIds }),
    );
    assertWant(result, c.want);
    expect(result).toEqual(c.result);
  });

  it.each(vectors.compare.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const result = outcomeOf(() =>
      compareCommitment(c.signedDestination, c.signedDepositRequestHash, c.expected),
    );
    assertWant(result, c.want);
    expect(result).toEqual(c.result);
  });
});

describe('honest payments built by the Go SDK', () => {
  const goBuilt = JSON.parse(readFileSync(GO_BUILT, 'utf8')) as {
    requests: Array<{ name: string; request: string; solana?: SolanaDomain }>;
  };
  it.each(goBuilt.requests.map((c) => [c.name, c] as const))('%s verifies', (_name, c) => {
    expect(verifyRequestCommitment(c.request, c.solana).outcome).toBe('verified');
  });

  // The keys goBuiltRequests signs with. Both SDKs sign with a deterministic nonce (RFC 6979), so
  // the same key over the same digest must give the same bytes, v included. The adapters' sign is
  // ethers signTypedData, which signs the typed-data digest with the wallet's signing key.
  it.each([
    ['go-built-evm', '11'.repeat(32)],
    ['go-built-tron', '22'.repeat(32)],
  ] as const)('%s signature is byte-identical to the TS signing key', (name, key) => {
    const c = goBuilt.requests.find((r) => r.name === name)!;
    const [signed] = JSON.parse(c.request).sender_auth.signed_messages as SignedMessageInput[];
    expect(new Wallet('0x' + key).signingKey.sign(signed.message).serialized).toBe(
      signed.signature,
    );
  });
});

describe('verifyCommitment', () => {
  it('refuses a Solana source when no escrow domain is supplied', () => {
    const result = outcomeOf(() =>
      verifyCommitment(
        {
          sourceAssetIdentifier:
            'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          sourceAccount: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
          messageScheme: 'SOLANA',
          signedMessages: [{ message: '', signature: '' }],
        },
        { destinations: [], requestId: '' },
      ),
    );
    expect(result.outcome).toBe('verifier_misconfigured');
  });

  it('throws CommitmentError on refusal and returns the result on admission', async () => {
    const base = await honestEvm();
    const deposit = base.request.sender_auth.signed_messages[0];
    const signed = {
      sourceAssetIdentifier: base.request.source.asset_identifier,
      sourceAccount: base.request.source.account,
      messageScheme: 'EVM_PERMIT2',
      signedMessages: [deposit],
    };
    expect(
      verifyCommitment(signed, {
        destinations: base.request.destination,
        requestId: 'req_commit_evm',
      }).outcome,
    ).toBe('verified');
    expect(() =>
      verifyCommitment(signed, { destinations: base.request.destination, requestId: 'req_other' }),
    ).toThrow(CommitmentError);
  });

  it('reports a deposit with no signed messages before an unusable Tron chain id', () => {
    // The source chain, and so the chain ids, is read after the signed messages. Mirrors the Go test.
    const result = outcomeOf(() =>
      verifyCommitment(
        {
          sourceAssetIdentifier: 'tron:mainnet/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
          sourceAccount: 'TBvJUBXorwBPzqvV38vjDgegj5Eh6g2Tsq',
          messageScheme: 'EVM_PERMIT2',
          signedMessages: [],
        },
        { destinations: [], requestId: '' },
        undefined,
        { tronChainIds: { mainnet: 1 } },
      ),
    );
    expect(result.outcome).toBe('commitment_absent');
  });

  it('refuses a depositRequestHashV2 mode it cannot apply', () => {
    // It cannot read v2 from a request it is not given, so a caller opting in would otherwise
    // stay on v1 without knowing. Mirrors the Go test.
    const signed = {
      sourceAssetIdentifier: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      sourceAccount: '',
      messageScheme: '',
      signedMessages: [],
    };
    const expected = { destinations: [], requestId: '' };
    expect(outcomeOf(() => verifyCommitment(signed, expected)).outcome).toBe('commitment_absent');
    for (const mode of ['audit', 'enforce', 'Enforce'])
      expect(
        outcomeOf(() =>
          verifyCommitment(signed, expected, undefined, {
            depositRequestHashV2Mode: mode as 'enforce',
          }),
        ).outcome,
      ).toBe('verifier_misconfigured');
  });
});

describe('commitmentLogFields', () => {
  it('uses the same keys as the Go LogFields', () => {
    const result = outcomeOf(() => compareCommitment('', '', { destinations: [], requestId: '' }));
    expect(Object.keys(commitmentLogFields(result)).sort()).toEqual([
      'detail',
      'request_deposit_request_hash',
      'request_destination',
      'scheme',
      'sender_auth_result',
      'signed_deposit_request_hash',
      'signed_destination',
      'source_namespace',
    ]);
  });
});

// The request as bytes: invalid UTF-8 is refused, as it is in Go. Mirrors TestVerifyRequestCommitmentBytes.
describe('verifyRequestCommitment on raw bytes', () => {
  const vectors = JSON.parse(readFileSync(VECTORS, 'utf8')) as {
    requests: Array<{ name: string; request: string }>;
  };
  const honest = vectors.requests.find((c) => c.name === 'evm-honest')!.request;

  it('admits the honest request given as bytes', () => {
    expect(verifyRequestCommitment(new TextEncoder().encode(honest)).outcome).toBe('verified');
  });

  it('refuses a request that is not valid UTF-8', () => {
    const text = new TextEncoder().encode('{"note":"');
    const bytes = new Uint8Array([
      ...text,
      0xff,
      ...new TextEncoder().encode('",' + honest.slice(1)),
    ]);
    const result = outcomeOf(() => verifyRequestCommitment(bytes));
    expect(result.outcome).toBe('request_malformed');
    expect(result.detail).toBe('the payment request is not a single valid JSON document');
  });
});

describe('isWellFormedText', () => {
  it('admits surrogate pairs and refuses lone surrogates and U+FFFD', () => {
    expect(isWellFormedText('a\u{1F600}b')).toBe(true);
    expect(isWellFormedText('a' + String.fromCharCode(0xd83d))).toBe(false);
    expect(isWellFormedText(String.fromCharCode(0xde00) + 'a')).toBe(false);
    expect(isWellFormedText('a�')).toBe(false);
  });
});
