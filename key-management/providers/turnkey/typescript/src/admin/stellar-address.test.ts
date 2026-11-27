import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { isStellarAccountId } from './stellar-address';

describe('isStellarAccountId', () => {
  it('accepts account ids the Stellar SDK generates', () => {
    for (let i = 0; i < 50; i++) expect(isStellarAccountId(Keypair.random().publicKey())).toBe(true);
  });

  it('agrees with the SDK on a corrupted checksum (last character changed)', () => {
    const good = Keypair.random().publicKey();
    const bad = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
    expect(StrKey.isValidEd25519PublicKey(bad)).toBe(false);
    expect(isStellarAccountId(bad)).toBe(false);
  });

  it('refuses the all-zero placeholder even though its checksum is valid', () => {
    const zero = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));
    expect(StrKey.isValidEd25519PublicKey(zero)).toBe(true);
    expect(isStellarAccountId(zero)).toBe(false);
  });

  it('refuses other strkey kinds, hex, lowercase and wrong lengths', () => {
    const k = Keypair.random();
    expect(isStellarAccountId(k.secret())).toBe(false);
    expect(isStellarAccountId(StrKey.encodeContract(Buffer.alloc(32, 1)))).toBe(false);
    expect(isStellarAccountId(k.rawPublicKey().toString('hex'))).toBe(false);
    expect(isStellarAccountId(k.publicKey().toLowerCase())).toBe(false);
    expect(isStellarAccountId(k.publicKey().slice(1))).toBe(false);
    expect(isStellarAccountId(k.publicKey() + 'A')).toBe(false);
    expect(isStellarAccountId('')).toBe(false);
  });
});
