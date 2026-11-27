import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { Address } from '@atum-labs/stellar-escrow-encoding';
import { assertStellarSignable, stellarAdapter } from './stellar.js';
import { getChainAdapter } from './index.js';
import { deterministicStellarNonce } from '../utils.js';
import { stellarNetworkString } from '../chain-id.js';
import { DelegateUnverifiedError, SignerMismatchError } from '../errors.js';
import type { SignedMessageInput } from '../types.js';

const fill = (byte: number) => new Uint8Array(32).fill(byte);
const account = (byte: number) => Address.account(fill(byte)).toString();
const contract = (byte: number) => Address.contract(fill(byte)).toString();

// The layout fixture (witness-layouts.md).
const FIXTURE = {
  depositor: account(0xd1),
  token: contract(0xe1),
  defaults: {
    escrowContract: contract(0xc0),
    quoteSelector: account(0x55),
    fulfillmentVerifierAccount: account(0x66),
    fulfillmentVerifierEndpoint: 'https://verifier.example',
    fulfillmentProxy: contract(0xf1),
  },
  destinationAsset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  destinationAccount: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
};
// The deposit digest and the delegate's signature over it that contracts/stellar/source/docs/witness-layouts.md
// derives out of band (seed 0x77 repeated), also pinned by the conformance suite.
const GOLDEN_TESTNET_DIGEST = '0xd28667e7c40efa69ab7ba45db817a82044cb10840fe95a45425e7b99556f6a65';
const GOLDEN_SIGNATURE =
  '0xec48e2d9cc0bff07e1d6c5fb9820fd8cc7a269fe3d3cc752afd46809472076d45327cc4482b64e91990cde344c545a667304692261d9fa526eddf8e6cd12fe0b';

// The golden fixture has the request hash 0x44 repeated, which a request id cannot produce, so the
// digest anchors are checked through the verifier in the conformance suite. Here: what the builder
// commits, and the key and signature handling.
describe('stellar adapter', () => {
  it('is registered under the stellar namespace', () => {
    expect(getChainAdapter('stellar:testnet')).toBe(stellarAdapter);
  });

  it('maps the CAIP-2 references to the public network passphrases', () => {
    expect(stellarNetworkString('stellar:testnet')).toBe('Test SDF Network ; September 2015');
    expect(stellarNetworkString('stellar:pubnet')).toBe(
      'Public Global Stellar Network ; September 2015',
    );
    for (const bad of [
      'stellar:mainnet',
      'stellar:',
      'stellar',
      'eip155:1',
      'stellar:testnet:x',
      'Stellar:testnet',
    ]) {
      expect(() => stellarNetworkString(bad)).toThrow(/not a supported stellar network/);
    }
  });

  it('commits the network: the same deposit on the two networks signs different digests', async () => {
    const build = (network: string) =>
      stellarAdapter.buildAuthMessage({
        sourceAsset: `stellar:${network}/sep41:${FIXTURE.token}`,
        depositor: FIXTURE.depositor,
        maxSourceAmount: '1250000',
        requestId: 'req_network',
        destinationAsset: FIXTURE.destinationAsset,
        destinationAccount: FIXTURE.destinationAccount,
        sourceDefaults: FIXTURE.defaults,
        nonce: 4294967303n,
        issuedAt: 1700000000n,
        delegateEpoch: 1n,
        deadline: 1700000128n,
      });
    const [testnet, pubnet] = [await build('testnet'), await build('pubnet')];
    expect(testnet.messageHash).not.toBe(pubnet.messageHash);
    expect(testnet.messagePrehash).toBe(pubnet.messagePrehash);
  });

  it('commits the destination: another payee signs another digest', async () => {
    const build = (destinationAccount: string) =>
      stellarAdapter.buildAuthMessage({
        sourceAsset: `stellar:testnet/sep41:${FIXTURE.token}`,
        depositor: FIXTURE.depositor,
        maxSourceAmount: '1250000',
        requestId: 'req_dest',
        destinationAsset: FIXTURE.destinationAsset,
        destinationAccount,
        sourceDefaults: FIXTURE.defaults,
        nonce: 1n,
        issuedAt: 1700000000n,
        delegateEpoch: 1n,
        deadline: 1700000128n,
      });
    const a = await build(FIXTURE.destinationAccount);
    const b = await build('0x1111111111111111111111111111111111111111');
    expect(a.messageHash).not.toBe(b.messageHash);
  });

  describe('the deposit ceiling', () => {
    const build = (amounts: { maxSourceAmount: string; quoteSourceAmount?: string }) =>
      stellarAdapter.buildAuthMessage({
        sourceAsset: `stellar:testnet/sep41:${FIXTURE.token}`,
        depositor: FIXTURE.depositor,
        ...amounts,
        requestId: 'req_amount',
        destinationAsset: FIXTURE.destinationAsset,
        destinationAccount: FIXTURE.destinationAccount,
        sourceDefaults: FIXTURE.defaults,
        nonce: 1n,
        issuedAt: 1700000000n,
        delegateEpoch: 1n,
        deadline: 1700000128n,
      });

    it('is the awarded quote amount when quoteSourceAmount is set, as on every other chain', async () => {
      const byCap = await build({ maxSourceAmount: '99000' });
      const byQuote = await build({ maxSourceAmount: '', quoteSourceAmount: '99000' });
      expect(byQuote).toEqual(byCap);
      expect(JSON.parse(byQuote.messagePrehash).amount).toBe('99000');
    });

    it.each<[string, { maxSourceAmount: string; quoteSourceAmount?: string }, RegExp]>([
      ['neither amount', { maxSourceAmount: '' }, /invalid maxSourceAmount ""/],
      ['both amounts', { maxSourceAmount: '100000', quoteSourceAmount: '99000' }, /not both/],
      [
        'a zero quote amount',
        { maxSourceAmount: '', quoteSourceAmount: '0' },
        /quoteSourceAmount "0" is not a decimal integer above zero/,
      ],
      [
        'a hex quote amount',
        { maxSourceAmount: '', quoteSourceAmount: '0x10' },
        /quoteSourceAmount "0x10" is not a decimal integer above zero/,
      ],
      ['a hex cap', { maxSourceAmount: '0x10' }, /invalid maxSourceAmount "0x10"/],
    ])('refuses %s', async (_name, amounts, message) => {
      await expect(build(amounts)).rejects.toThrow(message);
    });
  });

  it('generates a random u64 nonce and a default window within the escrow bounds', async () => {
    const out = await stellarAdapter.buildAuthMessage({
      sourceAsset: `stellar:testnet/sep41:${FIXTURE.token}`,
      depositor: FIXTURE.depositor,
      maxSourceAmount: '5',
      requestId: 'req_default',
      destinationAsset: FIXTURE.destinationAsset,
      destinationAccount: FIXTURE.destinationAccount,
      sourceDefaults: FIXTURE.defaults,
      delegateEpoch: 1n,
    });
    const prehash = JSON.parse(out.messagePrehash) as Record<string, string>;
    expect(BigInt(prehash['nonce']!)).toBeLessThan(1n << 64n);
    const span = BigInt(prehash['deadline']!) - BigInt(prehash['issued_at']!);
    expect(span).toBe(3600n);
    const now = BigInt(Math.floor(Date.now() / 1000));
    expect(BigInt(prehash['issued_at']!)).toBeLessThan(now);
  });

  it('accepts only a hex ed25519 seed as the key and never echoes it', () => {
    const seed = '11'.repeat(32);
    expect(stellarAdapter.deriveDelegateSigner!(seed)).toBe(
      stellarAdapter.deriveDelegateSigner!('0x' + seed),
    );
    expect(stellarAdapter.deriveDelegateSigner!(seed)).toMatch(/^G[A-Z2-7]{55}$/);
    for (const bad of ['', '00', 'zz'.repeat(32), '11'.repeat(31), 'S' + 'A'.repeat(55)]) {
      let message = '';
      try {
        stellarAdapter.deriveDelegateSigner!(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/Invalid Stellar private key/);
      if (bad !== '') expect(message).not.toContain(bad);
    }
  });

  it('signs the 32-byte digest with plain ed25519, no framing', async () => {
    const keys = nacl.sign.keyPair.fromSeed(fill(0x77));
    const digest = GOLDEN_TESTNET_DIGEST;
    const signature = await stellarAdapter.sign(
      { message: digest, signature: '' },
      Buffer.from(fill(0x77)).toString('hex'),
    );
    expect(
      nacl.sign.detached.verify(
        Uint8Array.from(Buffer.from(digest.slice(2), 'hex')),
        Uint8Array.from(Buffer.from(signature.slice(2), 'hex')),
        keys.publicKey,
      ),
    ).toBe(true);
    // The golden signature in witness-layouts.md, derived out of band by another implementation.
    expect(signature).toBe(GOLDEN_SIGNATURE);
    await expect(
      stellarAdapter.sign({ message: '0x12', signature: '' }, '11'.repeat(32)),
    ).rejects.toThrow(/32-byte deposit digest/);
  });

  it('derives the nonce deterministically from the request id and depositor', () => {
    const a = deterministicStellarNonce({ requestId: 'req-1', depositor: FIXTURE.depositor });
    expect(a).toBe(deterministicStellarNonce({ requestId: 'req-1', depositor: FIXTURE.depositor }));
    expect(a).not.toBe(
      deterministicStellarNonce({ requestId: 'req-2', depositor: FIXTURE.depositor }),
    );
    expect(a).toBeLessThan(1n << 64n);
    // Pinned in both languages: a drift between the two derivations fails here and in the Go test.
    expect(a).toBe(288014144211253225n);
    expect(() =>
      deterministicStellarNonce({ requestId: '', depositor: FIXTURE.depositor }),
    ).toThrow();
  });

  describe('a delegate signer that is not the depositor', () => {
    const SEED = Buffer.from(fill(0x77)).toString('hex');
    const delegate = Address.account(nacl.sign.keyPair.fromSeed(fill(0x77)).publicKey).toString();
    const commitment = {
      destinations: [
        { asset_identifier: FIXTURE.destinationAsset, account: FIXTURE.destinationAccount },
      ],
      requestId: 'req_separate_delegate',
    };
    const expected = {
      maxSourceAmount: '1250000',
      escrowContract: FIXTURE.defaults.escrowContract,
      reserver: FIXTURE.defaults.quoteSelector,
      releaser: FIXTURE.defaults.fulfillmentVerifierAccount,
    };

    async function signedFor(depositor: string): Promise<SignedMessageInput> {
      const built = await stellarAdapter.buildAuthMessage({
        sourceAsset: `stellar:testnet/sep41:${FIXTURE.token}`,
        depositor,
        maxSourceAmount: '1250000',
        requestId: commitment.requestId,
        destinationAsset: FIXTURE.destinationAsset,
        destinationAccount: FIXTURE.destinationAccount,
        sourceDefaults: FIXTURE.defaults,
        nonce: 7n,
        issuedAt: 1700000000n,
        delegateEpoch: 1n,
        deadline: 1700000128n,
      });
      const signed: SignedMessageInput = {
        message: built.messageHash,
        message_prehash: built.messagePrehash,
        signature: '',
        payload: { delegate_signer: delegate },
      };
      signed.signature = await stellarAdapter.sign(signed, SEED);
      return signed;
    }
    const sourceOf = (account: string) => ({
      network: 'stellar:testnet',
      asset: FIXTURE.token,
      account,
    });

    it('is refused as unverified by both entry points, never admitted and never a bad signature', async () => {
      const signed = await signedFor(FIXTURE.depositor);
      const source = sourceOf(FIXTURE.depositor);
      expect(() => stellarAdapter.recoverSigner(signed, source)).toThrow(DelegateUnverifiedError);
      expect(() => stellarAdapter.recoverSigner(signed, source)).not.toThrow(SignerMismatchError);
      expect(() => stellarAdapter.recoverAndVerify(signed, source, commitment, expected)).toThrow(
        DelegateUnverifiedError,
      );
    });

    it('is admitted when the depositor is the delegate key itself', async () => {
      const signed = await signedFor(delegate);
      const source = sourceOf(delegate);
      expect(stellarAdapter.recoverSigner(signed, source)).toBe(delegate);
      const r = stellarAdapter.recoverAndVerify(signed, source, commitment, expected);
      expect(r.permit.delegateSigner).toBe(delegate);
      expect(r.permit.depositor).toBe(delegate);
    });

    it('still reports a bad signature as a bad signature', async () => {
      const signed = await signedFor(FIXTURE.depositor);
      const bad = { ...signed, signature: '0x' + '00'.repeat(64) };
      expect(() => stellarAdapter.recoverSigner(bad, sourceOf(FIXTURE.depositor))).toThrow(
        SignerMismatchError,
      );
    });
  });

  // A Stellar key signs 32 bytes with plain ed25519, which is also how a transaction is signed (over
  // its hash). The adapter's sign takes only the message, so the entry points that hold the request
  // run assertStellarSignable first: the message must be the deposit digest of its own prehash.
  describe('assertStellarSignable', () => {
    const escrow = FIXTURE.defaults.escrowContract;
    async function built() {
      return stellarAdapter.buildAuthMessage({
        sourceAsset: `stellar:testnet/sep41:${FIXTURE.token}`,
        depositor: FIXTURE.depositor,
        maxSourceAmount: '1250000',
        requestId: 'req_signable',
        destinationAsset: FIXTURE.destinationAsset,
        destinationAccount: FIXTURE.destinationAccount,
        sourceDefaults: FIXTURE.defaults,
        nonce: 9n,
        issuedAt: 1700000000n,
        delegateEpoch: 1n,
        deadline: 1700000128n,
      });
    }

    it('accepts the message the builder produced, in either letter case', async () => {
      const b = await built();
      const signed: SignedMessageInput = {
        message: b.messageHash,
        message_prehash: b.messagePrehash,
        signature: '',
      };
      expect(() => assertStellarSignable(signed, 'stellar:testnet', escrow)).not.toThrow();
      expect(() =>
        assertStellarSignable(
          { ...signed, message: '0x' + b.messageHash.slice(2).toUpperCase() },
          'stellar:testnet',
          escrow,
        ),
      ).not.toThrow();
    });

    it('refuses a 32-byte value that is not the digest of the prehash, such as a transaction hash', async () => {
      const b = await built();
      const txHash = '0x' + 'ab'.repeat(32);
      expect(() =>
        assertStellarSignable(
          { message: txHash, message_prehash: b.messagePrehash, signature: '' },
          'stellar:testnet',
          escrow,
        ),
      ).toThrow(/refusing to sign bytes that are not the deposit/);
    });

    it('refuses a message with no prehash, or a prehash that is not a deposit record', async () => {
      const b = await built();
      expect(() =>
        assertStellarSignable({ message: b.messageHash, signature: '' }, 'stellar:testnet', escrow),
      ).toThrow(/message_prehash/);
      for (const bad of [
        '{',
        '[]',
        'null',
        '{}',
        JSON.stringify({ ...JSON.parse(b.messagePrehash), extra: '1' }),
      ]) {
        expect(() =>
          assertStellarSignable(
            { message: b.messageHash, message_prehash: bad, signature: '' },
            'stellar:testnet',
            escrow,
          ),
        ).toThrow(/sender_auth:/);
      }
    });

    it('rebuilds the digest under the given network and escrow', async () => {
      const b = await built();
      const signed: SignedMessageInput = {
        message: b.messageHash,
        message_prehash: b.messagePrehash,
        signature: '',
      };
      expect(() => assertStellarSignable(signed, 'stellar:pubnet', escrow)).toThrow(
        /refusing to sign/,
      );
      expect(() => assertStellarSignable(signed, 'stellar:testnet', contract(0xc1))).toThrow(
        /refusing to sign/,
      );
      expect(() => assertStellarSignable(signed, 'stellar:testnet', undefined)).toThrow(
        /escrow contract was not supplied/,
      );
    });
  });
});
