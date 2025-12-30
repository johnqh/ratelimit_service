import type { RateLimits, RateLimitsConfig } from "../types/rate-limits";
import { NONE_ENTITLEMENT } from "../types/entitlements";

/**
 * Helper class for resolving rate limits from entitlements.
 *
 * @example
 * ```typescript
 * const config: RateLimitsConfig = {
 *   none: { hourly: 2, daily: 5, monthly: 20 },
 *   starter: { hourly: 10, daily: 50, monthly: 500 },
 *   pro: { hourly: 100, daily: undefined, monthly: undefined },
 * };
 *
 * const helper = new EntitlementHelper(config);
 *
 * // Single entitlement
 * helper.getRateLimits("pro");
 * // Returns: { hourly: 100, daily: undefined, monthly: undefined }
 *
 * // Multiple entitlements - returns upper bound
 * helper.getRateLimits(["starter", "pro"]);
 * // Returns: { hourly: 100, daily: undefined, monthly: undefined }
 * ```
 */
export class EntitlementHelper {
  constructor(private readonly config: RateLimitsConfig) {}

  /**
   * Get rate limits for a single entitlement.
   * Falls back to "none" limits if entitlement not found in config.
   */
  getRateLimits(entitlement: string): RateLimits;

  /**
   * Get rate limits for multiple entitlements.
   * Returns the upper bound (most permissive) of all entitlements.
   * undefined (unlimited) always wins over any number.
   */
  getRateLimits(entitlements: string[]): RateLimits;

  getRateLimits(entitlementOrArray: string | string[]): RateLimits {
    const entitlements = Array.isArray(entitlementOrArray)
      ? entitlementOrArray
      : [entitlementOrArray];

    if (entitlements.length === 0) {
      return this.config[NONE_ENTITLEMENT];
    }

    if (entitlements.length === 1) {
      const ent = entitlements[0]!;
      return this.config[ent] ?? this.config[NONE_ENTITLEMENT];
    }

    // Multiple entitlements - compute upper bound
    return this.computeUpperBound(entitlements);
  }

  /**
   * Compute the upper bound (most permissive) rate limits from multiple entitlements.
   *
   * Rules:
   * - undefined (unlimited) beats any number
   * - Higher numbers beat lower numbers
   */
  private computeUpperBound(entitlements: string[]): RateLimits {
    const limits = entitlements.map(
      ent => this.config[ent] ?? this.config[NONE_ENTITLEMENT]
    );

    return {
      hourly: this.maxLimit(limits.map(l => l.hourly)),
      daily: this.maxLimit(limits.map(l => l.daily)),
      monthly: this.maxLimit(limits.map(l => l.monthly)),
    };
  }

  /**
   * Get the maximum (most permissive) limit from an array.
   * undefined (unlimited) always wins.
   */
  private maxLimit(values: (number | undefined)[]): number | undefined {
    // If any value is undefined, result is unlimited
    if (values.some(v => v === undefined)) {
      return undefined;
    }

    // All values are defined, return the maximum
    const definedValues = values as number[];
    return Math.max(...definedValues);
  }
}
