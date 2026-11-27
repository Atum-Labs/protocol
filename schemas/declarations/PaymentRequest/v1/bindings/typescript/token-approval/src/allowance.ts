import { MaxUint256 } from "ethers";

/** The unlimited approval this package grants unless the caller bounds it. */
export const UNLIMITED_APPROVAL = MaxUint256;

/**
 * Floor at which an existing allowance still counts as an unlimited approval.
 *
 * Permit2's `transferFrom` DECREMENTS the owner->Permit2 allowance on every payment, so an
 * allowance granted as unlimited sits below `MaxUint256` from the first payment onwards.
 * Gating on equality with `MaxUint256` therefore stops short-circuiting after that first
 * payment and re-approves before every subsequent one — correct, but paying gas for an
 * approval the owner already holds.
 *
 * Half of `MaxUint256` separates "unlimited, partly spent" from a deliberately bounded
 * approval: crossing it takes ~5.8e76 token units of spend, which no real balance reaches.
 */
export const UNLIMITED_APPROVAL_FLOOR = MaxUint256 / 2n;

/**
 * Whether an existing allowance covers what the caller asked for.
 *
 * With an explicit `requiredAllowance`, sufficiency means the allowance covers THIS charge.
 * Without one, the caller wants an unlimited approval, measured against
 * {@link UNLIMITED_APPROVAL_FLOOR} rather than `MaxUint256` — see its doc comment.
 */
export function isAllowanceSufficient(current: bigint, requiredAllowance?: bigint): boolean {
  return requiredAllowance !== undefined
    ? current >= requiredAllowance
    : current >= UNLIMITED_APPROVAL_FLOOR;
}

/**
 * What an existing allowance has to cover for this call.
 *
 * A bounded `approvalAmount` is its OWN requirement. Without this, a caller who asks to approve
 * five million and nothing else would grant exactly that, then find five million measured
 * against {@link UNLIMITED_APPROVAL_FLOOR} on the next call, judge it insufficient, and approve
 * again — every call, forever. That is the same defect this package exists to fix, so the
 * pairing is derived here rather than left to every caller to remember.
 */
export function effectiveRequirement(
  requiredAllowance?: bigint,
  approvalAmount?: bigint,
): bigint | undefined {
  return requiredAllowance ?? approvalAmount;
}

/**
 * The amount to put on the wire for an approval, and the guard that a bounded one is not
 * self-defeating.
 *
 * Approving less than this charge needs would leave the allowance short the moment the
 * transaction confirms, so the next call would approve again, forever. Refuse it here rather
 * than burn the caller's gas in a loop.
 */
export function resolveApprovalAmount(
  approvalAmount?: bigint,
  requiredAllowance?: bigint,
): bigint {
  if (approvalAmount === undefined) return UNLIMITED_APPROVAL;
  if (approvalAmount <= 0n) {
    throw new Error(`token_approval: approvalAmount must be positive, got ${approvalAmount}`);
  }
  if (requiredAllowance !== undefined && approvalAmount < requiredAllowance) {
    throw new Error(
      `token_approval: approvalAmount ${approvalAmount} is below requiredAllowance ` +
        `${requiredAllowance}, so the approval would still fall short and every call would ` +
        `send another one`,
    );
  }
  return approvalAmount;
}
