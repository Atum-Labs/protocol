// P-256 stamp builder for Turnkey API authentication.
//
// Every Turnkey API request must carry an `X-Stamp` header whose value is a base64url-encoded
// JSON envelope `{ publicKey, signature, scheme }`. The signature is ECDSA(P-256, SHA-256) over
// the raw request body bytes, DER-encoded.
//
// Implemented via Node's Web Crypto (`webcrypto.subtle.sign`) plus a hand-built PKCS#8 wrapper
// for the 32-byte private scalar — keeps this module zero-dependency on the @turnkey/* SDKs.
//
// Web Crypto emits the signature in compact IEEE P1363 form (raw r||s, 64 bytes); Turnkey's
// published API-authentication format requires DER. The conversion below trims leading zeros
// and re-prepends a zero byte when the high bit is set, so each component stays a positive
// ASN.1 INTEGER — the Ecdsa-Sig-Value encoding specified in RFC 3279 §2.2.3.

import { webcrypto } from 'node:crypto';

const SCHEME = 'SIGNATURE_SCHEME_TK_API_P256';

/**
 * Cached CryptoKey for a single P-256 API private scalar. Constructed once per stamper
 * instance — Web Crypto's `importKey` is non-trivial cost (~5–10ms) and we sign on every
 * request.
 */
export interface TurnkeyStamper {
  /** Compressed P-256 public key (33 bytes, hex). Embedded in every stamp envelope. */
  readonly publicKeyHex: string;
  /** Sign the request body bytes and return the base64url-encoded X-Stamp header value. */
  stamp(bodyJson: string): Promise<string>;
}

/**
 * Build a `TurnkeyStamper` from a 32-byte P-256 private scalar (hex) and its compressed
 * public key (hex). The private key is imported once via Web Crypto and cached — never
 * leaves this module — so the public surface is just `stamp(bodyJson)`.
 */
export async function createTurnkeyStamper(
  apiPrivateKeyHex: string,
  apiPublicKeyHex: string,
): Promise<TurnkeyStamper> {
  const scalar = Buffer.from(apiPrivateKeyHex, 'hex');
  if (scalar.length !== 32) {
    throw new Error(
      `Turnkey API private key must be a 32-byte P-256 scalar (got ${scalar.length} bytes)`,
    );
  }
  if (!/^0[23][0-9a-fA-F]{64}$/.test(apiPublicKeyHex)) {
    throw new Error(
      `Turnkey API public key must be 33-byte compressed P-256 (66 hex chars, 02/03 prefix); got '${apiPublicKeyHex.slice(0, 8)}…'`,
    );
  }

  const pkcs8 = buildP256Pkcs8(scalar);
  const cryptoKey = await webcrypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  return {
    publicKeyHex: apiPublicKeyHex,
    async stamp(bodyJson: string): Promise<string> {
      const sigBuf = await webcrypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        cryptoKey,
        Buffer.from(bodyJson, 'utf8'),
      );
      const derHex = p1363ToDer(sigBuf).toString('hex');
      const envelope = JSON.stringify({
        publicKey: apiPublicKeyHex,
        signature: derHex,
        scheme: SCHEME,
      });
      return Buffer.from(envelope, 'utf8').toString('base64url');
    },
  };
}

/**
 * Build PKCS#8 DER (RFC 5208 / RFC 5915) for a P-256 private scalar with the public-key
 * BIT STRING omitted. The omission is legal under RFC 5915 and Web Crypto accepts it.
 *
 * Layout (hand-computed lengths verified against an OpenSSL-emitted reference):
 *   30 41 02 01 00
 *     30 13 06 07 2a 86 48 ce 3d 02 01 06 08 2a 86 48 ce 3d 03 01 07    // AlgorithmIdentifier
 *     04 27 30 25 02 01 01 04 20 <32-byte scalar>                       // OCTET STRING wrapping ECPrivateKey
 */
function buildP256Pkcs8(scalar: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from('3041020100', 'hex'),
    Buffer.from('301306072a8648ce3d020106082a8648ce3d030107', 'hex'),
    Buffer.from('042730250201010420', 'hex'),
    scalar,
  ]);
}

/**
 * Convert IEEE P1363 (compact r||s, 64 bytes) to DER (SEQUENCE of two INTEGERs).
 * Each component re-encodes as a minimal-length INTEGER: strip leading zeros, then reinstate
 * one if the high bit is set so the value stays positive in ASN.1's signed-integer encoding.
 *
 * Exported for unit tests; not part of the module's public surface.
 */
export function p1363ToDer(sig: ArrayBuffer): Buffer {
  const raw = Buffer.from(sig);
  if (raw.length !== 64) throw new Error(`Expected 64-byte P1363 signature, got ${raw.length}`);
  const r = trimAndPadInt(raw.subarray(0, 32));
  const s = trimAndPadInt(raw.subarray(32, 64));
  const seq = Buffer.concat([Buffer.from([0x02, r.length]), r, Buffer.from([0x02, s.length]), s]);
  return Buffer.concat([Buffer.from([0x30, seq.length]), seq]);
}

function trimAndPadInt(bytes: Buffer): Buffer {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const trimmed = bytes.subarray(i);
  // r=0 or s=0 is a degenerate ECDSA signature (the signing equation breaks). DER allows
  // INTEGER 0 structurally, so without this check we'd send a wire-valid stamp that Turnkey
  // rejects as 401 → surfaces as TURNKEY_AUTH (terminal). That sends operator triage to
  // "check the API key" instead of the real root cause ("stamper produced a degenerate
  // signature; SubtleCrypto is broken or seeded badly"). Fail loud at the source instead.
  if (trimmed.length === 1 && trimmed[0] === 0) {
    throw new Error('p1363ToDer: signature component is zero (degenerate ECDSA signature)');
  }
  const high = trimmed[0] ?? 0;
  return (high & 0x80) !== 0 ? Buffer.concat([Buffer.from([0x00]), trimmed]) : Buffer.from(trimmed);
}
