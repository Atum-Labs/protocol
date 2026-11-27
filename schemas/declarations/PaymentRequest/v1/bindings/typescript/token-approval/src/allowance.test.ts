import { describe, it, expect } from "vitest";
import { MaxUint256 } from "ethers";
import {
  UNLIMITED_APPROVAL,
  UNLIMITED_APPROVAL_FLOOR,
  effectiveRequirement,
  isAllowanceSufficient,
  resolveApprovalAmount,
} from "./allowance.js";

describe("UNLIMITED_APPROVAL_FLOOR", () => {
  it("is half of the maximum uint256", () => {
    expect(UNLIMITED_APPROVAL_FLOOR).toBe(MaxUint256 / 2n);
    expect(UNLIMITED_APPROVAL).toBe(MaxUint256);
  });
});

describe("isAllowanceSufficient", () => {
  describe("without a required amount (the caller wants an unlimited approval)", () => {
    it("accepts a fresh unlimited allowance", () => {
      expect(isAllowanceSufficient(MaxUint256)).toBe(true);
    });

    // The reported defect: Permit2's transferFrom decrements the owner->Permit2 allowance on
    // every payment, so from the first payment onwards it is no longer exactly MaxUint256.
    // Gating on equality re-approved before every subsequent payment.
    it("accepts an unlimited allowance already decremented by earlier payments", () => {
      expect(isAllowanceSufficient(MaxUint256 - 10_000_000n)).toBe(true);
    });

    it("accepts an allowance exactly at the floor", () => {
      expect(isAllowanceSufficient(UNLIMITED_APPROVAL_FLOOR)).toBe(true);
    });

    it("rejects an allowance one unit below the floor, which is a bounded approval", () => {
      expect(isAllowanceSufficient(UNLIMITED_APPROVAL_FLOOR - 1n)).toBe(false);
    });

    it("rejects a small leftover allowance, which must not pass as unlimited", () => {
      expect(isAllowanceSufficient(5n)).toBe(false);
      expect(isAllowanceSufficient(0n)).toBe(false);
    });
  });

  describe("with a required amount (the caller wants to cover THIS charge)", () => {
    it("accepts an allowance that covers it exactly", () => {
      expect(isAllowanceSufficient(100n, 100n)).toBe(true);
    });

    it("rejects an allowance short of it", () => {
      expect(isAllowanceSufficient(99n, 100n)).toBe(false);
    });

    it("is not affected by the unlimited floor", () => {
      expect(isAllowanceSufficient(1n, 1n)).toBe(true);
    });
  });
});

describe("resolveApprovalAmount", () => {
  it("defaults to unlimited", () => {
    expect(resolveApprovalAmount(undefined, undefined)).toBe(MaxUint256);
    expect(resolveApprovalAmount(undefined, 100n)).toBe(MaxUint256);
  });

  it("passes a bounded amount through", () => {
    expect(resolveApprovalAmount(500n, 100n)).toBe(500n);
    expect(resolveApprovalAmount(100n, 100n)).toBe(100n);
  });

  it("refuses a bounded amount below what this charge needs, which would approve in a loop", () => {
    expect(() => resolveApprovalAmount(99n, 100n)).toThrow(/below requiredAllowance/);
  });

  it("refuses a non-positive amount", () => {
    expect(() => resolveApprovalAmount(0n)).toThrow(/must be positive/);
    expect(() => resolveApprovalAmount(-1n)).toThrow(/must be positive/);
  });
});

describe("effectiveRequirement", () => {
  it("has no requirement when the caller wants an unlimited approval", () => {
    expect(effectiveRequirement(undefined, undefined)).toBeUndefined();
  });

  // Otherwise a bounded approval is never "unlimited", so every later call would judge the
  // allowance it just granted insufficient and approve again.
  it("makes a bounded amount its own requirement", () => {
    expect(effectiveRequirement(undefined, 5_000n)).toBe(5_000n);
  });

  it("lets an explicit requirement win over the amount", () => {
    expect(effectiveRequirement(100n, 5_000n)).toBe(100n);
  });
});
