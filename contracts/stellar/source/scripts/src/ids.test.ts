import { Keypair, StrKey, hash } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { assertWasm, deploySalt, deriveContractId, tokenBalanceKey } from './ids.js';
import { PASSPHRASE_PUBLIC, PASSPHRASE_TESTNET } from '@atum-labs/stellar-escrow-encoding';

const deployer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();

describe('contract id derivation', () => {
  it('matches a hand-assembled HashIdPreimage (independent of the SDK xdr builders)', () => {
    const salt = deploySalt('escrow', 'v1');
    const u32 = (n: number) =>
      Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
    const networkId = hash(Buffer.from(PASSPHRASE_TESTNET, 'utf8'));
    const raw = StrKey.decodeEd25519PublicKey(deployer);
    const preimage = Buffer.concat([
      u32(8), // ENVELOPE_TYPE_CONTRACT_ID
      networkId,
      u32(0), // CONTRACT_ID_PREIMAGE_FROM_ADDRESS
      u32(0), // SC_ADDRESS_TYPE_ACCOUNT
      u32(0), // PUBLIC_KEY_TYPE_ED25519
      raw,
      salt,
    ]);
    const expected = StrKey.encodeContract(hash(preimage));
    expect(deriveContractId(PASSPHRASE_TESTNET, deployer, salt)).toBe(expected);
  });

  it('is deterministic and varies with network, deployer, kind and tag', () => {
    const s = deploySalt('escrow', 'v1');
    const a = deriveContractId(PASSPHRASE_TESTNET, deployer, s);
    expect(deriveContractId(PASSPHRASE_TESTNET, deployer, s)).toBe(a);
    expect(deriveContractId(PASSPHRASE_PUBLIC, deployer, s)).not.toBe(a);
    expect(deriveContractId(PASSPHRASE_TESTNET, Keypair.random().publicKey(), s)).not.toBe(a);
    expect(
      deriveContractId(PASSPHRASE_TESTNET, deployer, deploySalt('fulfillment-proxy', 'v1')),
    ).not.toBe(a);
    expect(deriveContractId(PASSPHRASE_TESTNET, deployer, deploySalt('escrow', 'v2'))).not.toBe(a);
    expect(StrKey.isValidContract(a)).toBe(true);
  });
});

describe('token balance key', () => {
  it('is a persistent Balance(holder) entry in the token contract, assembled by hand', () => {
    const u32 = (n: number) =>
      Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
    const token = StrKey.encodeContract(Buffer.alloc(32, 0x11));
    const holder = StrKey.encodeContract(Buffer.alloc(32, 0x22));
    const expected = Buffer.concat([
      u32(6), // LedgerEntryType CONTRACT_DATA
      u32(1), // SC_ADDRESS_TYPE_CONTRACT
      Buffer.alloc(32, 0x11), // the token contract
      u32(16), // SCV_VEC
      u32(1), // optional vec present
      u32(2), // two elements
      u32(15), // SCV_SYMBOL
      u32(7),
      Buffer.from('Balance\0', 'latin1'), // 7 bytes, padded to 8
      u32(18), // SCV_ADDRESS
      u32(1), // SC_ADDRESS_TYPE_CONTRACT
      Buffer.alloc(32, 0x22), // the holder
      u32(1), // ContractDataDurability PERSISTENT
    ]);
    expect(Buffer.from(tokenBalanceKey(token, holder).toXDR())).toEqual(expected);
  });
});

describe('wasm check', () => {
  it('accepts the wasm magic and rejects anything else', () => {
    expect(() => assertWasm(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 9]), 'x')).not.toThrow();
    expect(() => assertWasm(Buffer.from('not wasm'), 'x')).toThrow(/not a WebAssembly/);
    expect(() => assertWasm(new Uint8Array(0), 'x')).toThrow(/not a WebAssembly/);
  });
});
