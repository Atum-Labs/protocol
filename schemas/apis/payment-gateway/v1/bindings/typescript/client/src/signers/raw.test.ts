import { ethers } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createSenderSigner } from './index';
import { RawSenderSigner } from './raw';
import { getChainAdapter } from '../chain-adapters';
import * as chainAdapters from '../chain-adapters';
import type { SignedMessage } from '../generated/types.gen';
import { createPermitWitnessTransferFromPrehashWithDestination } from '@atum-labs/evm-escrow-encoding';
import { hashPermitWitnessTransferFrom } from '../sender_auth_schemes/evm_permit2';

const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

function evmSignedMessage(): SignedMessage {
  const prehash = createPermitWitnessTransferFromPrehashWithDestination({
    chainId: 42161,
    verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    amount: '100000',
    spender: '0x1111111111111111111111111111111111111111',
    nonce: 1n,
    deadline: 1924991999n,
    depositRequestHash: '0x' + '11'.repeat(32),
    destination:
      'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831@0x4444444444444444444444444444444444444444',
    reserver: '0x2222222222222222222222222222222222222222',
    releaser: '0x3333333333333333333333333333333333333333',
  });
  return {
    message: hashPermitWitnessTransferFrom(prehash),
    message_prehash: JSON.stringify(prehash),
    signature: '',
  } as SignedMessage;
}

// The raw path now signs through the shared SDK's localKeySigner (wrapped by
// RawSenderSigner). These tests assert the observable contract — the signature
// recovers to the key's address, and Solana ships the delegate pubkey — rather
// than comparing byte-for-byte against a pgc-local adapter (which no longer signs).
describe('RawSenderSigner (private-key path, via createSenderSigner)', () => {
  it('EVM: the signature recovers to the key address, and omits delegateSigner', async () => {
    const sm = evmSignedMessage();
    const prehash = JSON.parse(sm.message_prehash!);
    const expectedAddress = new ethers.Wallet(PRIVATE_KEY).address;

    const signer = createSenderSigner('eip155:42161', { provider: 'raw', privateKey: PRIVATE_KEY });
    const result = await signer.sign(sm);

    const recovered = ethers.verifyTypedData(
      prehash.domain,
      prehash.types,
      prehash.message,
      result.signature,
    );
    expect(recovered).toBe(expectedAddress);
    expect(result.delegateSigner).toBeUndefined();
  });

  it('Solana: delegateSigner is the key pubkey and verifies the ed25519 signature', async () => {
    // 32-byte hex seed accepted by the solana adapter.
    const seed = 'a'.repeat(64);
    const sm = { message: '0x' + 'ab'.repeat(32), signature: '' } as SignedMessage;

    const signer = createSenderSigner('solana:mainnet', { provider: 'raw', privateKey: seed });
    const result = await signer.sign(sm);

    expect(result.delegateSigner).toBeDefined();
    const messageBytes = ethers.getBytes(sm.message);
    const sigBytes = ethers.getBytes(result.signature);
    const pubkeyBytes = bs58.decode(result.delegateSigner!);
    expect(nacl.sign.detached.verify(messageBytes, sigBytes, pubkeyBytes)).toBe(true);
  });
});

describe('createSenderSigner raw key validation (no secret leak)', () => {
  it('throws a value-free error for a malformed EVM/Tron key', () => {
    const marked = '0xSUPERSECRETMARKER_not_valid_hex_deadbeefcafe';
    for (const chain of ['eip155:42161', 'tron:mainnet']) {
      let msg = '';
      try {
        createSenderSigner(chain, { provider: 'raw', privateKey: marked });
        throw new Error('expected throw');
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      expect(msg).toBe('Invalid private key');
      expect(msg).not.toContain('SUPERSECRETMARKER');
    }
  });

  it('accepts a well-formed key (no regression)', () => {
    expect(() =>
      createSenderSigner('eip155:42161', { provider: 'raw', privateKey: PRIVATE_KEY }),
    ).not.toThrow();
  });

  it('validates the key on direct RawSenderSigner construction (no factory bypass)', () => {
    const marked = '0xMARKER_not_valid_hex_deadbeefcafe';
    let msg = '';
    try {
      new RawSenderSigner('eip155:42161', marked);
      throw new Error('expected throw');
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toBe('Invalid private key');
    expect(msg).not.toContain('MARKER');
  });
});

describe('ChainAdapter.validatePrivateKey', () => {
  const VALID = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const BAD = 'SUPERSECRETMARKER_not_hex_deadbeef';

  it.each(['eip155:42161', 'tron:mainnet'])(
    '%s: accepts 64-hex (any case, with/without 0x), rejects malformed value-free',
    (chain) => {
      const a = getChainAdapter(chain);
      expect(typeof a.validatePrivateKey).toBe('function');
      expect(() => a.validatePrivateKey!(VALID)).not.toThrow();
      expect(() => a.validatePrivateKey!('0x' + VALID)).not.toThrow();
      expect(() => a.validatePrivateKey!(VALID.toUpperCase())).not.toThrow();
      let msg = '';
      try {
        a.validatePrivateKey!(BAD);
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      expect(msg).toBe('Invalid private key');
      expect(msg).not.toContain('SUPERSECRETMARKER');
    },
  );

  it('solana adapter is not gated (no validatePrivateKey)', () => {
    expect(getChainAdapter('solana:mainnet').validatePrivateKey).toBeUndefined();
  });
});

describe('createSenderSigner raw pinnedAddress (sender must match the key)', () => {
  it('EVM: accepts the address derived from the key and rejects a mismatch', () => {
    const derived = new ethers.Wallet(PRIVATE_KEY).address;
    expect(() =>
      createSenderSigner('eip155:42161', {
        provider: 'raw',
        privateKey: PRIVATE_KEY,
        pinnedAddress: derived,
      }),
    ).not.toThrow();
    expect(() =>
      createSenderSigner('eip155:42161', {
        provider: 'raw',
        privateKey: PRIVATE_KEY,
        pinnedAddress: '0x0000000000000000000000000000000000000001',
      }),
    ).toThrow(/does not match/);
  });

  it('Solana: accepts the derived pubkey and rejects a mismatch', () => {
    const seed = 'a'.repeat(64);
    // Derive the expected pubkey the same way the adapter does, to pin against it.
    const seedBytes = Uint8Array.from(Buffer.from(seed, 'hex'));
    const expected = bs58.encode(nacl.sign.keyPair.fromSeed(seedBytes).publicKey);
    expect(() =>
      createSenderSigner('solana:mainnet', {
        provider: 'raw',
        privateKey: seed,
        pinnedAddress: expected,
      }),
    ).not.toThrow();
    expect(() =>
      createSenderSigner('solana:mainnet', {
        provider: 'raw',
        privateKey: seed,
        pinnedAddress: 'So11111111111111111111111111111111111111112',
      }),
    ).toThrow(/does not match/);
  });

  it('Tron: accepts the derived address and rejects a mismatch', () => {
    const derivedHex = new ethers.Wallet(PRIVATE_KEY).address;
    expect(() =>
      createSenderSigner('tron:mainnet', {
        provider: 'raw',
        privateKey: PRIVATE_KEY,
        pinnedAddress: derivedHex,
      }),
    ).not.toThrow();
    expect(() =>
      createSenderSigner('tron:mainnet', {
        provider: 'raw',
        privateKey: PRIVATE_KEY,
        pinnedAddress: 'TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N',
      }),
    ).toThrow(/does not match/);
  });

  // Regression: a key whose derived 20-byte address starts with byte 0x41. The old
  // code ran normalizeAddress on the derived side, which stripped a leading 41 and
  // false-rejected this legitimate pair.
  it('Tron: accepts a base58 sender whose address starts with 0x41', () => {
    const KEY_41 = '0x741563d3fd413af31c72f48f1d07ff411165f081b3b413358efe817fa76c2ca1';
    const BASE58_41 = 'TFvbhehcSYEqkFNaNSMQD26Pt7zvENqghF';
    expect(() =>
      createSenderSigner('tron:mainnet', {
        provider: 'raw',
        privateKey: KEY_41,
        pinnedAddress: BASE58_41,
      }),
    ).not.toThrow();
  });

  it('omitting pinnedAddress skips the check (no regression)', () => {
    expect(() =>
      createSenderSigner('eip155:42161', { provider: 'raw', privateKey: PRIVATE_KEY }),
    ).not.toThrow();
  });

  // An empty pinnedAddress used to be read as "no pin" and skipped this check entirely, while
  // whitespace was compared and reported as a mismatch against a padded value.
  it.each(['', '   ', '\t', '\n'])(
    'rejects a blank pinnedAddress (%j) rather than signing',
    (pinnedAddress) => {
      expect(() =>
        createSenderSigner('eip155:42161', {
          provider: 'raw',
          privateKey: PRIVATE_KEY,
          pinnedAddress,
        }),
      ).toThrow(/must be a non-empty address/);
    },
  );

  it('fails closed when a pinnedAddress is set but the adapter cannot verify the key', () => {
    // A future adapter with no verifyAddressMatchesKey must not silently skip the
    // pin and sign with an unverified key.
    const fakeAdapter = {
      formatPrivateKey: (k: string) => k,
    } as unknown as ReturnType<typeof chainAdapters.getChainAdapter>;
    const spy = jest.spyOn(chainAdapters, 'getChainAdapter').mockReturnValueOnce(fakeAdapter);
    try {
      expect(() =>
        createSenderSigner('newchain:1', {
          provider: 'raw',
          privateKey: PRIVATE_KEY,
          pinnedAddress: '0x0000000000000000000000000000000000000001',
        }),
      ).toThrow(/cannot verify the key/);
    } finally {
      spy.mockRestore();
    }
  });
});
