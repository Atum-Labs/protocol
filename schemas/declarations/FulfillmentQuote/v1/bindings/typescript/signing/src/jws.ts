// FQ TS JWS shim. Re-exports the lib's
// buildSecp256k1JWS / parseSecp256k1JWS under FQ's pre-1824 names so
// callers (sign.ts, sign-vp.ts, verify.ts, etc.) keep compiling.

import {
  buildSecp256k1JWS,
  parseSecp256k1JWS,
  type JWSHeader,
} from "@atum-labs/ld-data-integrity";

// createDetachedJws is the earlier name; the lib's
// buildSecp256k1JWS is the canonical name. Thin alias kept for
// caller back-compat.
export function createDetachedJws(signature: Uint8Array): string {
  return buildSecp256k1JWS(signature);
}

// parseDetachedJws is the earlier name; the lib's
// parseSecp256k1JWS returns the same shape (typed header + 65-byte
// signature). Thin alias kept for caller back-compat.
export function parseDetachedJws(jws: string): {
  header: JWSHeader;
  signature: Uint8Array;
} {
  return parseSecp256k1JWS(jws);
}
