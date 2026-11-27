import { describe, it, expect } from 'vitest';
import { Wallet } from 'ethers';
import { evmAdapter } from './evm.js';
import type { ChainDefaults, SourceRef } from '../types.js';

import type { CommitmentExpectation } from '../commitment-rules.js';

/** The commitment this file's fixtures sign: their destination and request id. */
const COMMITMENT: CommitmentExpectation = {
  destinations: [
    {
      asset_identifier: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      account: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
    },
  ],
  requestId: 'req_test',
};

const defaults: ChainDefaults = {
  escrowContract: '0x1111111111111111111111111111111111111111',
  quoteSelector: '0x2222222222222222222222222222222222222222',
  fulfillmentVerifierAccount: '0x3333333333333333333333333333333333333333',
  fulfillmentVerifierEndpoint: 'https://verifier.example',
  fulfillmentProxy: '0x4444444444444444444444444444444444444444',
};
const TOKEN = '0x5555555555555555555555555555555555555555';
const expected = {
  ...defaults,
  maxSourceAmount: '1000000',
  reserver: defaults.quoteSelector,
  releaser: defaults.fulfillmentVerifierAccount,
};

const DEPOSITOR = '0x0000000000000000000000000000000000000005';

async function build(depositor: string, network = 'eip155:1') {
  return evmAdapter.buildAuthMessage({
    sourceAsset: `${network}/erc20:${TOKEN}`,
    depositor,
    maxSourceAmount: '1000000',
    requestId: 'req_test',
    destinationAsset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    destinationAccount: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
    sourceDefaults: defaults,
    nonce: 123n,
    deadline: 1924991999n,
  });
}

describe('evmAdapter typed-data binding', () => {
  it('refuses to sign a prehash that disagrees with the advertised digest', async () => {
    // Both fields are caller-supplied. Pairing one permit's digest with a different permit's
    // prehash would sign the second while every verifier reads the first.
    const wallet = Wallet.createRandom();
    const permitA = await build(wallet.address);
    const permitB = await evmAdapter.buildAuthMessage({
      sourceAsset: `eip155:1/erc20:${TOKEN}`,
      depositor: wallet.address,
      maxSourceAmount: '1000000',
      requestId: 'req_test',
      destinationAsset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      destinationAccount: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
      sourceDefaults: defaults,
      nonce: 456n,
      deadline: 1924991999n,
    });
    expect(permitA.messageHash).not.toBe(permitB.messageHash);

    await expect(
      evmAdapter.sign(
        { message: permitA.messageHash, message_prehash: permitB.messagePrehash, signature: '' },
        wallet.privateKey,
      ),
    ).rejects.toThrow(/implies digest/);
  });
});

describe('evmAdapter round-trip', () => {
  it('build → sign → recoverAndVerify recovers the signer and returns the terms', async () => {
    const wallet = Wallet.createRandom();
    const built = await build(wallet.address);
    expect(built.messageScheme).toBe('EVM_PERMIT2');
    const signed = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
    };
    signed.signature = await evmAdapter.sign(signed, wallet.privateKey);
    const source: SourceRef = { network: 'eip155:1', asset: TOKEN, account: wallet.address };
    const terms = evmAdapter.recoverAndVerify(signed, source, COMMITMENT, expected);
    expect(terms.amount).toBe('1000000');
    expect(typeof terms.deadlineSec).toBe('number');
  });

  it('rejects a signature from the wrong signer', async () => {
    const wallet = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const built = await build(wallet.address);
    const signed = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
    };
    signed.signature = await evmAdapter.sign(signed, attacker.privateKey);
    const source: SourceRef = { network: 'eip155:1', asset: TOKEN, account: wallet.address };
    expect(() => evmAdapter.recoverAndVerify(signed, source, COMMITMENT, expected)).toThrow(
      /does not recover to the payment's source account/,
    );
  });
});

describe('evmAdapter negative paths', () => {
  async function signedFor(wallet: ReturnType<typeof Wallet.createRandom>) {
    const built = await build(wallet.address);
    const s = { message: built.messageHash, message_prehash: built.messagePrehash, signature: '' };
    s.signature = await evmAdapter.sign(s, wallet.privateKey);
    return s;
  }
  const src = (account: string): SourceRef => ({ network: 'eip155:1', asset: TOKEN, account });

  it('rejects a wrong escrow (opt-in spender check)', async () => {
    const w = Wallet.createRandom();
    const s = await signedFor(w);
    expect(() =>
      evmAdapter.recoverAndVerify(s, src(w.address), COMMITMENT, {
        ...expected,
        escrowContract: '0x9999999999999999999999999999999999999999',
      }),
    ).toThrow(/permit spender is not the source escrow/);
  });

  it('rejects mismatched witness roles (opt-in)', async () => {
    const w = Wallet.createRandom();
    const s = await signedFor(w);
    expect(() =>
      evmAdapter.recoverAndVerify(s, src(w.address), COMMITMENT, {
        ...expected,
        reserver: '0x9999999999999999999999999999999999999999',
      }),
    ).toThrow(/witness roles do not match/);
  });

  it('rejects a wrong token', async () => {
    const w = Wallet.createRandom();
    const s = await signedFor(w);
    const source: SourceRef = {
      network: 'eip155:1',
      asset: '0x8888888888888888888888888888888888888888',
      account: w.address,
    };
    expect(() => evmAdapter.recoverAndVerify(s, source, COMMITMENT, expected)).toThrow(
      /permit token does not match/,
    );
  });

  it('rejects a wrong amount', async () => {
    const w = Wallet.createRandom();
    const s = await signedFor(w);
    expect(() =>
      evmAdapter.recoverAndVerify(s, src(w.address), COMMITMENT, {
        ...expected,
        maxSourceAmount: '999',
      }),
    ).toThrow(/permit amount does not match max_source_amount/);
  });

  it('rejects an expired permit', async () => {
    const w = Wallet.createRandom();
    const built = await evmAdapter.buildAuthMessage({
      sourceAsset: `eip155:1/erc20:${TOKEN}`,
      depositor: w.address,
      maxSourceAmount: '1000000',
      requestId: 'req_exp',
      sourceDefaults: defaults,
      nonce: 123n,
      deadline: 1n,
      destinationAsset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      destinationAccount: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
    });
    const s = { message: built.messageHash, message_prehash: built.messagePrehash, signature: '' };
    s.signature = await evmAdapter.sign(s, w.privateKey);
    expect(() => evmAdapter.recoverAndVerify(s, src(w.address), COMMITMENT, expected)).toThrow(
      /deadline is not in the future/,
    );
  });

  it('rejects malformed message_prehash with the uniform error', () => {
    const w = Wallet.createRandom();
    expect(() =>
      evmAdapter.recoverAndVerify(
        { message: '0x00', message_prehash: 'not json', signature: '0x00' },
        src(w.address),
        COMMITMENT,
        expected,
      ),
    ).toThrow(/malformed message_prehash/);
  });

  it('skips spender/witness when escrow/roles are omitted (opt-in off)', async () => {
    const w = Wallet.createRandom();
    const s = await signedFor(w);
    const r = evmAdapter.recoverAndVerify(s, src(w.address), COMMITMENT, {
      maxSourceAmount: '1000000',
    });
    expect(r.amount).toBe('1000000');
    expect(r.permit.spender).toBe(defaults.escrowContract);
  });
});

describe('evmAdapter chain id strictness', () => {
  // Deliberately no second builder here. The params of buildAuthMessage are a shared type, so a
  // helper of its own is one more call site to update whenever a required param is added.
  const buildOn = (network: string) => build(DEPOSITOR, network);

  // The build half signs the Permit2 domain, so the chain reference is read strictly, as in
  // recoverAndVerify and the Go mirror: a loose read such as `parseInt("0x66eee")` (421614) would
  // sign a domain for a chain the identifier does not validly name.
  it.each(['eip155:0x66eee', 'eip155:421614a', 'eip155:', 'eip155:-1', 'EIP155:421614'])(
    'refuses to build a permit for %j',
    async (network) => {
      await expect(buildOn(network)).rejects.toThrow(/expected an eip155 network/);
    },
  );

  it('still builds on a decimal chain id, binding the domain to it', async () => {
    const built = await buildOn('eip155:421614');

    // The encoder writes the domain chain id as hex, and 421614 is 0x66eee.
    expect(JSON.parse(built.messagePrehash!).domain.chainId).toBe('0x66eee');
  });
});
