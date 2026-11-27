import bs58 from 'bs58';
import { SigningKey, TypedDataEncoder, Wallet, getBytes, recoverAddress } from 'ethers';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { TurnkeyClient } from '../client';
import { noopLogger } from '../logger';
import type { SignRawPayloadInput } from '../types';
import { TurnkeyEvmSigner } from './evm';
import { TurnkeyTronSigner } from './tron';

// The settler identity domain: no chainId, so EVM and Tron sign the same digest.
const IDENTITY_DOMAIN = {
  name: 'Atum Settler Identity',
  version: '1',
  verifyingContract: '0x1238944D14f50709Cc27101B2746fDeFCE08B37e',
};
const SETTLER_PROOF_TYPES = {
  SettlerProof: [
    { name: 'proofHash', type: 'bytes32' },
    { name: 'docHash', type: 'bytes32' },
  ],
};
const SETTLER_PROOF = { proofHash: '0x' + '11'.repeat(32), docHash: '0x' + '22'.repeat(32) };
const SETTLER_PROOF_DIGEST = '0x073a9ae5f5f24d3e1e2264d95d0b4721e23c6550288c210e8eb35b0d5869b0e2';

const PRIVATE_KEY = '0x' + '44'.repeat(32);
const wallet = new Wallet(PRIVATE_KEY);
const signingKey = new SigningKey(PRIVATE_KEY);

function tronBase58(evmAddress: string): string {
  const payload = Buffer.concat([Buffer.from([0x41]), Buffer.from(getBytes(evmAddress))]);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest();
  return bs58.encode(Buffer.concat([payload, sha(sha(payload)).subarray(0, 4)]));
}

/** Fake Turnkey that exposes both account formats and signs EIP712 payloads server side. */
function fakeClient(): { client: TurnkeyClient; calls: SignRawPayloadInput[] } {
  const calls: SignRawPayloadInput[] = [];
  const client = {
    async listWalletAccounts() {
      return [
        { address: wallet.address, addressFormat: 'ADDRESS_FORMAT_ETHEREUM' },
        { address: tronBase58(wallet.address), addressFormat: 'ADDRESS_FORMAT_TRON' },
      ];
    },
    async signRawPayload(input: SignRawPayloadInput) {
      calls.push(input);
      if (input.encoding !== 'PAYLOAD_ENCODING_EIP712') throw new Error('expected EIP712');
      const parsed = JSON.parse(input.payload) as {
        domain: Record<string, unknown>;
        types: Record<string, { name: string; type: string }[]>;
        message: Record<string, unknown>;
      };
      const { EIP712Domain: _omit, ...structTypes } = parsed.types;
      const sig = signingKey.sign(
        TypedDataEncoder.hash(parsed.domain, structTypes, parsed.message),
      );
      return { r: sig.r, s: sig.s, v: sig.v.toString(16) };
    },
  } as unknown as TurnkeyClient;
  return { client, calls };
}

const deps = { walletId: 'w', log: noopLogger, discoveryTimeoutMs: 1_000 };

describe.each([
  ['EVM', (c: TurnkeyClient) => new TurnkeyEvmSigner(c, deps)],
  ['Tron', (c: TurnkeyClient) => new TurnkeyTronSigner(c, deps)],
] as const)('%s signer: identity-domain typed data', (_label, make) => {
  it('signs SettlerProof as EIP712 + NOT_APPLICABLE with no chainId in the domain', async () => {
    const { client, calls } = fakeClient();
    const signer = make(client);
    await signer.initialize();
    const sig = await signer.signTypedData(IDENTITY_DOMAIN, SETTLER_PROOF_TYPES, SETTLER_PROOF);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.encoding).toBe('PAYLOAD_ENCODING_EIP712');
    expect(calls[0]!.hashFunction).toBe('HASH_FUNCTION_NOT_APPLICABLE');
    const sent = JSON.parse(calls[0]!.payload);
    expect(sent.primaryType).toBe('SettlerProof');
    expect(sent.types.EIP712Domain.map((f: { name: string }) => f.name)).toEqual([
      'name',
      'version',
      'verifyingContract',
    ]);
    expect(sent.domain.chainId).toBeUndefined();
    expect(recoverAddress(SETTLER_PROOF_DIGEST, sig)).toBe(wallet.address);
  });
});
