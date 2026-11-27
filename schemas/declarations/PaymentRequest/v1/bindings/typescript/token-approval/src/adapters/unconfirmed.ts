/**
 * A transaction that was broadcast and not seen to confirm. Not a failure — an unknown.
 *
 * The tag, rather than the wording, is the contract: it is what lets a caller tell "this is
 * broken, do something" from "this is probably fine, go and look". Every path that catches an
 * error and re-throws its own must carry the tag through, or a pending approval turns into a
 * confident statement about an allowance nobody has read.
 *
 * Shared by both chain adapters so the two cannot answer the question differently.
 */
export function unconfirmed(message: string): Error {
  return Object.assign(new Error(message), { unconfirmed: true });
}

/** Whether an error came from a broadcast transaction that was never seen to confirm. */
export function isUnconfirmed(error: unknown): boolean {
  return (error as { unconfirmed?: boolean } | null)?.unconfirmed === true;
}
