// Session tokens: proving to the Atum authorization service which wallet you are, in exchange for
// a short-lived bearer token that identifies you to the Payment Gateway.
//
// The session presentation is a signature of its own, separate from the three a PaymentRequest
// carries. It moves no funds and attests no document: it answers one single-use nonce, and the
// token it earns is not permission to move money.

import { createHash, randomBytes, webcrypto } from 'crypto';
import type { DeclarationSigner } from './declaration-signing';

// Loaded through require rather than a static import so no type edge to the upstream package is
// created. See envelope-signing.ts and declaration-signing.ts.
/* eslint-disable @typescript-eslint/no-require-imports -- the require is deliberate: a
   static import would create a type edge into @atum-labs/schema-declarations, whose raw .ts
   entry points fail the DTS build with TS6059. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vpSigning: any = require('@atum-labs/ld-signing');

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const PRESENTATION_TOKEN_TYPE = 'urn:atum:params:oauth:token-type:ldp_vp';
const EVM_HOLDER = /^did:pkh:eip155:[0-9]+:(0x[0-9a-fA-F]{40})$/;

/** The `POST /v1/auth/nonce` answer a session presentation is signed against. */
export interface SessionNonce {
  /** The single-use challenge the presentation answers. */
  nonce: string;
  /**
   * The environment the presentation is bound to. Copy it from the response; do not derive it
   * from the host you called.
   */
  expected_domain: string;
  /** Seconds the nonce stays usable. Sign and exchange it within that time. */
  expires_in: number;
}

/** A holder-signed presentation of the holder's credentials, answering one nonce. */
export interface SignedSessionPresentation {
  '@context': string[];
  type: string[];
  holder: string;
  verifiableCredential: unknown[];
  proof: {
    type: string;
    created: string;
    verificationMethod: string;
    proofPurpose: string;
    /** The nonce this presentation answers. */
    challenge: string;
    /** The environment this presentation is bound to. */
    domain: string;
    jws?: string;
    proofValue?: string;
  };
}

export interface SignSessionPresentationOptions {
  /**
   * The holder's credentials. At least one must be the Known to Atum credential issued to the
   * holder during onboarding, and every credential must be issued to the same holder: the
   * holder's `did:pkh` is read from their `credentialSubject.id`.
   */
  credentials: readonly unknown[];
  /**
   * Signs for the wallet the credentials were issued to. {@link signerFromEthersWallet} covers a
   * local key; any signer that can return its address and sign a digest works.
   */
  signer: DeclarationSigner;
  /** The nonce to answer, exactly as `POST /v1/auth/nonce` returned it. */
  nonce: SessionNonce;
  /** ISO timestamp for `proof.created`. Defaults to now; set it only to make output reproducible. */
  created?: string;
}

/**
 * Signs the presentation that `POST /v1/auth/token` exchanges for a session token.
 *
 * Supports holders identified by an EVM wallet (`did:pkh:eip155:<chain>:<address>`). Throws
 * before signing if the credentials name more than one holder, or if the signer is not the
 * holder's wallet: either would be refused by the authorization service.
 */
export async function signSessionPresentation(
  options: SignSessionPresentationOptions,
): Promise<SignedSessionPresentation> {
  const { credentials, signer, nonce, created } = options;

  if (!Array.isArray(credentials) || credentials.length === 0) {
    throw new Error(
      'signSessionPresentation: credentials must contain at least one credential, including ' +
        'the Known to Atum credential issued to the holder',
    );
  }
  if (
    !signer ||
    typeof signer.signDigest !== 'function' ||
    typeof signer.getAddress !== 'function'
  ) {
    throw new Error('signSessionPresentation: signer must implement getAddress and signDigest');
  }
  if (!nonce || typeof nonce.nonce !== 'string' || nonce.nonce === '') {
    throw new Error('signSessionPresentation: nonce.nonce is required');
  }
  if (typeof nonce.expected_domain !== 'string' || nonce.expected_domain === '') {
    throw new Error('signSessionPresentation: nonce.expected_domain is required');
  }

  const holder = holderOf(credentials);
  const match = EVM_HOLDER.exec(holder);
  if (!match) {
    throw new Error(
      `signSessionPresentation: the credentials are issued to ${holder}; a session holder must ` +
        'be an EVM wallet, did:pkh:eip155:<chain>:<address>',
    );
  }
  // Compared case-insensitively: an EVM address is the same account in any case, and the
  // credential may carry it checksummed or lowercase.
  const signerAddress = String(await signer.getAddress());
  if (signerAddress.toLowerCase() !== match[1].toLowerCase()) {
    throw new Error(
      `signSessionPresentation: the signer is ${signerAddress}, but the credentials are issued ` +
        `to ${match[1]}; sign with the wallet the credentials name`,
    );
  }

  return vpSigning.signVPWithSigner([...credentials], signer, {
    holder,
    verificationMethod: `${holder}#blockchainAccountId`,
    challenge: nonce.nonce,
    domain: nonce.expected_domain,
    created,
  });
}

// The one holder every credential is issued to. A presentation names a single holder and each
// credential's subject must be that holder, so a mixed bag is refused here rather than by the
// authorization service after the nonce is spent.
function holderOf(credentials: readonly unknown[]): string {
  const subjects = new Set<string>();
  for (const credential of credentials) {
    const subject = (credential as { credentialSubject?: { id?: unknown } } | null)
      ?.credentialSubject?.id;
    if (typeof subject !== 'string' || subject === '') {
      throw new Error('signSessionPresentation: every credential must have a credentialSubject.id');
    }
    subjects.add(subject);
  }
  if (subjects.size !== 1) {
    throw new Error(
      `signSessionPresentation: the credentials are issued to ${subjects.size} different holders ` +
        `(${[...subjects].join(', ')}); present only credentials issued to one wallet`,
    );
  }
  return [...subjects][0];
}

/** The subset of the Fetch API {@link requestSessionToken} uses. Node 18's global `fetch` fits. */
export type SessionFetch = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** How long each call to the authorization service may take, by default. */
export const DEFAULT_SESSION_TIMEOUT_MS = 10_000;

export interface RequestSessionTokenOptions {
  /**
   * The authorization service for your environment, for example
   * `https://auth.production-testnet.atum.xyz`. A trailing slash is ignored.
   */
  authUrl: string;
  /** As for {@link signSessionPresentation}. */
  credentials: readonly unknown[];
  /** As for {@link signSessionPresentation}. */
  signer: DeclarationSigner;
  /** Defaults to the global `fetch`. */
  fetch?: SessionFetch;
  /**
   * The most each of the two calls, nonce and token, may take before it is abandoned. Defaults to
   * {@link DEFAULT_SESSION_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  /**
   * A key to bind the token to (RFC 9449 DPoP), from {@link createDPoPKey}. The exchange then
   * carries a proof by it, and where the authorization service binds tokens the answer is a
   * `DPoP` token, which is sent only with a fresh proof by the same key. Where it does not, the
   * answer is a `Bearer` token as before.
   */
  dpop?: DPoPKey;
}

/**
 * A session token. A `Bearer` token is sent as `Authorization: Bearer <accessToken>`; a `DPoP`
 * token is bound to the key that requested it, and is sent as `Authorization: DPoP
 * <accessToken>` with a fresh proof by that key on every request ({@link createDPoPProof}).
 */
export interface SessionToken {
  /** The token. Treat it as opaque: its contents are not part of the contract. */
  accessToken: string;
  tokenType: 'Bearer' | 'DPoP';
  /** Seconds the token was valid for when it was issued. */
  expiresIn: number;
  /**
   * When the token stops being accepted, counted from when the token was requested. There is no
   * refresh: request a new token before then.
   */
  expiresAt: Date;
}

/**
 * A refused nonce or token request. `code` is the error code from the response body, when it had
 * one; `retryAfterSeconds` is set when the service said when to try again.
 *
 * Any refusal of the exchange means starting over: call {@link requestSessionToken} again, which
 * fetches a fresh nonce. Never resend a presentation.
 */
export class SessionTokenError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, status: number, code?: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'SessionTokenError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Requests a session token: fetches a nonce, signs the session presentation, and exchanges it.
 *
 * Every call is a new session with a fresh nonce, so retrying is calling again. Several tokens
 * for the same holder can be valid at once. To keep a token current across many requests, use
 * {@link createSessionTokenSource} instead.
 *
 * @throws {SessionTokenError} when the authorization service refuses the nonce or the exchange.
 * @throws {Error} when either call takes longer than `timeoutMs`.
 */
export async function requestSessionToken(
  options: RequestSessionTokenOptions,
): Promise<SessionToken> {
  const { authUrl, credentials, signer } = options;
  if (typeof authUrl !== 'string' || authUrl === '') {
    throw new Error('requestSessionToken: authUrl is required');
  }
  const fetchFn = options.fetch ?? defaultFetch();
  const timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  let base = authUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);

  const nonce = (await call(
    fetchFn,
    `${base}/v1/auth/nonce`,
    { method: 'POST' },
    'POST /v1/auth/nonce',
    timeoutMs,
  )) as Partial<SessionNonce>;
  if (
    typeof nonce.nonce !== 'string' ||
    typeof nonce.expected_domain !== 'string' ||
    typeof nonce.expires_in !== 'number'
  ) {
    throw new Error(
      'requestSessionToken: POST /v1/auth/nonce answered without nonce, expected_domain and expires_in',
    );
  }

  const presentation = await signSessionPresentation({
    credentials,
    signer,
    nonce: nonce as SessionNonce,
  });

  const form = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: JSON.stringify(presentation),
    subject_token_type: PRESENTATION_TOKEN_TYPE,
  });
  // Taken before the request is sent: the service starts the token's lifetime after it receives
  // the request, so counting from here never puts the expiry later than the service's.
  const requestedAt = Date.now();
  const token = (await call(
    fetchFn,
    `${base}/v1/auth/token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // The proof names this exchange's nonce, which makes it single-use.
        ...(options.dpop
          ? {
              DPoP: await createDPoPProof(options.dpop, {
                htm: 'POST',
                htu: `${base}/v1/auth/token`,
                nonce: nonce.nonce,
              }),
            }
          : {}),
      },
      body: form.toString(),
    },
    'POST /v1/auth/token',
    timeoutMs,
  )) as { access_token?: unknown; token_type?: unknown; expires_in?: unknown };
  const tokenType =
    typeof token.token_type === 'string' ? token.token_type.toLowerCase() : undefined;
  if (
    typeof token.access_token !== 'string' ||
    token.access_token === '' ||
    (tokenType !== 'bearer' && tokenType !== 'dpop') ||
    typeof token.expires_in !== 'number' ||
    !(token.expires_in > 0)
  ) {
    throw new Error(
      'requestSessionToken: POST /v1/auth/token answered without a Bearer or DPoP access_token and expires_in',
    );
  }
  // A DPoP token is usable only with proofs by the key it is bound to, so one we sent no key for
  // is of no use.
  if (tokenType === 'dpop' && !options.dpop) {
    throw new Error(
      'requestSessionToken: POST /v1/auth/token answered a DPoP token to an exchange that sent no DPoP proof',
    );
  }

  return {
    accessToken: token.access_token,
    tokenType: tokenType === 'dpop' ? 'DPoP' : 'Bearer',
    expiresIn: token.expires_in,
    expiresAt: new Date(requestedAt + token.expires_in * 1000),
  };
}

/**
 * A key a client holds to bind its session tokens to (RFC 9449 DPoP). The private half never
 * leaves the process: it is a non-extractable WebCrypto key, reachable only through `sign`.
 */
export interface DPoPKey {
  /** The public key, as a proof's `jwk` header carries it. */
  readonly publicJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  /** The key's RFC 7638 thumbprint: the `cnf.jkt` of every token bound to it. */
  readonly thumbprint: string;
  /** Signs a proof's signing input, ES256, as JOSE expects (r || s). */
  sign(input: Uint8Array): Promise<Uint8Array>;
}

/** Creates a fresh P-256 key to bind session tokens to. */
export async function createDPoPKey(): Promise<DPoPKey> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ]);
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('createDPoPKey: the platform exported a public key without x and y');
  }
  const publicJwk = { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x, y: jwk.y };
  return {
    publicJwk,
    thumbprint: jwkThumbprint(publicJwk),
    async sign(input) {
      return new Uint8Array(
        await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, input),
      );
    },
  };
}

/** RFC 7638: the required members in lexicographic order, compact, hashed with SHA-256. */
export function jwkThumbprint(jwk: { kty: string; crv: string; x: string; y: string }): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash('sha256').update(canonical).digest('base64url');
}

/** What a DPoP proof names: the request, and for a token request the exchange's nonce. */
export interface DPoPProofClaims {
  /** The request's method. */
  htm: string;
  /** The request's URL. Its query and fragment are dropped, as RFC 9449 asks. */
  htu: string;
  /** The session nonce, on the token exchange. */
  nonce?: string;
  /** The token the request sends, on every request after the exchange: hashed into `ath`. */
  accessToken?: string;
}

/** Creates an RFC 9449 proof by key: a `dpop+jwt`, signed ES256, with a fresh `jti`. */
export async function createDPoPProof(
  key: DPoPKey,
  claims: DPoPProofClaims,
  now: number = Date.now(),
): Promise<string> {
  const url = new URL(claims.htu);
  url.search = '';
  url.hash = '';
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk };
  const payload = {
    jti: randomBytes(16).toString('base64url'),
    htm: claims.htm.toUpperCase(),
    htu: url.toString(),
    iat: Math.floor(now / 1000),
    ...(claims.nonce !== undefined ? { nonce: claims.nonce } : {}),
    ...(claims.accessToken !== undefined
      ? { ath: createHash('sha256').update(claims.accessToken).digest('base64url') }
      : {}),
  };
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const signature = await key.sign(new TextEncoder().encode(input));
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

function defaultFetch(): SessionFetch {
  const global = (globalThis as { fetch?: unknown }).fetch;
  if (typeof global !== 'function') {
    throw new Error('requestSessionToken: no global fetch; pass options.fetch');
  }
  return global as SessionFetch;
}

// One call to the authorization service, abandoned after timeoutMs. The body is read inside the
// same window, and the race stands even for a fetch that ignores the abort signal, so a service
// that stops answering can never hold the caller longer than the timeout.
async function call(
  fetchFn: SessionFetch,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  what: string,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`requestSessionToken: ${what} did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchFn(url, { ...init, signal: controller.signal }).then((response) =>
        readJSON(response, what),
      ),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// The body of a successful answer as JSON, or a SessionTokenError carrying the refusal's code.
async function readJSON(
  response: Awaited<ReturnType<SessionFetch>>,
  what: string,
): Promise<unknown> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (response.ok) {
    if (body === undefined) {
      throw new SessionTokenError(
        `${what} answered ${response.status} without a JSON body`,
        response.status,
      );
    }
    return body;
  }
  const code =
    typeof (body as { code?: unknown } | undefined)?.code === 'string'
      ? (body as { code: string }).code
      : undefined;
  const message =
    typeof (body as { message?: unknown } | undefined)?.message === 'string'
      ? (body as { message: string }).message
      : undefined;
  const retryAfter = Number(response.headers.get('Retry-After'));
  throw new SessionTokenError(
    `${what} answered ${response.status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`,
    response.status,
    code,
    Number.isFinite(retryAfter) && retryAfter >= 0 && response.headers.get('Retry-After') !== null
      ? retryAfter
      : undefined,
  );
}

/** How long before expiry a {@link SessionTokenSource} starts renewing, by default. */
export const DEFAULT_RENEW_BEFORE_MS = 2 * 60 * 1000;
/** How long a {@link SessionTokenSource} waits after a failure that named no `Retry-After`. */
export const DEFAULT_RETRY_AFTER_MS = 10_000;
/**
 * How long a caller holding no valid token waits for a new session, by default. A healthy nonce,
 * signature and exchange take well under this; past it the call goes out without a session.
 */
export const DEFAULT_MAX_WAIT_MS = 2_000;

export interface SessionTokenSourceOptions extends Omit<RequestSessionTokenOptions, 'dpop'> {
  /**
   * Start renewing this long before the held token expires. Defaults to
   * {@link DEFAULT_RENEW_BEFORE_MS}; a token whose whole life is shorter is renewed at its halfway
   * point.
   */
  renewBeforeMs?: number;
  /**
   * How long a caller holding no valid token waits for a new session before it gets none, so a
   * request is not held back by a slow or hanging authorization service: the gateway serves a
   * request without a session. The renewal goes on in the background, and the next caller can use
   * its token. Defaults to {@link DEFAULT_MAX_WAIT_MS}; `0` never waits.
   */
  maxWaitMs?: number;
  /**
   * Called with every failed renewal. The source keeps using a still-valid token and tries again
   * later, so this is where to log or alert.
   */
  onError?: (error: unknown) => void;
  /**
   * Bind the session's tokens to a key the source holds (RFC 9449 DPoP), so a copy of a token is
   * of no use without it. On by default; the key is created with the first session and kept for
   * the source's life. Where the authorization service does not bind tokens, they are `Bearer`
   * tokens either way.
   */
  dpop?: boolean;
}

/**
 * Keeps a session token current for a long-running client. Pass it to the Payment Gateway client
 * as `session`, which sends the right headers on every request.
 */
export interface SessionTokenSource {
  /**
   * The headers that carry the session on one request: `Authorization: DPoP` with a fresh proof
   * for this method and URL when the token is bound to the source's key, `Authorization: Bearer`
   * when it is not, and none when no valid token can be had, in which case the gateway serves the
   * request without a session. Never throws. This is what the client's `session` option calls.
   */
  authorize(method: string, url: string): Promise<Record<string, string>>;
  /**
   * The token to send now, or the empty string when no valid token can be had. Never throws.
   *
   * By default the token is bound to this source's key (DPoP) and works only with a proof on
   * each request. Passed as the client's `TOKEN`, it goes out as `Bearer` and the gateway serves
   * the call as anonymous, with no error. Use the client's `session` option instead.
   *
   * A held token is returned at once. Inside the renewal window it is still returned at once,
   * and a new session is requested in the background; only a caller holding no valid token
   * waits for one, and for at most `maxWaitMs`. Awaiting `token()` once at startup takes even
   * that wait off the first request. After a failure no new session is requested before the
   * service's `Retry-After`, or {@link DEFAULT_RETRY_AFTER_MS} when it named none.
   */
  token(): Promise<string>;
  /** The token currently held, valid or not, if a session has been established. */
  readonly current: SessionToken | undefined;
  /** The most recent renewal failure, cleared by the next success. */
  readonly lastError: unknown;
}

/** Creates a {@link SessionTokenSource}. Nothing is requested until the first `token()` call. */
export function createSessionTokenSource(options: SessionTokenSourceOptions): SessionTokenSource {
  const {
    renewBeforeMs = DEFAULT_RENEW_BEFORE_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    onError,
    dpop = true,
    ...request
  } = options;
  // One key for the source's life, created with the first session.
  let key: Promise<DPoPKey> | undefined;
  const now = () => Date.now();
  let held: SessionToken | undefined;
  let renewing: Promise<void> | undefined;
  let notBefore = 0;
  let lastError: unknown;

  // The held token while it is still accepted.
  const usable = (): SessionToken | undefined =>
    held !== undefined && held.expiresAt.getTime() > now() ? held : undefined;
  const dueForRenewal = (token: SessionToken): boolean =>
    token.expiresAt.getTime() - now() <= Math.min(renewBeforeMs, (token.expiresIn * 1000) / 2);

  // One renewal at a time, shared by every caller; a failure is recorded, never thrown.
  const renew = (): Promise<void> => {
    renewing ??= (dpop ? (key ??= createDPoPKey()) : Promise.resolve(undefined))
      .then((dpopKey) => requestSessionToken({ ...request, dpop: dpopKey }))
      .then((token) => {
        held = token;
        lastError = undefined;
      })
      .catch((error: unknown) => {
        lastError = error;
        const retryAfterSeconds =
          error instanceof SessionTokenError ? error.retryAfterSeconds : undefined;
        notBefore =
          now() +
          (retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : DEFAULT_RETRY_AFTER_MS);
        try {
          onError?.(error);
        } catch {
          // A throwing callback must not turn a failed renewal into a failed request.
        }
      })
      .finally(() => {
        renewing = undefined;
      });
    return renewing;
  };

  // The renewal, or maxWaitMs, whichever comes first. The renewal is never abandoned: a caller
  // that stops waiting leaves it to finish for the next one.
  const renewWithin = async (): Promise<void> => {
    const renewal = renew();
    if (maxWaitMs <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        renewal,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, maxWaitMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  // The token to send now, renewing as token() describes.
  const currentToken = async (): Promise<SessionToken | undefined> => {
    const current = usable();
    if (current !== undefined) {
      if (dueForRenewal(current) && now() >= notBefore) void renew();
      return current;
    }
    if (now() < notBefore) return undefined;
    await renewWithin();
    return usable();
  };

  return {
    async token() {
      return (await currentToken())?.accessToken ?? '';
    },
    async authorize(method, url): Promise<Record<string, string>> {
      const token = await currentToken();
      if (token === undefined) return {};
      if (token.tokenType !== 'DPoP') return { Authorization: `Bearer ${token.accessToken}` };
      try {
        const proof = await createDPoPProof(await (key as Promise<DPoPKey>), {
          htm: method,
          htu: url,
          accessToken: token.accessToken,
        });
        return { Authorization: `DPoP ${token.accessToken}`, DPoP: proof };
      } catch {
        // A bound token without its proof is refused at the edge; send no session instead.
        return {};
      }
    },
    get current() {
      return held;
    },
    get lastError() {
      return lastError;
    },
  };
}
