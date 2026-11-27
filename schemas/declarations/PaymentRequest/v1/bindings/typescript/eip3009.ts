import { EIP3009_TOKENS, type Eip3009Token } from './generated/eip3009-tokens.js';

export { EIP3009_TOKENS, type Eip3009Token };

/**
 * Whether the token at `address` on the CAIP-2 `chain` implements EIP-3009
 * transferWithAuthorization, which an originator-fulfilled payment needs on its destination.
 * EVM addresses compare case-insensitively.
 */
export function supportsEip3009(chain: string, address: string): boolean {
  const wanted = address.toLowerCase();
  return (EIP3009_TOKENS[chain] ?? []).some((token) => token.address.toLowerCase() === wanted);
}

/**
 * Whether a PaymentRequest `executor` value assigns the fulfill leg to the originator. The
 * string form applies to every leg; the object form names fulfill on its own. Absent means
 * settler.
 */
export function fulfillsAsOriginator(executor: unknown): boolean {
  return legIsOriginator(executor, 'fulfill');
}

/**
 * Whether a PaymentRequest `executor` value assigns the deposit leg to the originator: the payer
 * funds the escrow itself with directDeposit. The string form applies to every leg; the object
 * form names deposit on its own. Absent means settler.
 */
export function depositsAsOriginator(executor: unknown): boolean {
  return legIsOriginator(executor, 'deposit');
}

function legIsOriginator(executor: unknown, leg: 'deposit' | 'fulfill'): boolean {
  if (executor === 'originator') return true;
  if (typeof executor === 'object' && executor !== null) {
    return (executor as Record<string, unknown>)[leg] === 'originator';
  }
  return false;
}
