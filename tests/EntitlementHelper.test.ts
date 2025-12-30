import { describe, it, expect } from "bun:test";
import { EntitlementHelper } from "../src/helpers/EntitlementHelper";
import type { RateLimitsConfig } from "../src/types";

const testConfig: RateLimitsConfig = {
  none: { hourly: 5, daily: 20, monthly: 100 },
  starter: { hourly: 10, daily: 50, monthly: 500 },
  pro: { hourly: 100, daily: undefined, monthly: undefined },
  enterprise: { hourly: undefined, daily: undefined, monthly: undefined },
};

describe("EntitlementHelper", () => {
  describe("getRateLimits with single entitlement", () => {
    const helper = new EntitlementHelper(testConfig);

    it("should return limits for known entitlement", () => {
      const limits = helper.getRateLimits("starter");
      expect(limits).toEqual({ hourly: 10, daily: 50, monthly: 500 });
    });

    it("should return 'none' limits for unknown entitlement", () => {
      const limits = helper.getRateLimits("unknown");
      expect(limits).toEqual({ hourly: 5, daily: 20, monthly: 100 });
    });

    it("should return 'none' limits explicitly", () => {
      const limits = helper.getRateLimits("none");
      expect(limits).toEqual({ hourly: 5, daily: 20, monthly: 100 });
    });

    it("should return limits with undefined (unlimited) values", () => {
      const limits = helper.getRateLimits("pro");
      expect(limits).toEqual({
        hourly: 100,
        daily: undefined,
        monthly: undefined,
      });
    });
  });

  describe("getRateLimits with multiple entitlements (upper bound)", () => {
    const helper = new EntitlementHelper(testConfig);

    it("should return 'none' limits for empty array", () => {
      const limits = helper.getRateLimits([]);
      expect(limits).toEqual({ hourly: 5, daily: 20, monthly: 100 });
    });

    it("should take maximum of defined values", () => {
      const limits = helper.getRateLimits(["none", "starter"]);
      expect(limits).toEqual({ hourly: 10, daily: 50, monthly: 500 });
    });

    it("should prefer undefined (unlimited) over any number", () => {
      const limits = helper.getRateLimits(["starter", "pro"]);
      expect(limits).toEqual({
        hourly: 100, // max(10, 100)
        daily: undefined, // undefined beats 50
        monthly: undefined, // undefined beats 500
      });
    });

    it("should return all unlimited for enterprise", () => {
      const limits = helper.getRateLimits(["none", "enterprise"]);
      expect(limits).toEqual({
        hourly: undefined,
        daily: undefined,
        monthly: undefined,
      });
    });

    it("should handle three entitlements correctly", () => {
      const limits = helper.getRateLimits(["none", "starter", "pro"]);
      expect(limits).toEqual({
        hourly: 100, // max(5, 10, 100)
        daily: undefined, // undefined from pro beats others
        monthly: undefined, // undefined from pro beats others
      });
    });

    it("should handle mixed known and unknown entitlements", () => {
      const limits = helper.getRateLimits(["unknown1", "starter", "unknown2"]);
      // unknown falls back to "none" limits
      expect(limits).toEqual({
        hourly: 10, // max(5, 10, 5)
        daily: 50, // max(20, 50, 20)
        monthly: 500, // max(100, 500, 100)
      });
    });
  });
});
