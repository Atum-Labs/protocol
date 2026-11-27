import { buildReserveMessage } from '@atum-labs/payment-request-sender-auth';
import type { ReserveMessageInput } from '@atum-labs/payment-request-sender-auth';
import type { ReserveAuth } from './generated/types.gen';
import type { SenderSigner } from './signers/types';

/**
 * Builds the reserve for a chosen quote and has `signer`, the reserver the deposit names, sign it.
 * Throws before signing on input the escrow could never accept.
 */
export async function signReserveAuth(
  input: ReserveMessageInput,
  signer: SenderSigner,
): Promise<ReserveAuth> {
  const reserve = buildReserveMessage(input);
  const { signature } = await signer.sign({ ...reserve, signature: '' });
  return { ...reserve, signature };
}
