import { createHash } from 'crypto';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { ethers } from 'ethers';
import { PaymentGatewayClient } from './index';
import { createSessionTokenSource, signerFromEthersWallet } from './signing';
import type { SessionFetch } from './signing';

// The token source wired into the real client the way the docs show, against a loopback gateway,
// so what reaches the wire is the generated transport's doing and not this file's.

const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
const credential = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  type: ['VerifiableCredential', 'KnownToAtumVerifiableCredential'],
  issuer: 'did:web:issuer.example',
  issuanceDate: '2026-04-01T00:00:00.000Z',
  credentialSubject: { id: holder },
};

function json(status: number, body: unknown): Awaited<ReturnType<SessionFetch>> {
  return {
    ok: status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

// An authorization service that answers the nonce, then refuses or issues a token of a type.
function authService(answer: 'Bearer' | 'DPoP' | 'refuse'): SessionFetch {
  return async (url) => {
    if (url.endsWith('/v1/auth/nonce')) {
      return json(200, {
        nonce: 'test-nonce',
        expected_domain: 'did:web:auth.example',
        expires_in: 300,
      });
    }
    if (answer === 'refuse') return json(503, { code: 'SERVICE_UNAVAILABLE' });
    return json(200, { access_token: 'test-access-token', token_type: answer, expires_in: 3600 });
  };
}

const claimsOf = (proof: string) =>
  JSON.parse(Buffer.from(proof.split('.')[1], 'base64url').toString('utf8'));

describe('a session token source wired into the client', () => {
  let server: Server;
  let baseUrl: string;
  let seen: Array<{ authorization?: string; dpop?: string }>;

  beforeAll((done) => {
    server = createServer((req, res) => {
      seen.push({
        authorization: req.headers.authorization,
        dpop: req.headers.dpop as string | undefined,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          chain_id: 'eip155:84532',
          quote_selector: '0xd0f080E23F95571D26eEb1FAD24a5F3d66835195',
          escrow_contract: '0xa61a0C025943Aa79B73D8D07E3aDbEe1873738b4',
          fulfillment_proxy: '0x09A5a0d6955E5394A661Cd9E7007076fa63B4158',
          fulfillment_verifier: {
            account: '0x27050EE47befC43F4dF7807a7AA8073039e5fa89',
            endpoint: 'https://v.example',
          },
        }),
      );
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });
  beforeEach(() => {
    seen = [];
  });
  afterAll((done) => {
    server.close(done);
  });

  function source(answer: 'Bearer' | 'DPoP' | 'refuse', dpop?: boolean) {
    return createSessionTokenSource({
      authUrl: 'https://auth.example',
      credentials: [credential],
      signer: signerFromEthersWallet(wallet),
      fetch: authService(answer),
      dpop,
    });
  }

  it('sends a bound token as DPoP, with a proof for this request', async () => {
    await new PaymentGatewayClient({
      BASE: baseUrl,
      timeoutMs: 5_000,
      session: source('DPoP'),
    }).fetchChainDefaults('eip155:84532');
    expect(seen).toHaveLength(1);
    expect(seen[0].authorization).toBe('DPoP test-access-token');
    // The proof names the request without its query string, and hashes the token it travels with.
    expect(claimsOf(seen[0].dpop as string)).toMatchObject({
      htm: 'GET',
      htu: `${baseUrl}/v1/defaults`,
      ath: createHash('sha256').update('test-access-token').digest('base64url'),
    });
  });

  it('sends a token the service did not bind as Bearer, with no proof', async () => {
    await new PaymentGatewayClient({
      BASE: baseUrl,
      timeoutMs: 5_000,
      session: source('Bearer'),
    }).fetchChainDefaults('eip155:84532');
    expect(seen).toEqual([{ authorization: 'Bearer test-access-token', dpop: undefined }]);
  });

  it('sends the request without a session when no token can be had', async () => {
    await new PaymentGatewayClient({
      BASE: baseUrl,
      timeoutMs: 5_000,
      session: source('refuse'),
    }).fetchChainDefaults('eip155:84532');
    expect(seen).toEqual([{ authorization: undefined, dpop: undefined }]);
  });

  it('still works as TOKEN for a bearer token', async () => {
    const tokens = source('Bearer', false);
    await new PaymentGatewayClient({
      BASE: baseUrl,
      timeoutMs: 5_000,
      TOKEN: () => tokens.token(),
    }).fetchChainDefaults('eip155:84532');
    expect(seen).toEqual([{ authorization: 'Bearer test-access-token', dpop: undefined }]);
  });
});
