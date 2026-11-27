/**
 * Internal plumbing shared by the role mechanisms. Not part of the published
 * surface: nothing here is re-exported from `./client`, `./server`,
 * `./facilitator`, or `./fetch`.
 *
 * These helpers arrived with the package from its previous home, where they lived
 * in a protocol-agnostic `shared` sibling alongside the facilitator service. Here
 * there is no such sibling — the SDK is the whole deliverable — so the pieces
 * it actually used live in this module rather than in a package that would exist
 * only to hold them.
 */

import { z } from 'zod';
import { fromError } from 'zod-validation-error';
import { normalizeAddress } from '@atum-labs/tvm-escrow-encoding';
/**
 * Render a `ZodError` as a single readable line for logs and error messages.
 *
 * `fromError` accepts `unknown`, which side-steps the zod v3/v4 core type split.
 */
export function formatZodError(error: z.ZodError): string {
  return fromError(error).toString();
}

/**
 * Chain-aware address equality. EVM (`eip155`) addresses are case-insensitive (checksum
 * casing is cosmetic); base58 addresses (Solana/Tron) are case-SENSITIVE, so only the
 * `eip155` namespace is lowercased before comparing.
 */
export function caipEqual(caip2: string, a: string, b: string): boolean {
  const namespace = caip2.split(':')[0];
  if (namespace === 'eip155') {
    return a.toLowerCase() === b.toLowerCase();
  }
  if (namespace === 'tron') {
    // A Tron source compares base58 addresses (source.account, roles from the merchant)
    // against the bare 20-byte hex the signed Permit2 witness carries; normalize both.
    try {
      return normalizeAddress(a).toLowerCase() === normalizeAddress(b).toLowerCase();
    } catch {
      return false; // a malformed address never matches
    }
  }
  return a === b;
}
