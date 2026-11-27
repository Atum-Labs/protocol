// Detached ES256K-R JWS construction + parsing for the
// EcdsaSecp256k1RecoverySignature2020 cryptosuite. Mirror of the Go
// lib's jws.go.
//
// The detached form: `<base64url(header)>..<base64url(signature)>`
// with an empty payload segment. The payload is the canonicalized +
// hashed document, transmitted out-of-band via the document itself.
//
// b64=false + crit=["b64"] together signal RFC 7797 detached-payload
// mode. A strict JOSE validator that doesn't understand b64 MUST
// reject per RFC 7515 §4.1.11 — prevents a split-trust bypass where
// a lenient peer accepts and ignores the unknown extension while a
// stricter peer rejects.

import { MalformedProofError } from "./errors.js";

export interface JWSHeader {
  alg: string;
  b64: boolean;
  crit: string[];
}

// ES256K-R header pre-marshaled at module load so buildSecp256k1JWS
// doesn't re-stringify it on every signing call.
const ES256KR_HEADER: JWSHeader = {
  alg: "ES256K-R",
  b64: false,
  crit: ["b64"],
};

const ES256KR_HEADER_B64 = Buffer.from(JSON.stringify(ES256KR_HEADER)).toString(
  "base64url"
);

// buildSecp256k1JWS produces a detached ES256K-R JWS string from a
// 65-byte secp256k1 signature (r||s||v). The empty payload segment
// is intentional (detached payload per RFC 7797). Throws
// MalformedProofError if `signature` is not exactly 65 bytes.
export function buildSecp256k1JWS(signature: Uint8Array): string {
  if (signature.length !== 65) {
    throw new MalformedProofError(
      `signature must be 65 bytes, got ${signature.length}`
    );
  }
  return `${ES256KR_HEADER_B64}..${Buffer.from(signature).toString("base64url")}`;
}

// parseSecp256k1JWS parses a detached ES256K-R JWS and returns the
// parsed header + 65-byte signature. Enforces RFC 7797 / W3C Data
// Integrity invariants:
//
//   - alg MUST be "ES256K-R"
//   - b64 MUST be false
//   - crit MUST contain "b64" (RFC 7515 §4.1.11 — recipient rejects
//     unrecognized crit values; we only understand "b64", so any
//     other entry is an attacker-shaped strict-validator bypass)
//   - signature MUST decode to exactly 65 bytes
//
// All failure modes throw MalformedProofError.
export function parseSecp256k1JWS(jws: string): {
  header: JWSHeader;
  signature: Uint8Array;
} {
  const parts = jws.split("..");
  if (parts.length !== 2) {
    throw new MalformedProofError(
      "invalid detached JWS format: expected header..signature"
    );
  }

  let header: JWSHeader;
  try {
    header = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf-8")
    ) as JWSHeader;
  } catch (err) {
    throw new MalformedProofError("parse JWS header", err);
  }

  if (header.alg !== "ES256K-R") {
    throw new MalformedProofError(
      `unsupported alg ${JSON.stringify(header.alg)} (want ES256K-R)`
    );
  }
  if (header.b64) {
    throw new MalformedProofError("expected b64=false for detached JWS");
  }
  if (!Array.isArray(header.crit)) {
    throw new MalformedProofError("missing crit header parameter");
  }
  for (const c of header.crit) {
    if (c !== "b64") {
      throw new MalformedProofError(
        `unrecognized crit header parameter ${JSON.stringify(c)}`
      );
    }
  }
  if (!header.crit.includes("b64")) {
    throw new MalformedProofError(
      'expected crit to contain "b64" for detached JWS'
    );
  }

  const signature = new Uint8Array(Buffer.from(parts[1], "base64url"));
  if (signature.length !== 65) {
    throw new MalformedProofError(
      `invalid signature length: expected 65 bytes, got ${signature.length}`
    );
  }

  return { header, signature };
}
