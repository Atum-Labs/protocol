import { Account, Keypair, Networks, Operation, TransactionBuilder, Asset } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { TurnkeyClient } from '../client';
import { noopLogger } from '../logger';
import type { SignRawPayloadInput } from '../types';
import { TurnkeyStellarSigner } from './stellar';

const kp = Keypair.random();
const other = Keypair.random();

interface Fake {
  client: TurnkeyClient;
  calls: SignRawPayloadInput[];
}

/**
 * A fake Turnkey: lists one XLM account and "signs" raw payloads with a local ed25519 key, the way
 * Turnkey does for HASH_FUNCTION_NOT_APPLICABLE (the bytes go to ed25519 verbatim). No network.
 */
function fake(opts: {
  address?: string;
  format?: string;
  signer?: Keypair;
  sigBytes?: (sig: Buffer) => Buffer;
} = {}): Fake {
  const calls: SignRawPayloadInput[] = [];
  const signer = opts.signer ?? kp;
  const client = {
    listWalletAccounts: async () => [
      { address: 'ignored', addressFormat: 'ADDRESS_FORMAT_ETHEREUM', curve: 'CURVE_SECP256K1' },
      {
        address: opts.address ?? kp.publicKey(),
        addressFormat: opts.format ?? 'ADDRESS_FORMAT_XLM',
        curve: 'CURVE_ED25519',
      },
    ],
    signRawPayload: async (input: SignRawPayloadInput) => {
      calls.push(input);
      const bytes =
        input.encoding === 'PAYLOAD_ENCODING_HEXADECIMAL'
          ? Buffer.from(input.payload.replace(/^0x/, ''), 'hex')
          : Buffer.from(input.payload, 'utf8');
      const sig = (opts.sigBytes ?? ((s) => s))(Buffer.from(signer.sign(bytes)));
      return { r: sig.subarray(0, 32).toString('hex'), s: sig.subarray(32).toString('hex'), v: '00' };
    },
  } as unknown as TurnkeyClient;
  return { client, calls };
}

const deps = { walletId: 'w', log: noopLogger, discoveryTimeoutMs: 1000 };

async function ready(f: Fake, pinned?: string) {
  const s = new TurnkeyStellarSigner(f.client, { ...deps, ...(pinned ? { pinnedAddress: pinned } : {}) });
  await s.initialize();
  return s;
}

function buildTx(source: string, passphrase = Networks.TESTNET) {
  return new TransactionBuilder(new Account(source, '100'), { fee: '100', networkPassphrase: passphrase })
    .addOperation(Operation.payment({ destination: other.publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimebounds(0, 1900000000)
    .build();
}

describe('TurnkeyStellarSigner', () => {
  it('resolves its identity from the ADDRESS_FORMAT_XLM account', async () => {
    const s = await ready(fake());
    expect(s.identity.address).toBe(kp.publicKey());
    expect(Buffer.from(s.identity.publicKey).equals(kp.rawPublicKey())).toBe(true);
  });

  it('refuses to be used before initialize()', () => {
    const s = new TurnkeyStellarSigner(fake().client, deps);
    expect(() => s.identity).toThrow(/before initialize/);
    return expect(s.signMessage(new Uint8Array(4))).rejects.toThrow(/before initialize/);
  });

  it('fails terminally when the wallet has no XLM account', async () => {
    const s = new TurnkeyStellarSigner(fake({ format: 'ADDRESS_FORMAT_SOLANA' }).client, deps);
    await expect(s.initialize()).rejects.toThrow(/no account with format ADDRESS_FORMAT_XLM/);
  });

  it('refuses an XLM account whose address is not a G... strkey', async () => {
    const s = new TurnkeyStellarSigner(fake({ address: kp.rawPublicKey().toString('hex') }).client, deps);
    await expect(s.initialize()).rejects.toThrow(/not a G\.\.\. ed25519 account strkey/);
  });

  it('refuses a pinned address that differs from the one Turnkey reports', async () => {
    const s = new TurnkeyStellarSigner(fake().client, { ...deps, pinnedAddress: other.publicKey() });
    await expect(s.initialize()).rejects.toThrow(/does not match/);
  });

  it('signs a message as raw ed25519 with NOT_APPLICABLE and returns 64 verified bytes', async () => {
    const f = fake();
    const s = await ready(f);
    const msg = Buffer.from([1, 2, 3, 4, 5]);
    const sig = await s.signMessage(msg);
    expect(sig.length).toBe(64);
    expect(kp.verify(msg, Buffer.from(sig))).toBe(true);
    expect(f.calls[0]).toMatchObject({
      signWith: kp.publicKey(),
      hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
    });
  });

  it('sends textual messages as TEXT_UTF8, the pairing the settler policy allows', async () => {
    const f = fake();
    const s = await ready(f);
    await s.signMessage(Buffer.from('settler-agent:gw-handshake:v1\nabc'));
    expect(f.calls[0]?.encoding).toBe('PAYLOAD_ENCODING_TEXT_UTF8');
  });

  it('rejects a signature made by a different key', async () => {
    const s = await ready(fake({ signer: other }));
    await expect(s.signMessage(Buffer.from([9]))).rejects.toThrow(/verify failed/);
  });

  it('rejects a signature of the wrong length', async () => {
    const s = await ready(fake({ sigBytes: (sig) => sig.subarray(0, 63) }));
    await expect(s.signMessage(Buffer.from([9]))).rejects.toThrow(/signature length 63/);
  });

  it('signs a transaction by sending its 32-byte hash and attaching a valid decorated signature', async () => {
    const f = fake();
    const s = await ready(f);
    const tx = buildTx(kp.publicKey());
    const hashBefore = Buffer.from(tx.hash());
    const signed = await s.signTransaction(tx);

    expect(signed).toBe(tx);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.payload).toBe(hashBefore.toString('hex'));
    expect(f.calls[0]?.hashFunction).toBe('HASH_FUNCTION_NOT_APPLICABLE');
    expect(signed.signatures).toHaveLength(1);
    // ed25519 is deterministic, so the SDK's own signing must produce the identical envelope.
    const reference = buildTx(kp.publicKey());
    reference.sign(kp);
    expect(signed.toXDR()).toBe(reference.toXDR());
  });

  it('binds the signature to the network passphrase through the transaction hash', async () => {
    const s = await ready(fake());
    const testnet = await s.signTransaction(buildTx(kp.publicKey(), Networks.TESTNET));
    const pub = await s.signTransaction(buildTx(kp.publicKey(), Networks.PUBLIC));
    expect(Buffer.from(testnet.hash()).equals(Buffer.from(pub.hash()))).toBe(false);
    // Each envelope carries the signature over ITS network's hash, as the SDK would produce.
    const refPub = buildTx(kp.publicKey(), Networks.PUBLIC);
    refPub.sign(kp);
    expect(pub.toXDR()).toBe(refPub.toXDR());
    expect(testnet.toXDR().slice(-40)).not.toBe(pub.toXDR().slice(-40));
  });

  it('refuses a transaction whose source account is not the signer', async () => {
    const f = fake();
    const s = await ready(f);
    await expect(s.signTransaction(buildTx(other.publicKey()))).rejects.toThrow(/source account is/);
    expect(f.calls).toHaveLength(0);
  });

  it('does not attach a signature Turnkey produced under another key', async () => {
    const s = await ready(fake({ signer: other }));
    const tx = buildTx(kp.publicKey());
    await expect(s.signTransaction(tx)).rejects.toThrow(/verify failed/);
    expect(tx.signatures).toHaveLength(0);
  });

  it('does not call Turnkey at all when identity resolution fails', async () => {
    const f = fake({ format: 'ADDRESS_FORMAT_SOLANA' });
    const spy = vi.spyOn(f.client, 'signRawPayload');
    const s = new TurnkeyStellarSigner(f.client, deps);
    await expect(s.initialize()).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
