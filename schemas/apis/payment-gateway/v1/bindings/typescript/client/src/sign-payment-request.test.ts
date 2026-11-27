import { ethers } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { signPaymentRequest } from './index';
import { createSenderSigner } from './signers';
import type { SenderSigner } from './signers';
import { createPermitWitnessTransferFromPrehashWithDestination } from '@atum-labs/evm-escrow-encoding';
import { hashPermitWitnessTransferFrom } from './sender_auth_schemes/evm_permit2';
import type { PaymentRequest, SignedMessage } from './generated/types.gen';

const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

function evmSignedMessage(): SignedMessage {
  const prehash = createPermitWitnessTransferFromPrehashWithDestination({
    chainId: 42161,
    verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    amount: '100000',
    spender: '0x1111111111111111111111111111111111111111',
    nonce: 1n,
    deadline: 1924991999n,
    depositRequestHash: '0x' + '11'.repeat(32),
    destination:
      'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831@0x4444444444444444444444444444444444444444',
    reserver: '0x2222222222222222222222222222222222222222',
    releaser: '0x3333333333333333333333333333333333333333',
  });
  return {
    message: hashPermitWitnessTransferFrom(prehash),
    message_prehash: JSON.stringify(prehash),
    signature: '',
  } as SignedMessage;
}

// Minimal PaymentRequest shell — signPaymentRequest only touches sender_auth.signed_messages[0].
function requestWith(messages: SignedMessage[]): PaymentRequest {
  return {
    sender_auth: {
      message_scheme: 'EVM_PERMIT2',
      signed_messages: messages,
    },
  } as unknown as PaymentRequest;
}

describe('signPaymentRequest', () => {
  it('EVM: fills signed_messages[0].signature (recovers to the key) and attaches no delegate_signer', async () => {
    const sm = evmSignedMessage();
    const prehash = JSON.parse(sm.message_prehash!);
    const expectedAddress = new ethers.Wallet(PRIVATE_KEY).address;

    const request = requestWith([sm]);
    const signer = createSenderSigner('eip155:42161', { provider: 'raw', privateKey: PRIVATE_KEY });
    const result = await signPaymentRequest(request, signer);

    // Mutates in place and returns the same request.
    expect(result).toBe(request);
    const signed = result.sender_auth.signed_messages[0];
    const recovered = ethers.verifyTypedData(
      prehash.domain,
      prehash.types,
      prehash.message,
      signed.signature,
    );
    expect(recovered).toBe(expectedAddress);
    expect(signed.payload).toBeUndefined();
  });

  it('Solana: fills the signature (verifies under the delegate) and attaches payload.delegate_signer', async () => {
    const seed = 'a'.repeat(64);
    const expectedDelegate = bs58.encode(
      nacl.sign.keyPair.fromSeed(Uint8Array.from(Buffer.from(seed, 'hex'))).publicKey,
    );
    const sm = { message: '0x' + 'ab'.repeat(32), signature: '' } as SignedMessage;

    const request = requestWith([{ ...sm }]);
    const signer = createSenderSigner('solana:mainnet', { provider: 'raw', privateKey: seed });
    const result = await signPaymentRequest(request, signer);

    const signed = result.sender_auth.signed_messages[0];
    expect(signed.payload?.delegate_signer).toBe(expectedDelegate);
    const verified = nacl.sign.detached.verify(
      ethers.getBytes(sm.message),
      ethers.getBytes(signed.signature),
      bs58.decode(expectedDelegate),
    );
    expect(verified).toBe(true);
  });

  it('signs every entry in a multi-message request, not just the first', async () => {
    // Stub signer returning a distinct signature and delegate per call, so we can
    // assert each message is signed independently (the gateway verifies all of them).
    let calls = 0;
    const signer = {
      sign: async (_sm: SignedMessage) => {
        calls += 1;
        return { signature: `0xsig${calls}`, delegateSigner: `delegate${calls}` };
      },
    } as unknown as SenderSigner;
    const request = requestWith([
      { message: '0x' + '11'.repeat(32), signature: '' } as SignedMessage,
      { message: '0x' + '22'.repeat(32), signature: '' } as SignedMessage,
    ]);

    const result = await signPaymentRequest(request, signer);

    expect(calls).toBe(2);
    const [m0, m1] = result.sender_auth.signed_messages;
    expect(m0.signature).toBe('0xsig1');
    expect(m0.payload?.delegate_signer).toBe('delegate1');
    expect(m1.signature).toBe('0xsig2');
    expect(m1.payload?.delegate_signer).toBe('delegate2');
  });

  it('throws a clear error when signed_messages is empty', async () => {
    const signer = createSenderSigner('eip155:42161', { provider: 'raw', privateKey: PRIVATE_KEY });
    await expect(signPaymentRequest(requestWith([]), signer)).rejects.toThrow(
      /at least one message/,
    );
  });

  it('throws a clear error when sender_auth has no signed_messages', async () => {
    const signer = createSenderSigner('eip155:42161', { provider: 'raw', privateKey: PRIVATE_KEY });
    const request = { sender_auth: { message_scheme: 'EVM_PERMIT2' } } as unknown as PaymentRequest;
    await expect(signPaymentRequest(request, signer)).rejects.toThrow(/at least one message/);
  });

  it('throws a clear error when sender_auth is absent', async () => {
    const signer = createSenderSigner('eip155:42161', { provider: 'raw', privateKey: PRIVATE_KEY });
    await expect(signPaymentRequest({} as unknown as PaymentRequest, signer)).rejects.toThrow(
      /at least one message/,
    );
  });
});
