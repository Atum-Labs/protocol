/**
 * Guard that the account about to send the approval is the account the allowance was read for.
 *
 * `owner` and the client that signs are separate inputs, and an approval only ever applies to
 * the account that sends it: ERC-20 and TRC-20 both credit `msg.sender`. So a client for a
 * different account approves THAT account, returns a transaction hash that reads as success,
 * and leaves `owner` exactly as unapproved as before — the settlement revert this package
 * exists to prevent, now with a receipt attached to it and no error anywhere.
 *
 * Compared case-insensitively. EVM addresses carry EIP-55 checksum casing, so the same account
 * is spelled both ways by different tools. Tron's base58 is case-sensitive in principle, but
 * changing the case of a valid address invalidates its checksum, so no two real accounts differ
 * by case alone.
 *
 * A `sender` of undefined means the client cannot say which account it would send from. There
 * is nothing to compare then, and refusing would block clients that work.
 */
export function assertSenderIsOwner(owner: string, sender: string | undefined): void {
  if (sender === undefined || sender.toLowerCase() === owner.toLowerCase()) return;
  throw new Error(
    `token_approval: the approval would be sent by ${sender}, but the allowance is being ` +
      `granted for ${owner}. An approval only ever applies to the account that sends it, so ` +
      `this would approve ${sender} and leave ${owner} unable to pay. Pass a signer for ` +
      `${owner}, or read the allowance for ${sender}.`,
  );
}
