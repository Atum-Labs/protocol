import { createHash, webcrypto } from 'crypto';
import { ethers } from 'ethers';
import {
  createDPoPKey,
  createDPoPProof,
  createSessionTokenSource,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_RETRY_AFTER_MS,
  requestSessionToken,
  signSessionPresentation,
  signerFromEthersWallet,
  SessionTokenError,
} from './signing';
import { jwkThumbprint } from './session-token';
import type { SessionFetch, SessionNonce } from './signing';

// The verifier the authorization service runs. Asserting against it is what makes these tests
// about the presentation rather than about this file's own expectations.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { verifyVP } = require('@atum-labs/ld-signing');

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OTHER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
// proof.created is inside the signed payload, so it is pinned rather than left to the clock.
const CREATED = '2026-04-01T00:00:00.000Z';

const wallet = new ethers.Wallet(PRIVATE_KEY);
const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
const signer = signerFromEthersWallet(wallet);

const NONCE: SessionNonce = {
  nonce: 'R2lwbmZ0c2Z3c2Z3c2Z3c2Z3c2Z3c2Z3c2Z3c2Z3c2Z',
  expected_domain: 'did:web:auth.example',
  expires_in: 300,
};

// A Known to Atum credential shaped the way the verifier expects. Its proof is structural: the
// presentation path does not verify an embedded credential's signature unless asked to.
function credential(subject = holder) {
  return {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://schemas.atum.xyz/credentials/known-to-atum/v1',
    ],
    id: 'urn:uuid:1f1c1b3a-0000-4000-8000-00000000acce',
    type: ['VerifiableCredential', 'KnownToAtumVerifiableCredential'],
    issuer: 'did:web:issuer.example',
    issuanceDate: CREATED,
    credentialSubject: { id: subject, role: 'psp' },
    proof: {
      type: 'EcdsaSecp256k1RecoverySignature2020',
      created: CREATED,
      verificationMethod: 'did:web:issuer.example#issuer-key-1',
      proofPurpose: 'assertionMethod',
    },
  };
}

function verifyOptions(nonce: SessionNonce = NONCE, now = new Date(Date.parse(CREATED) + 30_000)) {
  return {
    expectedChallenge: nonce.nonce,
    expectedDomain: nonce.expected_domain,
    expectedHolder: holder,
    now,
    maxProofAgeMs: 6 * 60 * 1000,
    maxFutureSkewMs: 60 * 1000,
    requiredVCTypes: ['KnownToAtumVerifiableCredential'],
  };
}

describe('signSessionPresentation', () => {
  it('is accepted by the verifier for the nonce and environment it answers', async () => {
    const presentation = await signSessionPresentation({
      credentials: [credential()],
      signer,
      nonce: NONCE,
      created: CREATED,
    });
    await expect(verifyVP(presentation, verifyOptions())).resolves.toMatchObject({ holder });
    expect(presentation.proof).toMatchObject({
      challenge: NONCE.nonce,
      domain: NONCE.expected_domain,
      proofPurpose: 'authentication',
      verificationMethod: `${holder}#blockchainAccountId`,
    });
  });

  it('answers only its own nonce and environment', async () => {
    const presentation = await signSessionPresentation({
      credentials: [credential()],
      signer,
      nonce: NONCE,
      created: CREATED,
    });
    await expect(
      verifyVP(presentation, verifyOptions({ ...NONCE, nonce: 'another-nonce' })),
    ).rejects.toThrow();
    await expect(
      verifyVP(presentation, verifyOptions({ ...NONCE, expected_domain: 'did:web:other.example' })),
    ).rejects.toThrow();
  });

  it('accepts a credential that names the holder with a checksummed address', async () => {
    const checksummed = `did:pkh:eip155:1:${wallet.address}`;
    const presentation = await signSessionPresentation({
      credentials: [credential(checksummed)],
      signer,
      nonce: NONCE,
      created: CREATED,
    });
    expect(presentation.holder).toBe(checksummed);
  });

  it('refuses credentials issued to more than one holder, before signing', async () => {
    const signDigest = jest.fn(signer.signDigest);
    const other = `did:pkh:eip155:1:${new ethers.Wallet(OTHER_KEY).address.toLowerCase()}`;
    await expect(
      signSessionPresentation({
        credentials: [credential(), credential(other)],
        signer: { getAddress: signer.getAddress, signDigest },
        nonce: NONCE,
      }),
    ).rejects.toThrow(/2 different holders/);
    expect(signDigest).not.toHaveBeenCalled();
  });

  it('refuses a signer that is not the wallet the credentials are issued to', async () => {
    await expect(
      signSessionPresentation({
        credentials: [credential()],
        signer: signerFromEthersWallet(new ethers.Wallet(OTHER_KEY)),
        nonce: NONCE,
      }),
    ).rejects.toThrow(/sign with the wallet the credentials name/);
  });

  it('refuses a holder that is not an EVM wallet', async () => {
    await expect(
      signSessionPresentation({
        credentials: [
          credential(
            'did:pkh:solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
          ),
        ],
        signer,
        nonce: NONCE,
      }),
    ).rejects.toThrow(/must be an EVM wallet/);
  });

  it('refuses a nonce without its expected_domain', async () => {
    await expect(
      signSessionPresentation({
        credentials: [credential()],
        signer,
        nonce: { ...NONCE, expected_domain: '' },
      }),
    ).rejects.toThrow(/expected_domain is required/);
  });
});

interface Call {
  url: string;
  init: Parameters<SessionFetch>[1];
}

interface Answer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function respond({ status, body, headers }: Answer): Awaited<ReturnType<SessionFetch>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers?.[name] ?? null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

// A fetch that answers the two requests in turn and records what was sent.
function fakeFetch(answers: Answer[]): { fetch: SessionFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: SessionFetch = async (url, init) => {
    calls.push({ url, init });
    const answer = answers[calls.length - 1];
    if (!answer) throw new Error(`unexpected request ${calls.length}: ${url}`);
    return respond(answer);
  };
  return { fetch, calls };
}

const TOKEN_ANSWER = {
  access_token: 'test-access-token',
  issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
  token_type: 'Bearer',
  expires_in: 3600,
};

describe('requestSessionToken', () => {
  it('exchanges a presentation answering a fresh nonce for a bearer token', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: NONCE },
      { status: 200, body: TOKEN_ANSWER },
    ]);
    const before = Date.now();

    const token = await requestSessionToken({
      authUrl: 'https://auth.example',
      credentials: [credential()],
      signer,
      fetch,
    });

    expect(calls[0]).toMatchObject({
      url: 'https://auth.example/v1/auth/nonce',
      init: { method: 'POST' },
    });
    expect(calls[1]).toMatchObject({
      url: 'https://auth.example/v1/auth/token',
      init: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    });
    const form = new URLSearchParams(calls[1].init.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(form.get('subject_token_type')).toBe('urn:atum:params:oauth:token-type:ldp_vp');
    const presentation = JSON.parse(form.get('subject_token') as string);
    await expect(verifyVP(presentation, verifyOptions(NONCE, new Date()))).resolves.toMatchObject({
      holder,
    });

    expect(token).toMatchObject({
      accessToken: TOKEN_ANSWER.access_token,
      tokenType: 'Bearer',
      expiresIn: 3600,
    });
    expect(token.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(token.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
  });

  it('ignores a trailing slash on authUrl', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: NONCE },
      { status: 200, body: TOKEN_ANSWER },
    ]);
    await requestSessionToken({
      authUrl: 'https://auth.example//',
      credentials: [credential()],
      signer,
      fetch,
    });
    expect(calls.map((c) => c.url)).toEqual([
      'https://auth.example/v1/auth/nonce',
      'https://auth.example/v1/auth/token',
    ]);
  });

  it('reports a refused nonce with its code and Retry-After, and signs nothing', async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 429,
        body: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.' },
        headers: { 'Retry-After': '42' },
      },
    ]);
    const error = await requestSessionToken({
      authUrl: 'https://auth.example',
      credentials: [credential()],
      signer,
      fetch,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionTokenError);
    expect(error).toMatchObject({
      status: 429,
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfterSeconds: 42,
    });
    expect(calls).toHaveLength(1);
  });

  it('reports a refused exchange with its code', async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: NONCE },
      {
        status: 403,
        body: { code: 'CREDENTIAL_UNTRUSTED', message: 'Credential issuer is not trusted.' },
      },
    ]);
    const error = await requestSessionToken({
      authUrl: 'https://auth.example',
      credentials: [credential()],
      signer,
      fetch,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionTokenError);
    expect(error).toMatchObject({
      status: 403,
      code: 'CREDENTIAL_UNTRUSTED',
      retryAfterSeconds: undefined,
    });
  });

  it('refuses an answer that is neither a Bearer nor a DPoP token', async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: NONCE },
      { status: 200, body: { ...TOKEN_ANSWER, token_type: 'mac' } },
    ]);
    await expect(
      requestSessionToken({
        authUrl: 'https://auth.example',
        credentials: [credential()],
        signer,
        fetch,
      }),
    ).rejects.toThrow(/Bearer or DPoP access_token/);
  });

  it('refuses a DPoP token answered to an exchange that sent no DPoP key', async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: NONCE },
      { status: 200, body: { ...TOKEN_ANSWER, token_type: 'DPoP' } },
    ]);
    await expect(
      requestSessionToken({
        authUrl: 'https://auth.example',
        credentials: [credential()],
        signer,
        fetch,
      }),
    ).rejects.toThrow(/sent no DPoP proof/);
  });

  it('counts the expiry from when the token was requested', async () => {
    let clock = Date.parse('2026-04-01T00:00:00.000Z');
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    let requestedAt = 0;
    const fetch: SessionFetch = async (url) => {
      if (url.endsWith('/v1/auth/nonce')) return respond({ status: 200, body: NONCE });
      requestedAt = clock;
      clock += 5_000; // the answer takes five seconds to arrive
      return respond({ status: 200, body: TOKEN_ANSWER });
    };
    try {
      const token = await requestSessionToken({
        authUrl: 'https://auth.example',
        credentials: [credential()],
        signer,
        fetch,
      });
      expect(token.expiresAt.getTime()).toBe(requestedAt + 3600 * 1000);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('abandons a service that does not answer within timeoutMs', async () => {
    let signal: AbortSignal | undefined;
    const fetch: SessionFetch = (_url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    };
    await expect(
      requestSessionToken({
        authUrl: 'https://auth.example',
        credentials: [credential()],
        signer,
        fetch,
        timeoutMs: 20,
      }),
    ).rejects.toThrow('POST /v1/auth/nonce did not answer within 20 ms');
    expect(signal?.aborted).toBe(true);
  });

  it('abandons an answer whose body never arrives', async () => {
    const fetch: SessionFetch = async () => ({
      ...respond({ status: 200, body: NONCE }),
      text: () => new Promise(() => {}),
    });
    await expect(
      requestSessionToken({
        authUrl: 'https://auth.example',
        credentials: [credential()],
        signer,
        fetch,
        timeoutMs: 20,
      }),
    ).rejects.toThrow('did not answer within 20 ms');
  });
});

// An authorization service that issues a new token for every session, unless a refusal is queued:
// a queued refusal answers the next request, whichever it is.
function authService(expiresIn = 3600) {
  const refusals: Answer[] = [];
  const calls: string[] = [];
  let sessions = 0;
  const fetch: SessionFetch = async (url) => {
    calls.push(url);
    const refusal = refusals.shift();
    if (refusal) return respond(refusal);
    if (url.endsWith('/v1/auth/nonce')) return respond({ status: 200, body: NONCE });
    sessions += 1;
    return respond({
      status: 200,
      body: {
        ...TOKEN_ANSWER,
        access_token: `test-access-token-${sessions}`,
        expires_in: expiresIn,
      },
    });
  };
  return { fetch, refusals, calls };
}

// Waits for work the source started in the background.
async function eventually(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
}

describe('createSessionTokenSource', () => {
  const MINUTE = 60 * 1000;
  let clock: number;

  beforeEach(() => {
    clock = Date.parse('2026-04-01T00:00:00.000Z');
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => jest.restoreAllMocks());

  function source(service: ReturnType<typeof authService>, onError?: (error: unknown) => void) {
    return createSessionTokenSource({
      authUrl: 'https://auth.example',
      credentials: [credential()],
      signer,
      fetch: service.fetch,
      onError,
    });
  }

  it('keeps the held token, renewing it in the background before it expires', async () => {
    const service = authService();
    const tokens = source(service);
    await expect(tokens.token()).resolves.toBe('test-access-token-1');

    clock += 30 * MINUTE;
    await expect(tokens.token()).resolves.toBe('test-access-token-1');
    expect(service.calls).toHaveLength(2);

    clock += 29 * MINUTE; // one minute left: inside the renewal window
    await expect(tokens.token()).resolves.toBe('test-access-token-1');
    await eventually(() => tokens.current?.accessToken === 'test-access-token-2');
    await expect(tokens.token()).resolves.toBe('test-access-token-2');
  });

  it('shares one session between callers that have no token yet', async () => {
    const service = authService();
    const tokens = source(service);
    const answers = await Promise.all([tokens.token(), tokens.token(), tokens.token()]);
    expect(answers).toEqual(['test-access-token-1', 'test-access-token-1', 'test-access-token-1']);
    expect(service.calls.filter((url) => url.endsWith('/v1/auth/nonce'))).toHaveLength(1);
  });

  it('keeps a still-valid token through a failed renewal, and backs off before the next', async () => {
    const service = authService();
    const onError = jest.fn();
    const tokens = source(service, onError);
    await tokens.token();

    clock += 59 * MINUTE;
    service.refusals.push({ status: 503, body: { code: 'SERVICE_UNAVAILABLE' } });
    await expect(tokens.token()).resolves.toBe('test-access-token-1');
    await eventually(() => onError.mock.calls.length === 1);
    expect(tokens.lastError).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });

    const calls = service.calls.length;
    clock += DEFAULT_RETRY_AFTER_MS - 1;
    await expect(tokens.token()).resolves.toBe('test-access-token-1');
    expect(service.calls).toHaveLength(calls);

    clock += 1;
    await expect(tokens.token()).resolves.toBe('test-access-token-1');
    await eventually(() => tokens.current?.accessToken === 'test-access-token-2');
    expect(tokens.lastError).toBeUndefined();
  });

  it('answers the empty string when it has no valid token, and waits out Retry-After', async () => {
    const service = authService();
    const tokens = source(service);
    service.refusals.push({
      status: 429,
      body: { code: 'RATE_LIMIT_EXCEEDED' },
      headers: { 'Retry-After': '30' },
    });
    await expect(tokens.token()).resolves.toBe('');
    expect(tokens.lastError).toBeInstanceOf(SessionTokenError);

    clock += 29_000;
    await expect(tokens.token()).resolves.toBe('');
    expect(service.calls).toHaveLength(1);

    clock += 1_000;
    await expect(tokens.token()).resolves.toBe('test-access-token-1');
  });

  it('never answers with an expired token', async () => {
    const service = authService();
    const tokens = source(service);
    await tokens.token();

    clock += 61 * MINUTE;
    service.refusals.push({ status: 503, body: { code: 'SERVICE_UNAVAILABLE' } });
    await expect(tokens.token()).resolves.toBe('');
  });

  it('renews a short-lived token at its halfway point, not on every call', async () => {
    const service = authService(60);
    const tokens = source(service);
    await tokens.token();

    clock += 10_000;
    await expect(tokens.token()).resolves.toBe('test-access-token-1');
    expect(service.calls).toHaveLength(2);

    clock += 21_000;
    await expect(tokens.token()).resolves.toBe('test-access-token-1');
    await eventually(() => tokens.current?.accessToken === 'test-access-token-2');
  });

  it('does not fail the request when onError throws', async () => {
    const service = authService();
    const tokens = source(service, () => {
      throw new Error('a broken logger');
    });
    service.refusals.push({ status: 503, body: { code: 'SERVICE_UNAVAILABLE' } });
    await expect(tokens.token()).resolves.toBe('');
  });
});

// --- DPoP (RFC 9449): binding the token to a key the client holds ---------------

const b64json = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

async function verifyProof(proof: string): Promise<{ header: any; claims: any }> {
  const [h, p, sig] = proof.split('.');
  const header = b64json(h);
  const key = await webcrypto.subtle.importKey(
    'jwk',
    header.jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const ok = await webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(sig, 'base64url'),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error('the proof does not verify under its own key');
  return { header, claims: b64json(p) };
}

// A caller holding no valid token waits for a session only up to maxWaitMs, so a slow or hanging
// authorization service never holds a request back: the gateway serves it without a session.
describe('a session token source, waiting for a session', () => {
  // An authorization service that answers nothing until release() is called.
  function gatedService() {
    const service = authService();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    const fetch: SessionFetch = async (url, init) => {
      requests += 1;
      await gate;
      return service.fetch(url, init);
    };
    return { fetch, release, calls: service.calls, requests: () => requests };
  }

  function sourceWith(fetch: SessionFetch, maxWaitMs?: number) {
    return createSessionTokenSource({
      authUrl: 'https://auth.example',
      credentials: [credential()],
      signer,
      fetch,
      ...(maxWaitMs !== undefined && { maxWaitMs }),
    });
  }

  it('answers every caller without a session once the cap runs out, while auth never answers', async () => {
    const service = gatedService();
    const tokens = sourceWith(service.fetch, 50);

    const started = performance.now();
    const answers = await Promise.all([
      tokens.token(),
      tokens.token(),
      tokens.authorize('GET', 'https://payment-gw.example/v1/defaults'),
    ]);

    expect(answers).toEqual(['', '', {}]);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(service.requests()).toBe(1); // the callers share the one renewal
    service.release();
  });

  it('keeps renewing after the cap, so a later caller gets the token', async () => {
    const service = gatedService();
    const tokens = sourceWith(service.fetch, 20);
    await expect(tokens.token()).resolves.toBe('');

    service.release();
    await eventually(() => tokens.current?.accessToken === 'test-access-token-1');
    await expect(tokens.token()).resolves.toBe('test-access-token-1');
    expect(service.calls.filter((url) => url.endsWith('/v1/auth/nonce'))).toHaveLength(1);
  });

  it('returns a session that comes within the cap to the caller that waited for it', async () => {
    const tokens = sourceWith(authService().fetch, 1_000);
    await expect(tokens.token()).resolves.toBe('test-access-token-1');
  });

  it('never waits with a cap of 0, and the session still arrives for the next caller', async () => {
    const tokens = sourceWith(authService().fetch, 0);
    await expect(tokens.token()).resolves.toBe('');
    await eventually(() => tokens.current !== undefined);
    await expect(tokens.token()).resolves.toBe('test-access-token-1');
  });

  it('waits up to two seconds by default', () => {
    expect(DEFAULT_MAX_WAIT_MS).toBe(2_000);
  });
});

describe('DPoP keys and proofs', () => {
  it("thumbprints a key as RFC 7638 does: RFC 9449's example key to its section 6.1 jkt", () => {
    expect(
      jwkThumbprint({
        kty: 'EC',
        crv: 'P-256',
        x: 'l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs',
        y: '9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA',
      }),
    ).toBe('0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I');
  });

  it('signs a dpop+jwt that verifies under the public key in its own header', async () => {
    const key = await createDPoPKey();
    const proof = await createDPoPProof(
      key,
      { htm: 'post', htu: 'https://gw.example/v1/payments' },
      1_790_856_000_500,
    );
    const { header, claims } = await verifyProof(proof);
    expect(header).toEqual({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk });
    expect(jwkThumbprint(header.jwk)).toBe(key.thumbprint);
    expect(claims).toMatchObject({
      htm: 'POST',
      htu: 'https://gw.example/v1/payments',
      iat: 1_790_856_000,
    });
    expect(claims.jti).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(header.jwk.d).toBeUndefined();
  });

  it("drops the URL's query and fragment, and hashes the token into ath", async () => {
    const key = await createDPoPKey();
    const proof = await createDPoPProof(key, {
      htm: 'GET',
      htu: 'https://gw.example/v1/payments/p1/status?x=1#frag',
      accessToken: 'test-access-token',
    });
    const { claims } = await verifyProof(proof);
    expect(claims.htu).toBe('https://gw.example/v1/payments/p1/status');
    expect(claims.ath).toBe(createHash('sha256').update('test-access-token').digest('base64url'));
  });

  it('makes a fresh jti for every proof', async () => {
    const key = await createDPoPKey();
    const a = await verifyProof(
      await createDPoPProof(key, { htm: 'GET', htu: 'https://gw.example/' }),
    );
    const b = await verifyProof(
      await createDPoPProof(key, { htm: 'GET', htu: 'https://gw.example/' }),
    );
    expect(a.claims.jti).not.toBe(b.claims.jti);
  });
});

describe('requestSessionToken with a DPoP key', () => {
  it("sends a proof naming the exchange's nonce, and returns the bound token as DPoP", async () => {
    const key = await createDPoPKey();
    const { fetch, calls } = fakeFetch([
      { status: 200, body: NONCE },
      { status: 200, body: { ...TOKEN_ANSWER, token_type: 'DPoP' } },
    ]);
    const token = await requestSessionToken({
      authUrl: 'https://auth.example/',
      credentials: [credential()],
      signer,
      fetch,
      dpop: key,
    });
    expect(token.tokenType).toBe('DPoP');
    const { header, claims } = await verifyProof(calls[1].init.headers?.DPoP as string);
    expect(jwkThumbprint(header.jwk)).toBe(key.thumbprint);
    expect(claims).toMatchObject({
      htm: 'POST',
      htu: 'https://auth.example/v1/auth/token',
      nonce: NONCE.nonce,
    });
    expect(calls[0].init.headers?.DPoP).toBeUndefined();
  });

  it('returns a Bearer token where the service does not bind tokens', async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: NONCE },
      { status: 200, body: TOKEN_ANSWER },
    ]);
    const token = await requestSessionToken({
      authUrl: 'https://auth.example',
      credentials: [credential()],
      signer,
      fetch,
      dpop: await createDPoPKey(),
    });
    expect(token.tokenType).toBe('Bearer');
  });
});

describe('a session token source, authorizing requests', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => Date.parse('2026-04-01T00:00:00.000Z'));
  });
  afterEach(() => jest.restoreAllMocks());

  function boundService(tokenType: 'DPoP' | 'Bearer') {
    const proofs: Array<string | undefined> = [];
    const fetch: SessionFetch = async (url, init) => {
      if (url.endsWith('/v1/auth/nonce')) return respond({ status: 200, body: NONCE });
      proofs.push(init.headers?.DPoP);
      return respond({ status: 200, body: { ...TOKEN_ANSWER, token_type: tokenType } });
    };
    return { fetch, proofs };
  }

  it('sends a bound token as DPoP with a fresh proof for this method, URL and token', async () => {
    const service = boundService('DPoP');
    const source = createSessionTokenSource({
      authUrl: 'https://auth.example',
      credentials: [credential()],
      signer,
      fetch: service.fetch,
    });
    const headers = await source.authorize('get', 'https://gw.example/v1/payments/p1/status?x=1');
    expect(headers.Authorization).toBe(`DPoP ${TOKEN_ANSWER.access_token}`);
    const exchange = await verifyProof(service.proofs[0] as string);
    const { header, claims } = await verifyProof(headers.DPoP);
    // The same key that asked for the token signs every request.
    expect(jwkThumbprint(header.jwk)).toBe(jwkThumbprint(exchange.header.jwk));
    expect(claims).toMatchObject({
      htm: 'GET',
      htu: 'https://gw.example/v1/payments/p1/status',
      ath: createHash('sha256').update(TOKEN_ANSWER.access_token).digest('base64url'),
    });
    expect(source.current?.tokenType).toBe('DPoP');
  });

  it('sends a token the service did not bind as Bearer, with no proof', async () => {
    const source = createSessionTokenSource({
      authUrl: 'https://auth.example',
      credentials: [credential()],
      signer,
      fetch: boundService('Bearer').fetch,
    });
    expect(await source.authorize('POST', 'https://gw.example/v1/payments')).toEqual({
      Authorization: `Bearer ${TOKEN_ANSWER.access_token}`,
    });
  });

  it('sends no proof with the exchange when DPoP is turned off', async () => {
    const service = boundService('Bearer');
    const source = createSessionTokenSource({
      authUrl: 'https://auth.example',
      credentials: [credential()],
      signer,
      fetch: service.fetch,
      dpop: false,
    });
    await source.token();
    expect(service.proofs).toEqual([undefined]);
  });

  it('sends no session headers when no valid token can be had', async () => {
    const fetch: SessionFetch = async () =>
      respond({ status: 503, body: { code: 'SERVICE_UNAVAILABLE' } });
    const source = createSessionTokenSource({
      authUrl: 'https://auth.example',
      credentials: [credential()],
      signer,
      fetch,
    });
    expect(await source.authorize('POST', 'https://gw.example/v1/payments')).toEqual({});
  });
});
