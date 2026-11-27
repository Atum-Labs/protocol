import nacl from 'tweetnacl';
import { Address, Pubkey } from '@atum-labs/stellar-escrow-encoding';
import { getChainAdapter as getSenderAuthAdapter } from '@atum-labs/payment-request-sender-auth';
import { createSenderSigner } from './index';
import { RawSenderSigner } from './raw';
import { TurnkeySenderSigner } from './turnkey';
import { signWithTurnkeyClient } from './turnkey-impl';
import { STELLAR_TURNKEY_UNSUPPORTED } from './stellar-turnkey';
import type { SignedMessage } from '../generated/types.gen';

const HEX_KEY = '22'.repeat(32);
const KEYS = nacl.sign.keyPair.fromSeed(Uint8Array.from(Buffer.from(HEX_KEY, 'hex')));
const DELEGATE = Pubkey.fromBytes(KEYS.publicKey).toString();
const DIGEST = '0x' + 'ab'.repeat(32);

const message = (): SignedMessage => ({ message: DIGEST, signature: '' }) as SignedMessage;

describe('raw Stellar signer', () => {
  it('signs the digest with ed25519 and attaches the delegate signer', async () => {
    const signer = createSenderSigner('stellar:testnet', { privateKey: HEX_KEY });
    expect(signer).toBeInstanceOf(RawSenderSigner);
    const { signature, delegateSigner } = await signer.sign(message());
    expect(delegateSigner).toBe(DELEGATE);
    expect(signature).toMatch(/^0x[0-9a-f]{128}$/);
    expect(
      nacl.sign.detached.verify(
        Uint8Array.from(Buffer.from(DIGEST.slice(2), 'hex')),
        Uint8Array.from(Buffer.from(signature.slice(2), 'hex')),
        KEYS.publicKey,
      ),
    ).toBe(true);
  });

  it('accepts a 0x-prefixed key', async () => {
    const signer = createSenderSigner('stellar:testnet', { privateKey: '0x' + HEX_KEY });
    expect((await signer.sign(message())).delegateSigner).toBe(DELEGATE);
  });

  it('refuses a malformed key without echoing it', () => {
    const bad = 'S' + 'B'.repeat(55);
    let text = '';
    try {
      createSenderSigner('stellar:testnet', { privateKey: bad });
    } catch (e) {
      text = (e as Error).message;
    }
    expect(text).toBe('Invalid private key');
    expect(text).not.toContain(bad);
    expect(() => new RawSenderSigner('stellar:testnet', '11'.repeat(31))).toThrow(
      'Invalid private key',
    );
  });

  it('checks a pinned sender against the key, and refuses a different one', () => {
    expect(() =>
      createSenderSigner('stellar:testnet', { privateKey: HEX_KEY, pinnedAddress: DELEGATE }),
    ).not.toThrow();
    const other = Address.account(new Uint8Array(32).fill(9)).toString();
    expect(() =>
      createSenderSigner('stellar:testnet', { privateKey: HEX_KEY, pinnedAddress: other }),
    ).toThrow(/does not match the sender address/);
  });

  it('signs what the sender_auth adapter verifies', async () => {
    const adapter = getSenderAuthAdapter('stellar:testnet');
    const signer = createSenderSigner('stellar:testnet', { privateKey: HEX_KEY });
    const { signature, delegateSigner } = await signer.sign(message());
    const signed = { message: DIGEST, signature, payload: { delegate_signer: delegateSigner } };
    // The depositor's own key as its delegate is the shape that verifies offline.
    expect(
      adapter.recoverSigner(signed, { network: 'stellar:testnet', asset: 'x', account: DELEGATE }),
    ).toBe(DELEGATE);
    // Any other account is not shown to have this key as its delegate.
    expect(() =>
      adapter.recoverSigner(signed, { network: 'stellar:testnet', asset: 'x', account: 'y' }),
    ).toThrow(/delegate signer is not source\.account/);
  });
});

// Turnkey's Stellar address format is unconfirmed, so every path fails closed.
describe('Turnkey Stellar signer (not supported yet)', () => {
  const cfg = {
    organizationId: 'org',
    walletId: 'wallet',
    apiPublicKey: 'pub',
    apiPrivateKey: 'priv',
  };
  const touched: string[] = [];
  const tripwire = new Proxy(
    {},
    {
      get: (_t, name) => {
        touched.push(String(name));
        throw new Error(`the Turnkey client must not be used: ${String(name)}`);
      },
    },
  ) as never;

  it('the factory refuses before a wallet is contacted', () => {
    expect(() => createSenderSigner('stellar:testnet', { provider: 'turnkey', ...cfg })).toThrow(
      STELLAR_TURNKEY_UNSUPPORTED,
    );
    expect(() => createSenderSigner('STELLAR:pubnet', { provider: 'turnkey', ...cfg })).toThrow(
      /not supported yet/,
    );
  });

  it('the Turnkey implementation refuses without touching the client or the message', async () => {
    await expect(
      signWithTurnkeyClient(tripwire, 'stellar', cfg, DIGEST, undefined),
    ).rejects.toThrow(STELLAR_TURNKEY_UNSUPPORTED);
    expect(touched).toEqual([]);
  });

  it('a Turnkey signer built directly for stellar signs nothing', async () => {
    const signer = new TurnkeySenderSigner('stellar', cfg, async () => ({
      turnkeySign: async () => {
        throw new Error('unreachable');
      },
    }));
    await expect(signer.sign(message())).rejects.toThrow();
  });
});
