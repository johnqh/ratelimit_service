import type { RateLimits } from "./rate-limits";

/**
 * Remaining rate limit information for each time period.
 * undefined means unlimited for that period.
 */
export interface RateLimitRemaining {
  /** Remaining requests this hour. undefined if unlimited */
  hourly?: number;
  /** Remaining requests this day. undefined if unlimited */
  daily?: number;
  /** Remaining requests this month. undefined if unlimited */
  monthly?: number;
}

/**
 * Which rate limit period was exceeded.
 */
export type ExceededLimit = "hourly" | "daily" | "monthly";

/**
 * Result from checking rate limits.
 */
export interface RateLimitCheckResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** HTTP status code: 200 if allowed, 429 if rate limited */
  statusCode: 200 | 429;
  /** Remaining requests for each time period */
  remaining: RateLimitRemaining;
  /** Which limit was exceeded (only set if allowed is false) */
  exceededLimit?: ExceededLimit;
  /** Current limits applied to this user */
  limits: RateLimits;
}

/**
 * Database row type for rate limit counter.
 * This matches the new schema with history tracking.
 */
export interface RateLimitCounterRow {
  id: string;
  user_id: string;
  period_type: string;
  period_start: Date;
  request_count: number;
  created_at: Date | null;
  updated_at: Date | null;
}

/**
 * Valid period types for rate limiting.
 */
export enum PeriodType {
  HOURLY = "hourly",
  DAILY = "daily",
  MONTHLY = "monthly",
}

/**
 * A single history entry for a time period.
 */
export interface UsageHistoryEntry {
  /** Start of the time period */
  period_start: Date;
  /** End of the time period (exclusive) */
  period_end: Date;
  /** Number of requests in this period */
  request_count: number;
}

/**
 * Usage history for a user and period type.
 */
export interface UsageHistory {
  /** User identifier */
  user_id: string;
  /** Type of period: 'hourly', 'daily', or 'monthly' */
  period_type: PeriodType;
  /** Historical entries, sorted by period_start descending (most recent first) */
  entries: UsageHistoryEntry[];
}

/**
 * Subscription information from RevenueCat.
 */
export interface SubscriptionInfo {
  /** Active entitlement names */
  entitlements: string[];
  /** Subscription start date (earliest active entitlement's purchase_date) */
  subscriptionStartedAt: Date | null;
}
