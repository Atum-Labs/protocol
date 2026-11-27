import bs58 from 'bs58';
import { ethers } from 'ethers';
import nacl from 'tweetnacl';

import { verifyReserveAuth } from '@atum-labs/payment-request-sender-auth';
import type { ReserveMessageInput } from '@atum-labs/payment-request-sender-auth';
import { signReserveAuth } from './reserve-auth';
import { createSenderSigner } from './signers';
import { TurnkeySenderSigner } from './signers/turnkey';
import { signWithTurnkeyClient } from './signers/turnkey-impl';
import { tronBase58 } from './test-support/quotes';

const RESERVER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const reserver = new ethers.Wallet(RESERVER_KEY);

// Turnkey signs typed data as its EIP-712 hash and a Solana message as its bytes; these sign the
// payload they are sent with the reserver's key, as Turnkey does server side.
function signTypedDataPayload(payload: string) {
  const td = JSON.parse(payload) as {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    message: Record<string, unknown>;
  };
  const { EIP712Domain: _derived, ...types } = td.types;
  const sig = reserver.signingKey.sign(ethers.TypedDataEncoder.hash(td.domain, types, td.message));
  return { r: sig.r, s: sig.s, v: sig.yParity.toString(16) };
}

const SOLANA_SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('hex');
const solanaReserver = nacl.sign.keyPair.fromSeed(Buffer.from(SOLANA_SEED, 'hex'));

function signSolanaPayload(payload: string) {
  const sig = nacl.sign.detached(Buffer.from(payload, 'hex'), solanaReserver.secretKey);
  return {
    r: Buffer.from(sig.slice(0, 32)).toString('hex'),
    s: Buffer.from(sig.slice(32)).toString('hex'),
    v: '00',
  };
}

const RESERVE = {
  depositId: '0x' + 'ab'.repeat(32),
  quoteHash: '0x' + 'cd'.repeat(32),
  sourceAmount: '999999',
};

const cases: {
  chain: 'eip155' | 'tron' | 'solana';
  input: ReserveMessageInput;
  privateKey: string;
  addressFormat: string;
  reserverAddress: string;
  signPayload: (payload: string) => { r: string; s: string; v: string };
}[] = [
  {
    chain: 'eip155',
    input: {
      ...RESERVE,
      network: 'eip155:42161',
      escrowContract: '0x1111111111111111111111111111111111111111',
      settler: '0x2222222222222222222222222222222222222222',
    },
    privateKey: RESERVER_KEY,
    addressFormat: 'ADDRESS_FORMAT_ETHEREUM',
    reserverAddress: reserver.address,
    signPayload: signTypedDataPayload,
  },
  {
    chain: 'tron',
    input: {
      ...RESERVE,
      network: 'tron:shasta',
      escrowContract: tronBase58('0x1111111111111111111111111111111111111111'),
      settler: tronBase58('0x2222222222222222222222222222222222222222'),
    },
    privateKey: RESERVER_KEY,
    addressFormat: 'ADDRESS_FORMAT_TRON',
    reserverAddress: tronBase58(reserver.address),
    signPayload: signTypedDataPayload,
  },
  {
    chain: 'solana',
    input: {
      ...RESERVE,
      network: 'solana:devnet',
      escrowContract: bs58.encode(Buffer.alloc(32, 0x11)),
      settler: bs58.encode(Buffer.alloc(32, 0x22)),
      svmSignatureClusterId: 'devnet',
      svmSignatureDomainVersion: 5,
    },
    privateKey: SOLANA_SEED,
    addressFormat: 'ADDRESS_FORMAT_SOLANA',
    reserverAddress: bs58.encode(solanaReserver.publicKey),
    signPayload: signSolanaPayload,
  },
];

describe('signReserveAuth', () => {
  for (const { chain, input, privateKey, addressFormat, reserverAddress, signPayload } of cases) {
    it(`${chain}: the raw and the Turnkey signer sign the same reserve, which verifies to the reserver`, async () => {
      const raw = await signReserveAuth(input, createSenderSigner(input.network, { privateKey }));
      const client = {
        listWalletAccounts: async () => [{ addressFormat, address: reserverAddress }],
        signRawPayload: async ({ payload }: { payload: string }) => signPayload(payload),
      };
      const turnkey = await signReserveAuth(
        input,
        new TurnkeySenderSigner(
          chain,
          { organizationId: 'org', walletId: 'w', apiPublicKey: 'pub', apiPrivateKey: 'priv' },
          async () => ({
            turnkeySign: (chainPrefix, cfg, message, messagePrehash) =>
              signWithTurnkeyClient(
                client as never,
                chainPrefix,
                { ...cfg, discoveryTimeoutMs: 1000 },
                message,
                messagePrehash,
              ),
          }),
        ),
      );

      expect(turnkey).toEqual(raw);
      const got = await verifyReserveAuth(raw, { ...input, reserver: reserverAddress });
      expect(got.reason).toBe('verified');
    });
  }

  it('refuses input the escrow could never accept without calling the signer', async () => {
    const sign = jest.fn();

    await expect(
      signReserveAuth({ ...cases[0].input, sourceAmount: '0' }, { sign }),
    ).rejects.toThrow('reserve_auth: the sourceAmount is not a positive decimal integer string');
    expect(sign).not.toHaveBeenCalled();
  });
});
