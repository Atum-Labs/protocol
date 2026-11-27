// PaymentRequest TS JWS shim. Re-exports the lib's buildSecp256k1JWS /
// parseSecp256k1JWS under the local createDetachedJws / parseDetachedJws
// names used by sign.ts + verify.ts.

import {
  buildSecp256k1JWS,
  parseSecp256k1JWS,
  type JWSHeader,
} from "@atum-labs/ld-data-integrity";

// createDetachedJws wraps a 65-byte secp256k1 signature into a detached
// ES256K-R JWS. Thin alias over the lib's buildSecp256k1JWS.
export function createDetachedJws(signature: Uint8Array): string {
  return buildSecp256k1JWS(signature);
}

// parseDetachedJws parses a detached ES256K-R JWS into a typed header +
// 65-byte signature. Thin alias over the lib's parseSecp256k1JWS.
export function parseDetachedJws(jws: string): {
  header: JWSHeader;
  signature: Uint8Array;
} {
  return parseSecp256k1JWS(jws);
}
