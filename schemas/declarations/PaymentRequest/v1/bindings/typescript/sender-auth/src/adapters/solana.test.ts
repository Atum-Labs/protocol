import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { solanaAdapter } from './solana.js';
import { deterministicSolanaNonce } from '../utils.js';
import type { ChainDefaults, SourceRef, SignedMessageInput } from '../types.js';
import { SignerMismatchError } from '../errors.js';

import type { CommitmentExpectation } from '../commitment-rules.js';

/** The commitment this file's fixtures sign: their destination and request id. */
const COMMITMENT: CommitmentExpectation = {
  destinations: [
    {
      asset_identifier:
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo',
      account: '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4',
    },
  ],
  requestId: 'req_test',
};

const b58 = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));
const MINT = b58(9);
const defaults: ChainDefaults = {
  escrowContract: b58(1),
  quoteSelector: b58(2),
  fulfillmentVerifierAccount: b58(3),
  fulfillmentVerifierEndpoint: 'https://verifier.example',
  fulfillmentProxy: b58(4),
  svmSignatureClusterId: 'devnet',
  svmSignatureDomainVersion: 5,
};
const expected = {
  ...defaults,
  maxSourceAmount: '1000000',
  reserver: defaults.quoteSelector,
  releaser: defaults.fulfillmentVerifierAccount,
};
const clock = async () => 1700000000n;

/** The one negative-path builder, so a new required param lands in a single place. */
async function buildOn(sourceAsset: string) {
  return solanaAdapter.buildAuthMessage({
    sourceAsset,
    depositor: b58(7),
    maxSourceAmount: '1000000',
    requestId: 'req_sol_bad',
    sourceDefaults: defaults,
    // Required on every chain; the same values the rest of this file uses.
    destinationAsset:
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo',
    destinationAccount: '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4',
    nonce: 123n,
    solanaClockReader: clock,
  });
}

async function buildSigned(depositor: string, secretKeyB58: string): Promise<SignedMessageInput> {
  const built = await solanaAdapter.buildAuthMessage({
    sourceAsset: `solana:mainnet/spl:${MINT}`,
    depositor,
    maxSourceAmount: '1000000',
    requestId: 'req_test',
    destinationAsset:
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo',
    destinationAccount: '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4',
    sourceDefaults: defaults,
    solanaClockReader: clock,
  });
  expect(built.messageScheme).toBe('SOLANA');
  const signed: SignedMessageInput = {
    message: built.messageHash,
    message_prehash: built.messagePrehash,
    signature: '',
    payload: { delegate_signer: depositor },
  };
  signed.signature = await solanaAdapter.sign(signed, secretKeyB58);
  return signed;
}

describe('solanaAdapter round-trip', () => {
  it('build → sign → recoverAndVerify verifies ed25519 + pins delegate_signer to source.account', async () => {
    const kp = nacl.sign.keyPair();
    const depositor = bs58.encode(kp.publicKey);
    const signed = await buildSigned(depositor, bs58.encode(kp.secretKey));
    const source: SourceRef = { network: 'solana:mainnet', asset: MINT, account: depositor };
    const terms = solanaAdapter.recoverAndVerify(signed, source, COMMITMENT, expected);
    expect(terms.amount).toBe('1000000');
    expect(terms.deadlineSec).toBe(Number(1700000000n + 120n)); // REPLAY_HORIZON_SECS - 8
  });

  it('rejects a tampered signed message (hash mismatch)', async () => {
    const kp = nacl.sign.keyPair();
    const depositor = bs58.encode(kp.publicKey);
    const signed = await buildSigned(depositor, bs58.encode(kp.secretKey));
    // Flip the last hex nibble of the signed message.
    const last = signed.message.slice(-1);
    signed.message = signed.message.slice(0, -1) + (last === '0' ? '1' : '0');
    const source: SourceRef = { network: 'solana:mainnet', asset: MINT, account: depositor };
    expect(() => solanaAdapter.recoverAndVerify(signed, source, COMMITMENT, expected)).toThrow(
      /is not the Solana deposit hash of message_prehash/,
    );
  });

  it('rejects when the depositor is not source.account', async () => {
    const kp = nacl.sign.keyPair();
    const depositor = bs58.encode(kp.publicKey);
    const signed = await buildSigned(depositor, bs58.encode(kp.secretKey));
    const source: SourceRef = { network: 'solana:mainnet', asset: MINT, account: b58(7) };
    expect(() => solanaAdapter.recoverAndVerify(signed, source, COMMITMENT, expected)).toThrow(
      /depositor is not the payment's source account/,
    );
  });

  it('rejects a delegate_signer that is not source.account', async () => {
    const kp = nacl.sign.keyPair();
    const depositor = bs58.encode(kp.publicKey);
    const signed = await buildSigned(depositor, bs58.encode(kp.secretKey));
    signed.payload = { delegate_signer: b58(7) };
    const source: SourceRef = { network: 'solana:mainnet', asset: MINT, account: depositor };
    expect(() => solanaAdapter.recoverAndVerify(signed, source, COMMITMENT, expected)).toThrow(
      /delegate signer is not the payment's source account/,
    );
  });
});

describe('solanaAdapter negative paths', () => {
  // Without a delegate_signer the signature is verified against source.account, as the commitment
  // check and recoverSigner do.
  it('verifies against source.account when delegate_signer is missing', async () => {
    const kp = nacl.sign.keyPair();
    const depositor = bs58.encode(kp.publicKey);
    const signed = await buildSigned(depositor, bs58.encode(kp.secretKey));
    delete (signed as { payload?: unknown }).payload;
    const source: SourceRef = { network: 'solana:mainnet', asset: MINT, account: depositor };
    expect(solanaAdapter.recoverAndVerify(signed, source, COMMITMENT, expected).amount).toBe(
      '1000000',
    );
  });

  it('treats a null delegate_signer as absent in both recoverSigner and recoverAndVerify', async () => {
    const kp = nacl.sign.keyPair();
    const depositor = bs58.encode(kp.publicKey);
    const signed = await buildSigned(depositor, bs58.encode(kp.secretKey));
    signed.payload = { delegate_signer: null };
    const source: SourceRef = { network: 'solana:mainnet', asset: MINT, account: depositor };
    expect(solanaAdapter.recoverSigner(signed, source)).toBe(depositor);
    expect(solanaAdapter.recoverAndVerify(signed, source, COMMITMENT, expected).amount).toBe(
      '1000000',
    );
  });

  it('refuses a payload that is not an object', async () => {
    const kp = nacl.sign.keyPair();
    const depositor = bs58.encode(kp.publicKey);
    const signed = await buildSigned(depositor, bs58.encode(kp.secretKey));
    const source: SourceRef = { network: 'solana:mainnet', asset: MINT, account: depositor };
    // The falsy values catch a reader that tests the payload's absence by truthiness.
    for (const payload of ['junk', ['x'], 1, '', 0, false]) {
      const bad = { ...signed, payload } as unknown as SignedMessageInput;
      expect(() => solanaAdapter.recoverSigner(bad, source)).toThrow(SignerMismatchError);
    }
  });

  it('rejects a mint that does not match source.asset', async () => {
    const kp = nacl.sign.keyPair();
    const depositor = bs58.encode(kp.publicKey);
    const signed = await buildSigned(depositor, bs58.encode(kp.secretKey));
    const source: SourceRef = { network: 'solana:mainnet', asset: b58(8), account: depositor };
    expect(() => solanaAdapter.recoverAndVerify(signed, source, COMMITMENT, expected)).toThrow(
      /permit token does not match/,
    );
  });

  it('rejects mismatched witness roles (Solana)', async () => {
    const kp = nacl.sign.keyPair();
    const depositor = bs58.encode(kp.publicKey);
    const signed = await buildSigned(depositor, bs58.encode(kp.secretKey));
    const source: SourceRef = { network: 'solana:mainnet', asset: MINT, account: depositor };
    expect(() =>
      solanaAdapter.recoverAndVerify(signed, source, COMMITMENT, { ...expected, reserver: b58(6) }),
    ).toThrow(/witness roles do not match/);
  });

  it('rejects a wrong amount (Solana)', async () => {
    const kp = nacl.sign.keyPair();
    const depositor = bs58.encode(kp.publicKey);
    const signed = await buildSigned(depositor, bs58.encode(kp.secretKey));
    const source: SourceRef = { network: 'solana:mainnet', asset: MINT, account: depositor };
    expect(() =>
      solanaAdapter.recoverAndVerify(signed, source, COMMITMENT, {
        ...expected,
        maxSourceAmount: '999',
      }),
    ).toThrow(/permit amount does not match max_source_amount/);
  });
});

describe('solanaAdapter build-time nonce validation', () => {
  const buildWithNonce = (nonce: bigint | string) =>
    solanaAdapter.buildAuthMessage({
      sourceAsset: `solana:mainnet/spl:${MINT}`,
      depositor: b58(5),
      maxSourceAmount: '1000000',
      requestId: 'req_nonce_validation',
      destinationAsset:
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo',
      destinationAccount: '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4',
      sourceDefaults: defaults,
      nonce,
      solanaClockReader: clock,
    });

  it('rejects a caller nonce that does not fit an unsigned 64-bit integer (>= 2^64)', async () => {
    await expect(buildWithNonce(1n << 64n)).rejects.toThrow(/unsigned 64-bit/);
  });

  it('rejects a caller nonce whose low byte is a reserved replay slot (>= 235)', async () => {
    await expect(buildWithNonce(240n)).rejects.toThrow(/reserved/);
  });

  it('accepts a valid deterministic nonce', async () => {
    const valid = deterministicSolanaNonce({
      requestId: 'req_nonce_validation',
      depositor: b58(5),
    });
    await expect(buildWithNonce(valid)).resolves.toBeDefined();
  });
  it('names a malformed source asset instead of failing inside the chain library', async () => {
    // Shared with the EVM and Tron adapters. The Go mirror reports the offending value here.
    await expect(buildOn('solana:mainnet')).rejects.toThrow(/invalid source asset/);
  });
});

// The destination is committed from signature domain version 4, so the builder refuses to sign a
// deposit for a lower version.
describe('solanaAdapter domain version', () => {
  it('refuses to build for a signature domain version below 4', async () => {
    await expect(
      solanaAdapter.buildAuthMessage({
        sourceAsset: `solana:mainnet/spl:${MINT}`,
        depositor: b58(7),
        maxSourceAmount: '1000000',
        requestId: 'req_sol_domain_3',
        sourceDefaults: { ...defaults, svmSignatureDomainVersion: 3 },
        destinationAsset:
          'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo',
        destinationAccount: '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4',
        nonce: 123n,
        solanaClockReader: clock,
      }),
    ).rejects.toThrow(/commits no destination/);
  });
});

// The adapter refuses an empty request_id itself, before it reads the cluster clock, rather than
// leaving it to deriveDepositRequestHash further down. Mirrors the Go
// TestSolanaBuildRefusesEmptyRequestIDBeforeReadingTheClock.
describe('solanaAdapter empty request_id', () => {
  it('refuses an empty request_id before reading the cluster clock', async () => {
    let clockReads = 0;
    const refusal = await solanaAdapter
      .buildAuthMessage({
        sourceAsset: `solana:mainnet/spl:${MINT}`,
        depositor: b58(7),
        maxSourceAmount: '1000000',
        requestId: '',
        sourceDefaults: defaults,
        destinationAsset:
          'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo',
        destinationAccount: '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4',
        nonce: 123n,
        solanaClockReader: async () => {
          clockReads++;
          return 1700000000n;
        },
      })
      .catch((e: unknown) => e);
    expect(clockReads).toBe(0);
    expect(refusal).toEqual(new Error('sender_auth: request_id is required'));
  });
});
