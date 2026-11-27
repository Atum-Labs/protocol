import bs58 from 'bs58';
import { ethers } from 'ethers';
import nacl from 'tweetnacl';
import {
  signDeclaration,
  verifyDeclaration,
  computeRequestHash,
  signerFromEthersWallet,
} from './signing';
import { signPaymentRequest } from './index';
import type { DeclarationSigner } from './signing';
import type { PaymentRequest, SignedMessage } from './generated/types.gen';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// ethers owns the key; the SDK only borrows a digest-signing capability from it.
const wallet = new ethers.Wallet(PRIVATE_KEY);
const signer = signerFromEthersWallet(wallet);
// proof.created is inside the signed payload, so it is pinned rather than left to the clock.
const CREATED = '2026-04-01T00:00:00.000Z';

// The full top-level field set: computeRequestHash refuses a partial document, so a minimal
// stub would only exercise its validation.
function request(): PaymentRequest {
  return {
    version: '1.0',
    request_id: 'req-declaration-1',
    source: {
      account: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      asset_identifier: 'eip155:1/erc20:0xA0b86a33E6441E13acB9c4A4948ee8C4605A6a5A',
    },
    destination: [
      {
        account: '0x0000000000000000000000000000000000000002',
        asset_identifier: 'eip155:1/erc20:0xbbb',
      },
    ],
    fulfillment_amount: '1000000',
    quote_deadline: '2030-01-01T00:00:00Z',
    fulfillment_deadline: '2030-01-02T00:00:00Z',
    escrow_contract_address: '0x0000000000000000000000000000000000000003',
    fulfillment_verifier: {
      account: '0x0000000000000000000000000000000000000004',
      endpoint: 'https://veri-fill.example.com',
    },
    sender_auth: {
      message_scheme: 'EVM_PERMIT2',
      signed_messages: [
        {
          message: '0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f',
          signature: '0xabcdef1234567890',
        },
      ],
    },
  } as unknown as PaymentRequest;
}

describe('signDeclaration', () => {
  it('attaches a Data Integrity proof naming the signing key', async () => {
    const signed = await signDeclaration(request(), signer, { chainId: 1, created: CREATED });

    expect(signed.proof).toBeDefined();
    expect(signed.proof.type).toBe('EcdsaSecp256k1RecoverySignature2020');
    expect(signed.proof.proofPurpose).toBe('assertionMethod');
    expect(signed.proof.created).toBe(CREATED);

    // The verificationMethod must name the address the key derives to. Derived here with
    // ethers rather than read back out of the proof, so the assertion compares two
    // independent computations.
    const address = new ethers.Wallet(PRIVATE_KEY).address.toLowerCase();
    expect(signed.proof.verificationMethod).toBe(`did:pkh:eip155:1:${address}#blockchainAccountId`);
  });

  it('is reproducible for the same request, key and instant', async () => {
    const a = await signDeclaration(request(), signer, { chainId: 1, created: CREATED });
    const b = await signDeclaration(request(), signer, { chainId: 1, created: CREATED });
    expect(a.proof.jws).toBe(b.proof.jws);
  });

  it('does not mutate the request it was given', async () => {
    const original = request();
    await signDeclaration(original, signer, { chainId: 1, created: CREATED });
    expect(original).not.toHaveProperty('proof');
    expect(original).not.toHaveProperty('@context');
  });

  it('round-trips through verifyDeclaration, recovering the signing address', async () => {
    const signed = await signDeclaration(request(), signer, { chainId: 1, created: CREATED });
    const result = await verifyDeclaration(signed);

    const address = new ethers.Wallet(PRIVATE_KEY).address.toLowerCase();
    expect(result.signer.kind).toBe('recovered-secp256k1');
    if (result.signer.kind !== 'recovered-secp256k1') throw new Error('unreachable');
    expect(result.signer.address).toBe(address);
    expect(result.signer.did).toBe(`did:pkh:eip155:1:${address}`);
  });

  // The upstream verifier does NOT reject a tampered document: a recovery-based suite simply
  // recovers a different address, and it returns that alongside the document's own claimed
  // DID without comparing them. This wrapper performs the binding, so the assertion below is
  // testing THIS package's check, not the library's.
  it('rejects a tampered document by throwing', async () => {
    const signed = await signDeclaration(request(), signer, { chainId: 1, created: CREATED });
    const tampered = { ...signed, request_id: 'req-someone-elses' } as typeof signed;
    await expect(verifyDeclaration(tampered)).rejects.toThrow();
  });
});

describe('computeRequestHash', () => {
  it('is stable for the same request and differs for a changed one', async () => {
    const a = await computeRequestHash(request());
    const b = await computeRequestHash(request());
    expect(a).toBe(b);

    const changed = { ...request(), request_id: 'req-declaration-2' } as PaymentRequest;
    expect(await computeRequestHash(changed)).not.toBe(a);
  });
});

// The two functions differ by one word in their names and do entirely different jobs. This is
// the guard against the conflation: neither does the other's work, so a caller that signs only
// one has authorized a transfer by an unidentified document, or attested a document that
// authorizes nothing.
describe('the document signature and the transfer authorization are not interchangeable', () => {
  function requestWithSenderAuth(): PaymentRequest {
    const base = request() as unknown as Record<string, unknown>;
    return {
      ...base,
      request_id: 'req-both-1',
      sender_auth: {
        message_scheme: 'EVM_PERMIT2',
        signed_messages: [{ message: '0xaa', signature: '' } as SignedMessage],
      },
    } as unknown as PaymentRequest;
  }

  it('signDeclaration leaves sender_auth unsigned', async () => {
    const signed = await signDeclaration(requestWithSenderAuth(), signer, {
      chainId: 1,
      created: CREATED,
    });
    expect(signed.proof).toBeDefined();
    expect(signed.sender_auth?.signed_messages?.[0]?.signature).toBe('');
  });

  it('signPaymentRequest attaches no document proof', async () => {
    const signer = {
      sign: async () => ({ signature: '0xdeadbeef' }),
    };
    const signed = await signPaymentRequest(requestWithSenderAuth(), signer);
    expect(signed.sender_auth?.signed_messages?.[0]?.signature).toBe('0xdeadbeef');
    expect(signed).not.toHaveProperty('proof');
  });
});

// The point of the signer seam: a holder whose key never enters this process can still sign.
describe('signDeclaration accepts a signer rather than a key', () => {
  it('works with a custodial-style async signer', async () => {
    const remote: DeclarationSigner = {
      getAddress: async () => wallet.address,
      signDigest: async (digest) => {
        await new Promise((r) => setTimeout(r, 1));
        const sig = wallet.signingKey.sign(digest);
        const out = new Uint8Array(65);
        out.set(ethers.getBytes(sig.r), 0);
        out.set(ethers.getBytes(sig.s), 32);
        out[64] = sig.yParity;
        return out;
      },
    };
    const signed = await signDeclaration(request(), remote, { chainId: 1, created: CREATED });
    const res = await verifyDeclaration(signed);
    expect(res.signer.kind).toBe('recovered-secp256k1');
  });

  it('produces the same proof as the ethers adapter for the same key', async () => {
    const viaAdapter = await signDeclaration(request(), signer, { chainId: 1, created: CREATED });
    const manual: DeclarationSigner = {
      getAddress: () => wallet.address,
      signDigest: (digest) => {
        const sig = wallet.signingKey.sign(digest);
        const out = new Uint8Array(65);
        out.set(ethers.getBytes(sig.r), 0);
        out.set(ethers.getBytes(sig.s), 32);
        out[64] = sig.yParity;
        return out;
      },
    };
    const viaManual = await signDeclaration(request(), manual, { chainId: 1, created: CREATED });
    expect(viaManual.proof.jws).toBe(viaAdapter.proof.jws);
  });

  it('refuses a signer that pre-applied the recovery alignment', async () => {
    const preApplied: DeclarationSigner = {
      getAddress: () => wallet.address,
      signDigest: (digest) => {
        const sig = wallet.signingKey.sign(digest);
        const out = new Uint8Array(65);
        out.set(ethers.getBytes(sig.r), 0);
        out.set(ethers.getBytes(sig.s), 32);
        out[64] = sig.yParity + 27;
        return out;
      },
    };
    await expect(
      signDeclaration(request(), preApplied, { chainId: 1, created: CREATED }),
    ).rejects.toThrow(/must not pre-apply/);
  });

  it('does not accept a hex private key where a signer belongs', async () => {
    // The old shape. It must fail loudly rather than be silently coerced, so a caller
    // upgrading gets an error instead of a mystery.
    await expect(
      signDeclaration(request(), PRIVATE_KEY as unknown as DeclarationSigner, {
        chainId: 1,
        created: CREATED,
      }),
    ).rejects.toThrow(/must implement getAddress and signDigest/);
  });
});

describe('verifyDeclaration on an Ed25519 proof', () => {
  it("takes a Solana payer's public key from the proof's DID", async () => {
    /* eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded as declaration-signing.ts loads it */
    const ldSigning = require('@atum-labs/payment-request-ld-signing');
    const key = nacl.sign.keyPair.fromSeed(
      Buffer.from(ethers.id('declaration test solana payer').slice(2), 'hex'),
    );
    const did = `did:pkh:solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${bs58.encode(key.publicKey)}`;
    const signed = await ldSigning.signPaymentRequestEd25519(request(), key.secretKey, {
      verificationMethod: `${did}#blockchainAccountId`,
      created: CREATED,
    });

    const { signer: verified } = await verifyDeclaration(signed);
    expect(verified).toEqual({
      kind: 'self-asserted-ed25519',
      publicKey: key.publicKey,
      did,
    });
  });
});
