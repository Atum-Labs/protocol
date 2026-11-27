/**
 * TVM (Tron) Permit2 helpers: address normalization, chain id masking and the TIP-712 digest,
 * re-exported from @atum-labs/tvm-escrow-encoding (byte-parity with the Go encoder) as part of this
 * package's public API.
 */

export {
  base58ToHex,
  normalizeAddress,
  maskChainId,
  hashTvmPermitWitnessTransferFrom,
} from '@atum-labs/tvm-escrow-encoding';
