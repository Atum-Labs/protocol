import { SigningKey, TypedDataEncoder, Wallet, getBytes, keccak256 } from 'ethers';
import { describe, expect, it } from 'vitest';

import type { TurnkeyClient } from '../client';
import type { SignRawPayloadInput } from '../types';
import {
  signSecp256k1PreimageAndVerify,
  signSecp256k1TypedDataAndVerify,
} from './secp256k1-helpers';

const PRIVATE_KEY = '0x' + '11'.repeat(32);
const wallet = new Wallet(PRIVATE_KEY);
const signingKey = new SigningKey(PRIVATE_KEY);
const ADDR_LOWER = wallet.address.toLowerCase();

// A Permit2 PermitWitnessTransferFrom with a nested DepositWitness carrying a plaintext
// CAIP-10 destination. The nesting is forced by Permit2 (the outer
// struct is fixed by the canonical deployment), so `destination` can only ever live at
// message.witness.destination.
const DOMAIN = {
  name: 'Permit2',
  chainId: 8453,
  verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
};

const TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'DepositWitness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  DepositWitness: [
    { name: 'reserver', type: 'address' },
    { name: 'releaser', type: 'address' },
    { name: 'destination', type: 'string' },
  ],
};

const DESTINATION = 'eip155:8453:0xa0ee7a142d267c1f36714e4a8f75612f20a79720';

const MESSAGE = {
  permitted: { token: '0xa0b86a33e6441e13acb9c4a4948ee8c4605a6a5a', amount: '1000000' },
  spender: '0x0000000000000000000000000000000000000001',
  nonce: '1234567890123456789',
  deadline: '1705320000',
  witness: {
    reserver: '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720',
    releaser: '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720',
    destination: DESTINATION,
  },
};

/**
 * Fake TurnkeyClient that records the request and signs the way Turnkey would: for the EIP712
 * encoding it parses the JSON and derives the EIP-712 digest itself (server-side), for the
 * HEXADECIMAL + KECCAK256 encoding it keccaks the supplied preimage.
 */
function fakeClient(): { client: TurnkeyClient; calls: SignRawPayloadInput[] } {
  const calls: SignRawPayloadInput[] = [];
  const client = {
    async signRawPayload(input: SignRawPayloadInput) {
      calls.push(input);
      let digest: string;
      if (input.encoding === 'PAYLOAD_ENCODING_EIP712') {
        const parsed = JSON.parse(input.payload) as {
          domain: Record<string, unknown>;
          types: Record<string, { name: string; type: string }[]>;
          message: Record<string, unknown>;
        };
        // ethers infers EIP712Domain, so strip it back out before re-hashing.
        const { EIP712Domain: _omit, ...structTypes } = parsed.types;
        digest = TypedDataEncoder.hash(parsed.domain, structTypes, parsed.message);
      } else {
        digest = keccak256(getBytes('0x' + input.payload));
      }
      const sig = signingKey.sign(digest);
      return { r: sig.r, s: sig.s, v: sig.v.toString(16) };
    },
  } as unknown as TurnkeyClient;
  return { client, calls };
}

describe('signSecp256k1TypedDataAndVerify', () => {
  it('produces the same signature bytes as ethers Wallet.signTypedData', async () => {
    const { client } = fakeClient();
    const viaTurnkey = await signSecp256k1TypedDataAndVerify(
      client,
      wallet.address,
      DOMAIN,
      TYPES,
      MESSAGE,
      ADDR_LOWER,
    );
    const viaLocalKey = await wallet.signTypedData(DOMAIN, TYPES, MESSAGE);
    expect(viaTurnkey).toBe(viaLocalKey);
  });

  it('produces the same signature as signing the collapsed preimage', async () => {
    // Sending typed data must change nothing on the wire or on chain. The two routes end up over
    // the same keccak256(0x1901 || domainSeparator || hashStruct), so the signatures must match.
    const { client } = fakeClient();
    const typed = await signSecp256k1TypedDataAndVerify(
      client,
      wallet.address,
      DOMAIN,
      TYPES,
      MESSAGE,
      ADDR_LOWER,
    );
    const preimage = getBytes(TypedDataEncoder.encode(DOMAIN, TYPES, MESSAGE));
    const collapsed = await signSecp256k1PreimageAndVerify(
      client,
      wallet.address,
      preimage,
      ADDR_LOWER,
    );
    expect(typed).toBe(collapsed);
  });

  it('sends PAYLOAD_ENCODING_EIP712 so Turnkey can parse the struct', async () => {
    const { client, calls } = fakeClient();
    await signSecp256k1TypedDataAndVerify(
      client,
      wallet.address,
      DOMAIN,
      TYPES,
      MESSAGE,
      ADDR_LOWER,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.encoding).toBe('PAYLOAD_ENCODING_EIP712');
    expect(calls[0]!.signWith).toBe(wallet.address);
  });

  it('puts the nested destination on the wire in plaintext for the policy engine', async () => {
    // This is the property that makes `eth.eip_712.message['witness']['destination'] == '…'`
    // writable as a Turnkey policy. A HEXADECIMAL payload carries the destination already keccak'd
    // inside hashStruct, so Turnkey would see an opaque 66-byte blob and no field rule would apply.
    const { client, calls } = fakeClient();
    await signSecp256k1TypedDataAndVerify(
      client,
      wallet.address,
      DOMAIN,
      TYPES,
      MESSAGE,
      ADDR_LOWER,
    );
    const sent = JSON.parse(calls[0]!.payload);
    expect(sent.primaryType).toBe('PermitWitnessTransferFrom');
    expect(sent.message.witness.destination).toBe(DESTINATION);
    expect(calls[0]!.payload).toContain(DESTINATION);
  });

  it('fails closed when Turnkey returns a signature from a different key', async () => {
    const otherKey = new SigningKey('0x' + '22'.repeat(32));
    const client = {
      async signRawPayload() {
        const sig = otherKey.sign(TypedDataEncoder.hash(DOMAIN, TYPES, MESSAGE));
        return { r: sig.r, s: sig.s, v: sig.v.toString(16) };
      },
    } as unknown as TurnkeyClient;
    await expect(
      signSecp256k1TypedDataAndVerify(client, wallet.address, DOMAIN, TYPES, MESSAGE, ADDR_LOWER),
    ).rejects.toThrow(/sign-then-recover mismatch/);
  });

  it('fails closed on malformed signature parts', async () => {
    const client = {
      async signRawPayload() {
        return { r: 'not-hex', s: 'not-hex', v: 'zz' };
      },
    } as unknown as TurnkeyClient;
    await expect(
      signSecp256k1TypedDataAndVerify(client, wallet.address, DOMAIN, TYPES, MESSAGE, ADDR_LOWER),
    ).rejects.toThrow(/TURNKEY_BAD_RESPONSE|malformed/);
  });
});
