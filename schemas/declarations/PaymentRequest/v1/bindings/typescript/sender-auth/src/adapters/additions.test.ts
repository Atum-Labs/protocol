import { describe, it, expect } from 'vitest';
import { Wallet, getBytes } from 'ethers';
import { evmAdapter } from './evm.js';
import { MalformedPrehashError, RecoveryFailedError, SignerMismatchError } from '../errors.js';
import type { ChainDefaults, SignedMessageInput, SourceRef, VerifyExpectations } from '../types.js';

import type { CommitmentExpectation } from '../commitment-rules.js';

/** The commitment this file's fixtures sign: their destination and request id. */
const COMMITMENT: CommitmentExpectation = {
  destinations: [
    {
      asset_identifier: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      account: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
    },
  ],
  requestId: 'req_add',
};

const defaults: ChainDefaults = {
  escrowContract: '0x1111111111111111111111111111111111111111',
  quoteSelector: '0x2222222222222222222222222222222222222222',
  fulfillmentVerifierAccount: '0x3333333333333333333333333333333333333333',
  fulfillmentVerifierEndpoint: 'https://verifier.example',
  fulfillmentProxy: '0x4444444444444444444444444444444444444444',
};
const TOKEN = '0x5555555555555555555555555555555555555555';

/** The one negative-path builder, so a new required param lands in a single place. */
async function buildOn(sourceAsset: string) {
  return evmAdapter.buildAuthMessage({
    sourceAsset,
    depositor: '0x0000000000000000000000000000000000000001',
    maxSourceAmount: '1000000',
    requestId: 'req_add',
    sourceDefaults: defaults,
    // Required on every chain; the same values the rest of the EVM specs use.
    destinationAsset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    destinationAccount: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
    nonce: 123n,
    deadline: 1924991999n,
  });
}

async function buildEvm(): Promise<{
  signed: SignedMessageInput;
  source: SourceRef;
  expected: VerifyExpectations;
}> {
  const wallet = new Wallet('0x' + '11'.repeat(32));
  const built = await evmAdapter.buildAuthMessage({
    sourceAsset: `eip155:1/erc20:${TOKEN}`,
    depositor: wallet.address,
    maxSourceAmount: '1000000',
    requestId: 'req_add',
    destinationAsset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    destinationAccount: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
    sourceDefaults: defaults,
    nonce: 123n,
    deadline: 1924991999n,
  });
  const signed: SignedMessageInput = {
    message: built.messageHash,
    message_prehash: built.messagePrehash,
    signature: '',
  };
  signed.signature = await evmAdapter.sign(signed, wallet.privateKey);
  const source: SourceRef = { network: 'eip155:1', asset: TOKEN, account: wallet.address };
  const expected: VerifyExpectations = {
    maxSourceAmount: '1000000',
    escrowContract: defaults.escrowContract,
    reserver: defaults.quoteSelector,
    releaser: defaults.fulfillmentVerifierAccount,
  };
  return { signed, source, expected };
}

describe('recoverSigner (recover-only primitive)', () => {
  it('recovers the signer and confirms source.account', async () => {
    const { signed, source } = await buildEvm();
    expect(evmAdapter.recoverSigner(signed, source)).toBe(source.account);
  });

  it('rejects a different account', async () => {
    const { signed, source } = await buildEvm();
    expect(() =>
      evmAdapter.recoverSigner(signed, {
        ...source,
        account: '0x9999999999999999999999999999999999999999',
      }),
    ).toThrow(SignerMismatchError);
  });

  it('ignores message_prehash — works for non-permit setup approvals', async () => {
    const { signed, source } = await buildEvm();
    expect(evmAdapter.recoverSigner({ ...signed, message_prehash: undefined }, source)).toBe(
      source.account,
    );
  });

  it('rejects a non-canonical (EIP-2 high-s) signature', async () => {
    const { signed, source } = await buildEvm();
    const raw = getBytes(signed.signature); // 65 bytes: r(32) s(32) v(1), v in {27,28}
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt('0x' + Buffer.from(raw.slice(32, 64)).toString('hex'));
    const sHigh = (N - s).toString(16).padStart(64, '0'); // the high-s twin
    const r = Buffer.from(raw.slice(0, 32)).toString('hex');
    const v = raw[64] === 27 ? '1c' : '1b'; // flip 27<->28 so it recovers to the same signer
    const highSig = '0x' + r + sHigh + v;
    // High-s is a recovery failure, not a signer mismatch.
    expect(() => evmAdapter.recoverSigner({ ...signed, signature: highSig }, source)).toThrow(
      RecoveryFailedError,
    );
  });
});

describe('recoverAndVerify additions', () => {
  it('rejects a partial witness pair (only reserver supplied)', async () => {
    const { signed, source, expected } = await buildEvm();
    expect(() =>
      evmAdapter.recoverAndVerify(signed, source, COMMITMENT, { ...expected, releaser: undefined }),
    ).toThrow(/must be supplied together/);
  });

  it('compares freshness against the pinned nowSec, not the wall clock', async () => {
    const { signed, source, expected } = await buildEvm();
    // Pinned before the 2030 deadline → fresh.
    expect(() =>
      evmAdapter.recoverAndVerify(signed, source, COMMITMENT, { ...expected, nowSec: 1700000000 }),
    ).not.toThrow();
    // Pinned after the deadline → expired.
    expect(() =>
      evmAdapter.recoverAndVerify(signed, source, COMMITMENT, { ...expected, nowSec: 4000000000 }),
    ).toThrow(/deadline is not in the future/);
  });

  it('throws MalformedPrehashError for an unbindable prehash', async () => {
    const { source, expected } = await buildEvm();
    const bad: SignedMessageInput = {
      message: '0x00',
      message_prehash: 'not json',
      signature: '0x00',
    };
    expect(() => evmAdapter.recoverAndVerify(bad, source, COMMITMENT, expected)).toThrow(
      MalformedPrehashError,
    );
  });

  it('buildAuthMessage requires an explicit nonce (no random fallback)', async () => {
    // Omitting nonce must fail loudly rather than silently mint a retry-unsafe random one.
    await expect(
      evmAdapter.buildAuthMessage({
        sourceAsset: `eip155:1/erc20:${TOKEN}`,
        depositor: '0x0000000000000000000000000000000000000001',
        maxSourceAmount: '1000000',
        requestId: 'req_add',
        destinationAsset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        destinationAccount: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
        sourceDefaults: defaults,
      }),
    ).rejects.toThrow(/requires an explicit nonce/);
  });

  it('buildAuthMessage requires an explicit permit deadline (no far-future fallback)', async () => {
    // Omitting the deadline must fail loudly rather than silently mint a far-future permit
    // that outlives settlement; the calling layer derives it from the fulfillment deadline.
    await expect(
      evmAdapter.buildAuthMessage({
        sourceAsset: `eip155:1/erc20:${TOKEN}`,
        depositor: '0x0000000000000000000000000000000000000001',
        maxSourceAmount: '1000000',
        requestId: 'req_add',
        destinationAsset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        destinationAccount: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
        sourceDefaults: defaults,
        nonce: 123n,
      }),
    ).rejects.toThrow(/requires an explicit permit deadline/);
  });

  it.each([
    ['a missing slash', 'eip155:1'],
    ['a missing colon', 'eip155:1/erc20'],
    ['an empty token', 'eip155:1/erc20:'],
    ['an empty network', '/erc20:0x1'],
  ])('buildAuthMessage names a malformed source asset (%s)', async (_label, sourceAsset) => {
    // The offending value is named rather than failing inside a chain library, as in Go.
    await expect(buildOn(sourceAsset)).rejects.toThrow(/invalid source asset/);
  });
  it.each(['notanaddress', 'zzzz', '0x', '0x1', '0x555555555555555555555555555555555555555'])(
    'buildAuthMessage refuses a token segment that is not an address (%s)',
    async (token) => {
      // Go's HexToAddress would map these to the zero address, so both bindings refuse them.
      await expect(buildOn(`eip155:1/erc20:${token}`)).rejects.toThrow();
    },
  );
});
