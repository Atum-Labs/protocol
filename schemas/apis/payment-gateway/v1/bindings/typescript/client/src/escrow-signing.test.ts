import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { escrowText } from '@atum-labs/solana-escrow-encoding';
import { localKeySigner } from '@atum-labs/payment-request-sender-auth';
import type { ReserveMessageInput } from '@atum-labs/payment-request-sender-auth';
import { PaymentGatewayClient, escrowSigningOf, signPaymentRequest } from './index';
import { signReserveAuth } from './reserve-auth';
import type { ChainDefaults } from './index';
import { createSenderSigner } from './signers';
import type { SenderSignInput, SenderSigner } from './signers';
import { signWithTurnkeyClient } from './signers/turnkey-impl';
import type { PaymentRequest, SignedMessage } from './generated/types.gen';

const V4 = 'ExampLeEscrow111111111111111111111111111111';
const V5 = 'Esc5111111111111111111111111111111111111111';
const BASE: ChainDefaults = {
  escrowContract: V4,
  quoteSelector: 'q',
  fulfillmentVerifierAccount: 'v',
  fulfillmentVerifierEndpoint: 'https://v.example',
  fulfillmentProxy: 'p',
  svmSignatureClusterId: 'devnet',
  svmSignatureDomainVersion: 4,
};

const seed = new Uint8Array(32).fill(7);
const keypair = nacl.sign.keyPair.fromSeed(seed);
const seedHex = Buffer.from(seed).toString('hex');
const hash = new Uint8Array(32).fill(0xab);
const message = '0x' + Buffer.from(hash).toString('hex');
const reservePrehash = JSON.stringify({
  deposit_hash: '0x11',
  recipient: 'r',
  quote_hash: '0x33',
  source_amount: '1',
});

const RESERVE_INPUT: ReserveMessageInput = {
  network: 'solana:devnet',
  escrowContract: V5,
  depositId: message,
  quoteHash: '0x' + 'cd'.repeat(32),
  settler: bs58.encode(new Uint8Array(32).fill(3)),
  sourceAmount: '1',
  svmSignatureClusterId: 'devnet',
  svmSignatureDomainVersion: 5,
};

const verifies = (bytes: Uint8Array, sig: string) =>
  nacl.sign.detached.verify(bytes, Buffer.from(sig.slice(2), 'hex'), keypair.publicKey);

describe('escrowSigningOf', () => {
  it.each([
    [
      'no escrows list: the chain domain, raw',
      BASE,
      V4,
      { svmSignatureDomainVersion: 4, svmMessageScheme: '' },
    ],
    [
      'an unlisted escrow: the chain domain, raw',
      { ...BASE, escrows: [] },
      V5,
      { svmSignatureDomainVersion: 4, svmMessageScheme: '' },
    ],
    [
      'a listed raw escrow',
      { ...BASE, escrows: [{ escrowContract: V4, svmSignatureDomainVersion: 4 }] },
      V4,
      { svmSignatureDomainVersion: 4, svmMessageScheme: '' },
    ],
    [
      'a listed text escrow',
      {
        ...BASE,
        escrows: [
          { escrowContract: V4, svmSignatureDomainVersion: 4, svmMessage: '' },
          { escrowContract: V5, svmSignatureDomainVersion: 5, svmMessage: 'escrow-text-v1' },
        ],
      },
      V5,
      { svmSignatureDomainVersion: 5, svmMessageScheme: 'escrow-text-v1' },
    ],
  ])('%s', (_name, defaults, escrow, want) => {
    expect(escrowSigningOf(defaults as ChainDefaults, escrow)).toEqual(want);
  });

  it('refuses a message scheme it does not know', () => {
    const defaults = { ...BASE, escrows: [{ escrowContract: V5, svmMessage: 'escrow-text-v2' }] };
    expect(() => escrowSigningOf(defaults, V5)).toThrow('does not know');
  });
});

describe('Solana signing by escrow scheme', () => {
  const requestWith = (m: SignedMessage) =>
    ({
      sender_auth: { message_scheme: 'SOLANA', signed_messages: [m] },
    }) as unknown as PaymentRequest;

  it('signPaymentRequest signs the raw hash by default', async () => {
    const request = requestWith({ message, signature: '' } as SignedMessage);
    await signPaymentRequest(
      request,
      createSenderSigner('solana:devnet', { provider: 'raw', privateKey: seedHex }),
    );
    const signed = request.sender_auth.signed_messages[0]!;
    expect(verifies(hash, signed.signature)).toBe(true);
    expect(signed.payload).toEqual({ delegate_signer: bs58.encode(keypair.publicKey) });
  });

  it('signPaymentRequest signs the escrow text for a text escrow, and never sends the scheme', async () => {
    const request = requestWith({ message, signature: '' } as SignedMessage);
    await signPaymentRequest(
      request,
      createSenderSigner('solana:devnet', { provider: 'raw', privateKey: seedHex }),
      { svmMessageScheme: 'escrow-text-v1' },
    );
    const signed = request.sender_auth.signed_messages[0]!;
    expect(verifies(escrowText('atum deposit v1', hash), signed.signature)).toBe(true);
    expect(verifies(hash, signed.signature)).toBe(false);
    expect(JSON.stringify(request)).not.toContain('svmMessageScheme');
  });

  it('signs raw when the request data carries a scheme and the caller names none', async () => {
    const request = requestWith({
      message,
      signature: '',
      svmMessageScheme: 'escrow-text-v1',
    } as SignedMessage);
    await signPaymentRequest(
      request,
      createSenderSigner('solana:devnet', { provider: 'raw', privateKey: seedHex }),
    );
    const signed = request.sender_auth.signed_messages[0]!;
    expect(verifies(hash, signed.signature)).toBe(true);
    expect(verifies(escrowText('atum deposit v1', hash), signed.signature)).toBe(false);
  });

  it('signReserveAuth signs with the caller scheme only, never one the input carries', async () => {
    const seen: SenderSignInput[] = [];
    const capture: SenderSigner = {
      async sign(m) {
        seen.push(m);
        return { signature: '0x' + '00'.repeat(64) };
      },
    };
    const carrying = { ...RESERVE_INPUT, svmMessageScheme: 'escrow-text-v1' };
    await signReserveAuth(carrying, capture);
    await signReserveAuth(RESERVE_INPUT, capture, { svmMessageScheme: 'escrow-text-v1' });
    expect(seen[0]!.svmMessageScheme).toBe('');
    expect(seen[1]!.svmMessageScheme).toBe('escrow-text-v1');

    const raw = createSenderSigner('solana:devnet', { provider: 'raw', privateKey: seedHex });
    const text = await signReserveAuth(RESERVE_INPUT, raw, { svmMessageScheme: 'escrow-text-v1' });
    const digest = Uint8Array.from(Buffer.from(text.message.slice(2), 'hex'));
    expect(verifies(escrowText('atum reserve v1', digest), text.signature)).toBe(true);
    const plain = await signReserveAuth(carrying, raw);
    expect(verifies(digest, plain.signature)).toBe(true);
  });

  it('passes the caller scheme to a custom signer, raw when unset', async () => {
    const seen: SenderSignInput[] = [];
    const capture: SenderSigner = {
      async sign(m) {
        seen.push(m);
        return { signature: '0x' + '00'.repeat(64) };
      },
    };
    await signPaymentRequest(requestWith({ message, signature: '' } as SignedMessage), capture);
    await signPaymentRequest(requestWith({ message, signature: '' } as SignedMessage), capture, {
      svmMessageScheme: 'escrow-text-v1',
    });
    expect(seen[0]!.svmMessageScheme).toBe('');
    expect(seen[1]!.svmMessageScheme).toBe('escrow-text-v1');
  });

  describe('Turnkey', () => {
    // Decodes the payload in whichever encoding the Turnkey signer sends it.
    const client = {
      listWalletAccounts: async () => [
        { addressFormat: 'ADDRESS_FORMAT_SOLANA', address: bs58.encode(keypair.publicKey) },
      ],
      signRawPayload: async ({ payload, encoding }: { payload: string; encoding?: string }) => {
        const bytes =
          encoding === 'PAYLOAD_ENCODING_TEXT_UTF8'
            ? new TextEncoder().encode(payload)
            : Uint8Array.from(Buffer.from(payload, 'hex'));
        const sig = nacl.sign.detached(bytes, keypair.secretKey);
        return {
          r: Buffer.from(sig.slice(0, 32)).toString('hex'),
          s: Buffer.from(sig.slice(32)).toString('hex'),
          v: '00',
        };
      },
    };
    const CFG = { organizationId: 'o', walletId: 'w', apiPublicKey: 'k', apiPrivateKey: 'k' };

    it.each([
      ['deposit text', undefined, escrowText('atum deposit v1', hash)],
      ['reserve text', reservePrehash, escrowText('atum reserve v1', hash)],
    ])('signs the %s for a text escrow, as the raw signer does', async (_n, prehash, want) => {
      const result = await signWithTurnkeyClient(
        client as never,
        'solana',
        CFG,
        message,
        prehash,
        'escrow-text-v1',
      );
      expect(verifies(want, result.signature)).toBe(true);
      const raw = await localKeySigner('solana:devnet', seedHex).sign({
        message,
        signature: '',
        message_prehash: prehash,
        svmMessageScheme: 'escrow-text-v1',
      });
      expect(result.signature).toBe(raw.signature);
    });

    it('refuses a text escrow message that is not 32 bytes', async () => {
      await expect(
        signWithTurnkeyClient(
          client as never,
          'solana',
          CFG,
          '0xabcd',
          undefined,
          'escrow-text-v1',
        ),
      ).rejects.toThrow('32-byte escrow hash');
    });
  });
});

describe('fetchChainDefaults escrows', () => {
  let server: Server;
  let baseUrl: string;
  let body: unknown;
  beforeAll((done) => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });
  afterAll((done) => {
    server.close(done);
  });

  const wire = {
    chain_id: 'solana:devnet',
    quote_selector: 'q',
    escrow_contract: V4,
    fulfillment_proxy: 'p',
    fulfillment_verifier: { account: 'v', endpoint: 'https://v.example' },
    svm_signature_cluster_id: 'devnet',
    svm_signature_domain_version: 4,
  };

  it('maps the escrows list, and leaves it absent when the gateway sends none', async () => {
    body = wire;
    const plain = await new PaymentGatewayClient({ BASE: baseUrl }).fetchChainDefaults(
      'solana:devnet',
    );
    expect('escrows' in plain).toBe(false);

    body = {
      ...wire,
      escrows: [
        { escrow_contract: V4, svm_signature_domain_version: 4 },
        { escrow_contract: V5, svm_signature_domain_version: 5, svm_message: 'escrow-text-v1' },
      ],
    };
    const listed = await new PaymentGatewayClient({ BASE: baseUrl }).fetchChainDefaults(
      'solana:devnet',
    );
    expect(listed.escrows).toEqual([
      { escrowContract: V4, svmSignatureDomainVersion: 4, svmMessage: undefined },
      { escrowContract: V5, svmSignatureDomainVersion: 5, svmMessage: 'escrow-text-v1' },
    ]);
    expect(escrowSigningOf(listed, V5)).toEqual({
      svmSignatureDomainVersion: 5,
      svmMessageScheme: 'escrow-text-v1',
    });
  });
});
