import { z } from 'zod';

/**
 * Signing policy shape shared by the client-side evaluator and the server-side policy deriver
 * in `@atum-labs/turnkey-signer/admin`, which translates this schema into Turnkey policy inputs.
 * `undefined` = unspecified (allow), `[]` = deny-all, `'any'` = explicit allow.
 */
export const ZSigningPolicy = z.object({
  allowedTo: z.union([z.array(z.string().min(1)), z.literal('any')]).optional(),
  allowedSelectors: z
    .union([z.array(z.string().regex(/^0x[0-9a-f]{8}$/i)), z.literal('any')])
    .optional(),
  allowedPrograms: z.union([z.array(z.string().min(1)), z.literal('any')]).optional(),
  allowedAnchorDiscriminators: z
    .record(
      z.string().min(1),
      z.union([z.array(z.string().regex(/^[0-9a-f]{16}$/i)), z.literal('any')]),
    )
    .optional(),
  /** Max native value moved per call, in the chain's smallest unit (wei/sun/lamports). Decimal string. */
  maxNativeValue: z.string().regex(/^\d+$/).default('0'),
  maxGasLimit: z.number().int().positive().optional(),
  maxFeePerGasWei: z.string().regex(/^\d+$/).optional(),
  maxFeeLimitSun: z.string().regex(/^\d+$/).optional(),
  requireChainIdMatch: z.boolean().default(true),
  /** Factory-injected signer EOA enabling the EVM self-send nonce-burn carve-out. */
  selfAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});

export type SigningPolicy = z.infer<typeof ZSigningPolicy>;
