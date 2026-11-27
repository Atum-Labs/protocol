import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { KeyLoadError, loadKeypair } from './keys.js';

const kp = Keypair.random();
const secret = kp.secret();

describe('key loading', () => {
  it('reads the default env var', () => {
    expect(loadKeypair({}, { STELLAR_DEPLOYER_SECRET: secret }).publicKey()).toBe(kp.publicKey());
  });

  it('reads a named env var', () => {
    expect(loadKeypair({ secretEnv: 'X' }, { X: ` ${secret}\n` }).publicKey()).toBe(kp.publicKey());
  });

  it('reads a Keychain item through `security`, with an argv list and no shell', () => {
    const calls: (readonly string[])[] = [];
    const k = loadKeypair({ keychainItem: 'atum-stellar-testnet-deployer' }, {}, (args) => {
      calls.push(args);
      return `${secret}\n`;
    });
    expect(k.publicKey()).toBe(kp.publicKey());
    expect(calls).toEqual([['find-generic-password', '-s', 'atum-stellar-testnet-deployer', '-w']]);
  });

  it('fails clearly when nothing is configured', () => {
    expect(() => loadKeypair({}, {})).toThrow(/STELLAR_DEPLOYER_SECRET is not set/);
  });

  it('does not echo a bad secret in the error', () => {
    const bad = 'SNOTAREALSECRETNOTAREALSECRETNOTAREALSECRETNOTAREALSECRET1';
    try {
      loadKeypair({ secretEnv: 'X' }, { X: bad });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(KeyLoadError);
      expect((e as Error).message).not.toContain(bad);
    }
  });

  it('does not echo a valid secret when the Keychain read fails', () => {
    expect(() =>
      loadKeypair({ keychainItem: 'missing' }, {}, () => {
        throw new Error(`boom ${secret}`);
      }),
    ).toThrow(/could not be read/);
    try {
      loadKeypair({ keychainItem: 'missing' }, {}, () => {
        throw new Error(`boom ${secret}`);
      });
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it('refuses two sources at once', () => {
    expect(() => loadKeypair({ secretEnv: 'X', keychainItem: 'Y' }, {})).toThrow(/only one/);
  });
});
