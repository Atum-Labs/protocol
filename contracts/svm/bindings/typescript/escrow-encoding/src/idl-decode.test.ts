/**
 * scripts/lib/idl-decode.mjs: Borsh decoding driven by an Anchor IDL, for the values the
 * deployed-events check compares. Written against the IDL's own field list, so a field the IDL
 * moved lands under the wrong name, which is exactly what the value checks are there to catch.
 */

import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { decodeEvent, decodeInstruction } from '../scripts/lib/idl-decode.mjs';

const settler = Buffer.alloc(32, 7);
const idl = {
  events: [{ name: 'Released', discriminator: [1, 2, 3, 4, 5, 6, 7, 8] }],
  instructions: [],
  types: [
    {
      name: 'Released',
      type: {
        kind: 'struct',
        fields: [
          { name: 'settler', type: 'pubkey' },
          { name: 'amount', type: 'u64' },
          { name: 'quote_hash', type: { array: ['u8', 32] } },
        ],
      },
    },
  ],
};

describe('decodeEvent', () => {
  it('names each field of an event payload: pubkeys base58, u64 as bigint, byte arrays as hex', () => {
    const amount = Buffer.alloc(8);
    amount.writeBigUInt64LE(1234n);
    const payload = Buffer.concat([
      Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
      settler,
      amount,
      Buffer.alloc(32, 0xab),
    ]);
    expect(decodeEvent(idl, payload)).toEqual({
      name: 'Released',
      fields: {
        settler: 'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx',
        amount: 1234n,
        quote_hash: 'ab'.repeat(32),
      },
    });
  });
});

describe('decodeEvent: bool', () => {
  // The proxy's SettlerAllowlistEnforcementSet carries one. Every event a program emits is decoded,
  // so a type the decoder lacks would abort the whole run on the first admin event it met.
  it('decodes a bool field', () => {
    const flag = {
      events: [{ name: 'Set', discriminator: [1, 1, 1, 1, 1, 1, 1, 1] }],
      instructions: [],
      types: [
        { name: 'Set', type: { kind: 'struct', fields: [{ name: 'enforced', type: 'bool' }] } },
      ],
    };
    const payload = Buffer.concat([Buffer.alloc(8, 1), Buffer.from([1])]);
    expect(decodeEvent(flag, payload)).toEqual({ name: 'Set', fields: { enforced: true } });
  });
});

describe('decodeInstruction', () => {
  // The IDL's instruction section is independent of its event section: the client that built this
  // instruction serialized it, and the account list is what the program was actually handed.
  const withIx = {
    ...idl,
    instructions: [
      {
        name: 'deposit',
        discriminator: [9, 9, 9, 9, 9, 9, 9, 9],
        accounts: [{ name: 'authority' }, { name: 'deposit' }],
        args: [
          { name: 'destination', type: 'string' },
          { name: 'amount', type: 'u64' },
        ],
      },
    ],
  };
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(500n);
  const destination = Buffer.from('0xabc');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(destination.length);
  const data = Buffer.concat([Buffer.alloc(8, 9), length, destination, amount]);

  it('names the accounts and decodes the args, including a length-prefixed string', () => {
    const ix = { programId: 'Prog', accounts: ['Auth', 'Dep'], data: bs58.encode(data) };
    expect(decodeInstruction(withIx, ix)).toEqual({
      name: 'deposit',
      accounts: { authority: 'Auth', deposit: 'Dep' },
      args: { destination: '0xabc', amount: 500n },
    });
  });

  // Data from an older client is shorter than the IDL's args. That instruction is not decodable with
  // this IDL; an event it emitted is then reported unpaired, which fails the run.
  it('returns null when the data ends before the args do', () => {
    const ix = {
      programId: 'Prog',
      accounts: ['Auth', 'Dep'],
      data: bs58.encode(data.subarray(0, 14)),
    };
    expect(decodeInstruction(withIx, ix)).toBeNull();
  });

  it('returns null for an instruction the IDL does not declare', () => {
    const ix = { programId: 'Prog', accounts: [], data: bs58.encode(Buffer.alloc(8, 1)) };
    expect(decodeInstruction(withIx, ix)).toBeNull();
  });
});
