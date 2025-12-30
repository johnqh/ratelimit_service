/**
 * Rate limits for a single time period.
 * undefined means unlimited for that period.
 */
export interface RateLimits {
  /** Requests allowed per hour. undefined = unlimited */
  hourly?: number;
  /** Requests allowed per day. undefined = unlimited */
  daily?: number;
  /** Requests allowed per month. undefined = unlimited */
  monthly?: number;
}

/**
 * Configuration mapping entitlement names to their rate limits.
 * The key "none" is required and applies to users without any subscription.
 *
 * @example
 * ```typescript
 * const config: RateLimitsConfig = {
 *   none: { hourly: 2, daily: 5, monthly: 20 },
 *   starter: { hourly: 10, daily: 50, monthly: 500 },
 *   pro: { hourly: 100, daily: undefined, monthly: undefined },
 *   enterprise: { hourly: undefined, daily: undefined, monthly: undefined },
 * };
 * ```
 */
export type RateLimitsConfig = {
  /** Rate limits for users without any entitlement (required) */
  none: RateLimits;
} & {
  /** Rate limits for each entitlement name */
  [entitlement: string]: RateLimits;
};
