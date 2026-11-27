import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { getChainAdapter } from './index';
import { stellarAdapter } from './stellar';

// Strkeys from the Stellar contract fixtures: a G account and a C contract.
const ACCOUNT = 'GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH';
const CONTRACT = 'CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5';

const signer = { publicKey: ACCOUNT, sign: async () => new Uint8Array(64) };

describe('stellarAdapter', () => {
  it('is what a stellar network resolves to, on pubnet and testnet', () => {
    expect(getChainAdapter('stellar:testnet')).toBe(stellarAdapter);
    expect(getChainAdapter('stellar:pubnet')).toBe(stellarAdapter);
  });

  it("returns the signer's G account as the source account", async () => {
    expect(await stellarAdapter.getAddress(signer)).toBe(ACCOUNT);
  });

  it.each([
    ['a C contract', CONTRACT],
    ['an EVM address', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'],
    ['a muxed M address', `M${ACCOUNT.slice(1)}`],
    ['lowercase', ACCOUNT.toLowerCase()],
    ['a truncated key', ACCOUNT.slice(0, 55)],
    ['empty', ''],
  ])('refuses %s as the signer account', async (_label, publicKey) => {
    await expect(stellarAdapter.getAddress({ ...signer, publicKey })).rejects.toThrow(
      /G… account strkey/,
    );
  });

  it('refuses an EVM typed-data signer', async () => {
    await expect(
      stellarAdapter.getAddress(new ethers.Wallet('0x' + '11'.repeat(32))),
    ).rejects.toThrow(/requires an Ed25519/);
  });

  it.each(['testnet', 'pubnet'])('builds the CAIP-19 id with the sep41 namespace on %s', (ref) => {
    expect(stellarAdapter.assetIdentifier(`stellar:${ref}`, CONTRACT)).toBe(
      `stellar:${ref}/sep41:${CONTRACT}`,
    );
  });

  it.each([
    ['a G account', ACCOUNT],
    ['a classic asset', 'USDC:GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH'],
    ['lowercase', CONTRACT.toLowerCase()],
    ['an EVM address', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'],
  ])('refuses %s as the token', (_label, asset) => {
    expect(() => stellarAdapter.assetIdentifier('stellar:testnet', asset)).toThrow(/SEP-41 token/);
  });

  it('leaves a role address unchanged, case and all', () => {
    expect(stellarAdapter.normalizeRoleAddress(ACCOUNT)).toBe(ACCOUNT);
    expect(stellarAdapter.normalizeRoleAddress(CONTRACT)).toBe(CONTRACT);
  });
});
