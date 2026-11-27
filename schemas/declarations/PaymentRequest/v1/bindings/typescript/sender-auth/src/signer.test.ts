import { describe, it, expect } from 'vitest';
import { Wallet } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { evmAdapter } from './adapters/evm.js';
import { solanaAdapter } from './adapters/solana.js';
import { localKeySigner } from './signer.js';
import type { SignedMessageInput, SourceRef } from './types.js';

const EVM_DEFAULTS = {
  escrowContract: '0x1111111111111111111111111111111111111111',
  quoteSelector: '0x2222222222222222222222222222222222222222',
  fulfillmentVerifierAccount: '0x3333333333333333333333333333333333333333',
  fulfillmentVerifierEndpoint: 'https://verifier.example',
  fulfillmentProxy: '0x4444444444444444444444444444444444444444',
};
const EVM_TOKEN = '0x5555555555555555555555555555555555555555';
const b58 = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));

describe("localKeySigner (the SDK's built-in raw signer)", () => {
  it("EVM: signs so the message recovers to the key's address, no delegateSigner", async () => {
    const wallet = new Wallet('0x' + '11'.repeat(32));
    const built = await evmAdapter.buildAuthMessage({
      sourceAsset: `eip155:1/erc20:${EVM_TOKEN}`,
      depositor: wallet.address,
      maxSourceAmount: '1000000',
      requestId: 'req_signer',
      sourceDefaults: EVM_DEFAULTS,
      nonce: 123n,
      deadline: 1924991999n,
      destinationAsset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      destinationAccount: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
    });
    const signed: SignedMessageInput = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
    };

    const result = await localKeySigner('eip155:1', wallet.privateKey).sign(signed);
    expect(result.delegateSigner).toBeUndefined();

    const source: SourceRef = { network: 'eip155:1', asset: EVM_TOKEN, account: wallet.address };
    const recovered = evmAdapter.recoverSigner({ ...signed, signature: result.signature }, source);
    expect(recovered).toBe(wallet.address);
  });

  it('Solana: signs and attaches the delegateSigner (base58 pubkey)', async () => {
    const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const depositor = bs58.encode(kp.publicKey);
    const MINT = b58(9);
    const defaults = {
      escrowContract: b58(1),
      quoteSelector: b58(2),
      fulfillmentVerifierAccount: b58(3),
      fulfillmentVerifierEndpoint: 'https://verifier.example',
      fulfillmentProxy: b58(4),
      svmSignatureClusterId: 'devnet',
      svmSignatureDomainVersion: 5,
    };
    const built = await solanaAdapter.buildAuthMessage({
      sourceAsset: `solana:mainnet/spl:${MINT}`,
      depositor,
      maxSourceAmount: '1000000',
      requestId: 'req_signer_sol',
      sourceDefaults: defaults,
      solanaClockReader: async () => 1700000000n,
      destinationAsset:
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo',
      destinationAccount: '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4',
    });
    const signed: SignedMessageInput = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
    };

    const result = await localKeySigner('solana:mainnet', bs58.encode(kp.secretKey)).sign(signed);
    expect(result.delegateSigner).toBe(depositor);

    const source: SourceRef = { network: 'solana:mainnet', asset: MINT, account: depositor };
    const recovered = solanaAdapter.recoverSigner(
      {
        ...signed,
        signature: result.signature,
        payload: { delegate_signer: result.delegateSigner },
      },
      source,
    );
    expect(recovered).toBe(depositor);
  });
});
