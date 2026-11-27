/**
 * B1: the SenderSigner bridge — adapts x402's capability signer (EscrowSigner / SolanaSigner)
 * into the shared SDK's `SenderSigner`. The oracle is a round-trip: build a message with the
 * SDK, sign it through the bridge, and confirm the SDK's own `recoverAndVerify` recovers to the
 * signer — proving the bridge signs exactly what the facilitator will later verify.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { getChainAdapter } from '@atum-labs/payment-request-sender-auth';
import type { SolanaSigner, StellarSigner } from '../chain-adapters';
import { toSenderSigner } from './sender-signer';

// ── EVM (eip155) — EscrowSigner (signTypedData); recoverable, no delegateSigner ──
describe('toSenderSigner — EVM', () => {
  const NET = 'eip155:1';
  const TOKEN = '0x5555555555555555555555555555555555555555';
  const defaults = {
    escrowContract: '0x1111111111111111111111111111111111111111',
    quoteSelector: '0x2222222222222222222222222222222222222222',
    fulfillmentVerifierAccount: '0x3333333333333333333333333333333333333333',
    fulfillmentVerifierEndpoint: 'https://verifier.example',
    fulfillmentProxy: '0x4444444444444444444444444444444444444444',
  };
  // Well-known throwaway key — an ethers.Wallet structurally satisfies EscrowSigner.
  const wallet = new ethers.Wallet('0x' + '11'.repeat(32));

  it('bridge-signs an SDK-built Permit2 message; SDK recoverAndVerify recovers to the signer', async () => {
    const built = await getChainAdapter(NET).buildAuthMessage({
      sourceAsset: `${NET}/erc20:${TOKEN}`,
      depositor: wallet.address,
      maxSourceAmount: '1000000',
      requestId: 'req_evm',
      // Required members of the signed deposit witness. This test's oracle is a
      // build → bridge-sign → recoverAndVerify round trip, so what matters is that they are
      // well-formed and identical on both legs; a distinct payee address keeps them from
      // silently coinciding with the depositor.
      destinationAsset: `${NET}/erc20:${TOKEN}`,
      destinationAccount: '0x6666666666666666666666666666666666666666',
      sourceDefaults: defaults,
      deadline: 1924991999,
      nonce: 123n,
    });
    const signed = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
    };

    const { signature, delegateSigner } = await toSenderSigner(NET, wallet).sign(signed);
    signed.signature = signature;
    expect(delegateSigner).toBeUndefined(); // recoverable secp256k1 — no disclosed key

    const r = getChainAdapter(NET).recoverAndVerify(
      signed,
      { network: NET, asset: TOKEN, account: wallet.address },
      {
        destinations: [
          {
            asset_identifier: `${NET}/erc20:${TOKEN}`,
            account: '0x6666666666666666666666666666666666666666',
          },
        ],
        requestId: 'req_evm',
      },
      {
        maxSourceAmount: '1000000',
        escrowContract: defaults.escrowContract,
        reserver: defaults.quoteSelector,
        releaser: defaults.fulfillmentVerifierAccount,
        nowSec: 1700000000,
      },
    );
    expect(r.amount).toBe('1000000');
    expect(r.permit.spender?.toLowerCase()).toBe(defaults.escrowContract);
  });
});

// ── Solana — SolanaSigner (sign bytes); non-recoverable, MUST disclose delegateSigner ──
describe('toSenderSigner — Solana', () => {
  const NET = 'solana:localnet';
  const b58 = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
  const MINT = b58(9);
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
  const pubkey = bs58.encode(kp.publicKey);
  const solanaSigner: SolanaSigner = {
    publicKey: pubkey,
    async sign(m) {
      return nacl.sign.detached(m, kp.secretKey);
    },
  };
  const defaults = {
    escrowContract: b58(1),
    quoteSelector: b58(2),
    fulfillmentVerifierAccount: b58(3),
    fulfillmentVerifierEndpoint: 'https://verifier.example',
    fulfillmentProxy: b58(4),
    svmSignatureClusterId: 'localnet',
    svmSignatureDomainVersion: 5,
  };

  it('bridge-signs an SDK-built deposit; discloses delegateSigner; SDK recoverAndVerify recovers to the signer', async () => {
    const built = await getChainAdapter(NET).buildAuthMessage({
      sourceAsset: `${NET}/spl:${MINT}`,
      depositor: pubkey,
      maxSourceAmount: '1000000',
      requestId: 'req_sol',
      // The payee the deposit commits to; recoverAndVerify below requires the same values.
      destinationAsset: `${NET}/spl:${MINT}`,
      destinationAccount: b58(10),
      sourceDefaults: defaults,
      solanaClockReader: async () => 1700000000n,
    });
    const signed: {
      message: string;
      message_prehash: string;
      signature: string;
      payload?: Record<string, unknown>;
    } = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
    };

    const { signature, delegateSigner } = await toSenderSigner(NET, solanaSigner).sign(signed);
    signed.signature = signature;
    expect(delegateSigner).toBe(pubkey); // non-recoverable ed25519 — the pubkey must be disclosed
    signed.payload = { delegate_signer: delegateSigner };

    const r = getChainAdapter(NET).recoverAndVerify(
      signed,
      { network: NET, asset: MINT, account: pubkey },
      {
        destinations: [{ asset_identifier: `${NET}/spl:${MINT}`, account: b58(10) }],
        requestId: 'req_sol',
      },
      {
        maxSourceAmount: '1000000',
        escrowContract: defaults.escrowContract,
        reserver: defaults.quoteSelector,
        releaser: defaults.fulfillmentVerifierAccount,
        svmSignatureClusterId: 'localnet',
        svmSignatureDomainVersion: 5,
      },
    );
    expect(r.amount).toBe('1000000');
    expect(r.permit.depositor).toBe(pubkey);
  });
});

// ── Stellar — StellarSigner (sign bytes); non-recoverable, MUST disclose delegateSigner ──
// Pins what the bridge itself does: sign the digest bytes it is given and disclose the account key,
// and that the SDK's Stellar adapter accepts the disclosed key as the one that signed.
describe('toSenderSigner — Stellar', () => {
  const NET = 'stellar:testnet';
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
  // The account is the key's own strkey, so what the signer discloses and what signs are one key.
  const ACCOUNT = getChainAdapter(NET).deriveDelegateSigner!(
    Buffer.from(kp.secretKey.slice(0, 32)).toString('hex'),
  );
  const stellarSigner: StellarSigner = {
    publicKey: ACCOUNT,
    async sign(m) {
      return nacl.sign.detached(m, kp.secretKey);
    },
  };
  const digest = '0x' + 'ab'.repeat(32);

  it('signs the digest bytes with the Ed25519 capability and discloses the account as delegateSigner', async () => {
    const { signature, delegateSigner } = await toSenderSigner(NET, stellarSigner).sign({
      message: digest,
      signature: '',
    });
    expect(delegateSigner).toBe(ACCOUNT);
    const sig = Buffer.from(signature.replace(/^0x/, ''), 'hex');
    expect(sig).toHaveLength(64);
    expect(nacl.sign.detached.verify(Buffer.from(digest.slice(2), 'hex'), sig, kp.publicKey)).toBe(
      true,
    );
    // The key it discloses is the one the SDK verifies the signature under.
    expect(
      getChainAdapter(NET).recoverSigner(
        { message: digest, signature, payload: { delegate_signer: delegateSigner } },
        { network: NET, asset: 'C', account: ACCOUNT },
      ),
    ).toBe(ACCOUNT);
  });

  it('is bound to the source network, as the SDK expects of a signer whose key is for one chain', () => {
    expect(toSenderSigner(NET, stellarSigner).network).toBe(NET);
    expect(toSenderSigner('solana:devnet', stellarSigner).network).toBe('solana:devnet');
    expect(toSenderSigner('eip155:1', new ethers.Wallet('0x' + '11'.repeat(32))).network).toBe(
      'eip155:1',
    );
  });

  it('refuses an EVM typed-data signer for a Stellar source', () => {
    expect(() => toSenderSigner(NET, new ethers.Wallet('0x' + '11'.repeat(32)))).toThrow(
      /Stellar source requires an Ed25519 \(StellarSigner\)/,
    );
  });

  it('refuses an Ed25519 signer for an EVM source', () => {
    expect(() => toSenderSigner('eip155:1', stellarSigner)).toThrow(/EIP-712 typed-data/);
  });
});
