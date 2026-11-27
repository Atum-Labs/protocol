import {
  matchEscrowWitness,
  MESSAGE_SCHEMES,
  WitnessKind,
} from '@atum-labs/solana-escrow-encoding';

/**
 * The escrow witness a Solana signed message is: a reserve when `messagePrehash` is a reserve
 * record (`{deposit_hash, recipient, quote_hash, source_amount}`), a deposit otherwise. Mirrors the
 * Go `solanaWitnessKind`.
 */
export function solanaWitnessKind(messagePrehash: string | undefined): WitnessKind {
  if (messagePrehash === undefined) return WitnessKind.Deposit;
  try {
    const record: unknown = JSON.parse(messagePrehash);
    if (
      typeof record === 'object' &&
      record !== null &&
      !Array.isArray(record) &&
      'quote_hash' in record &&
      'recipient' in record &&
      !('depositor' in record)
    ) {
      return WitnessKind.Reserve;
    }
  } catch {
    // Not JSON: not a reserve record.
  }
  return WitnessKind.Deposit;
}

/**
 * Whether `signature` is `publicKey`'s signature over `hash` in any form a Solana escrow accepts:
 * the raw hash, or the deposit or reserve escrow text (bare, v1 or v0). It proves the signer only;
 * which forms the escrow accepts is the binding check's. Mirrors the Go `solanaSignerMatches`.
 */
export function solanaSignerMatches(
  hash: Uint8Array,
  publicKey: Uint8Array,
  signature: Uint8Array,
): boolean {
  return MESSAGE_SCHEMES.some((scheme) =>
    [WitnessKind.Deposit, WitnessKind.Reserve].some(
      (kind) => matchEscrowWitness(scheme, kind, hash, publicKey, signature) !== undefined,
    ),
  );
}
