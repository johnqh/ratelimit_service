import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgTable, TableConfig } from "drizzle-orm/pg-core";
import {
  NONE_ENTITLEMENT,
  type RateLimitsConfigData,
  type RateLimitTier,
  type RateLimits as ApiRateLimits,
  type RateLimitUsage,
  type RateLimitResets,
  type RateLimitHistoryData,
  type RateLimitHistoryEntry,
  type RateLimitPeriodType,
} from "@sudobility/types";
import { RevenueCatHelper } from "./RevenueCatHelper";
import { EntitlementHelper } from "./EntitlementHelper";
import { RateLimitChecker } from "./RateLimitChecker";
import {
  PeriodType,
  type RateLimitsConfig,
  type RateLimits as InternalRateLimits,
} from "../types";
import {
  getNextHourStart,
  getNextDayStart,
  getNextSubscriptionMonthStart,
} from "../utils/time";

/**
 * Configuration for RateLimitRouteHandler.
 */
export interface RateLimitRouteHandlerConfig {
  /** RevenueCat API key */
  revenueCatApiKey: string;
  /** Rate limits configuration */
  rateLimitsConfig: RateLimitsConfig;
  /** Drizzle database instance */
  db: PostgresJsDatabase<any>;
  /** The rate_limit_counters table from your schema */
  rateLimitsTable: PgTable<TableConfig>;
  /** Display name mapping for entitlements (optional) */
  entitlementDisplayNames?: Record<string, string>;
}

/**
 * Default display names for common entitlements.
 */
const DEFAULT_DISPLAY_NAMES: Record<string, string> = {
  none: "Free",
  starter: "Starter",
  pro: "Pro",
  enterprise: "Enterprise",
};

/**
 * Helper for rate limit API endpoints.
 *
 * Provides structured data for rate limit status and history endpoints.
 * Combines RevenueCat subscription info, entitlement-based limit resolution,
 * and database counter data into API-ready response formats.
 *
 * Used by consuming APIs to implement:
 * - `GET /ratelimits` - Current limits, usage, and tier info
 * - `GET /ratelimits/history/:periodType` - Historical usage data
 *
 * @example
 * ```typescript
 * const handler = new RateLimitRouteHandler({
 *   revenueCatApiKey: process.env.REVENUECAT_API_KEY!,
 *   rateLimitsConfig: config,
 *   db,
 *   rateLimitsTable: rateLimitCounters,
 * });
 *
 * // In a Hono route:
 * app.get("/ratelimits", async (c) => {
 *   const data = await handler.getRateLimitsConfigData(userId);
 *   return c.json({ success: true, data });
 * });
 * ```
 */
export class RateLimitRouteHandler {
  private readonly rcHelper: RevenueCatHelper;
  private readonly entitlementHelper: EntitlementHelper;
  private readonly rateLimitChecker: RateLimitChecker;
  private readonly rateLimitsConfig: RateLimitsConfig;
  private readonly displayNames: Record<string, string>;

  /**
   * Create a new RateLimitRouteHandler.
   *
   * @param config - Configuration including RevenueCat API key, rate limits config,
   *   database instance, table reference, and optional display name mappings.
   */
  constructor(config: RateLimitRouteHandlerConfig) {
    this.rcHelper = new RevenueCatHelper({ apiKey: config.revenueCatApiKey });
    this.entitlementHelper = new EntitlementHelper(config.rateLimitsConfig);
    this.rateLimitChecker = new RateLimitChecker({
      db: config.db,
      table: config.rateLimitsTable,
    });
    this.rateLimitsConfig = config.rateLimitsConfig;
    this.displayNames = {
      ...DEFAULT_DISPLAY_NAMES,
      ...config.entitlementDisplayNames,
    };
  }

  /**
   * Get rate limits configuration data for /ratelimits endpoint.
   *
   * @param userId - The user's ID (e.g., Firebase UID)
   * @param testMode - If true, accept sandbox purchases. If false (production), reject sandbox purchases. Defaults to false.
   * @returns RateLimitsConfigData for API response
   */
  async getRateLimitsConfigData(
    userId: string,
    testMode: boolean = false
  ): Promise<RateLimitsConfigData> {
    // Get all tiers from config
    const tiers: RateLimitTier[] = Object.entries(this.rateLimitsConfig).map(
      ([entitlement, limits]) => ({
        entitlement,
        displayName: this.getDisplayName(entitlement),
        limits: this.convertLimits(limits),
      })
    );

    // Get user's subscription info from RevenueCat
    let entitlements: string[];
    let subscriptionStartedAt: Date | null = null;
    try {
      const subscriptionInfo = await this.rcHelper.getSubscriptionInfo(
        userId,
        testMode
      );
      entitlements = subscriptionInfo.entitlements;
      subscriptionStartedAt = subscriptionInfo.subscriptionStartedAt;
    } catch (error) {
      console.error("RevenueCat error, using 'none' entitlement:", error);
      entitlements = [NONE_ENTITLEMENT];
    }

    // Get the primary entitlement (first one that has limits configured)
    const currentEntitlement = this.getPrimaryEntitlement(entitlements);

    // Get rate limits for user's entitlements
    const internalLimits = this.entitlementHelper.getRateLimits(entitlements);
    const currentLimits = this.convertLimits(internalLimits);

    // Get current usage
    const checkResult = await this.rateLimitChecker.checkOnly(
      userId,
      internalLimits,
      subscriptionStartedAt
    );

    const currentUsage: RateLimitUsage = {
      hourly:
        internalLimits.hourly !== undefined
          ? internalLimits.hourly - (checkResult.remaining.hourly ?? 0)
          : 0,
      daily:
        internalLimits.daily !== undefined
          ? internalLimits.daily - (checkResult.remaining.daily ?? 0)
          : 0,
      monthly:
        internalLimits.monthly !== undefined
          ? internalLimits.monthly - (checkResult.remaining.monthly ?? 0)
          : 0,
    };

    // Calculate reset times
    const now = new Date();
    const resets: RateLimitResets = {
      hourly: getNextHourStart(now).toISOString(),
      daily: getNextDayStart(now).toISOString(),
      monthly: getNextSubscriptionMonthStart(subscriptionStartedAt, now).toISOString(),
    };

    return {
      tiers,
      currentEntitlement,
      currentLimits,
      currentUsage,
      resets,
    };
  }

  /**
   * Get rate limit history data for /ratelimits/history/{periodType} endpoint.
   *
   * @param userId - The user's ID (e.g., Firebase UID)
   * @param periodType - The period type (hour, day, month)
   * @param limit - Maximum number of entries to return (default: 100)
   * @param testMode - If true, accept sandbox purchases. If false (production), reject sandbox purchases. Defaults to false.
   * @returns RateLimitHistoryData for API response
   */
  async getRateLimitHistoryData(
    userId: string,
    periodType: RateLimitPeriodType,
    limit: number = 100,
    testMode: boolean = false
  ): Promise<RateLimitHistoryData> {
    // Convert API period type to internal period type
    const internalPeriodType = this.convertPeriodType(periodType);

    // Get user's subscription info for subscription month calculation
    let subscriptionStartedAt: Date | null = null;
    let entitlements: string[] = [NONE_ENTITLEMENT];
    try {
      const subscriptionInfo = await this.rcHelper.getSubscriptionInfo(
        userId,
        testMode
      );
      subscriptionStartedAt = subscriptionInfo.subscriptionStartedAt;
      entitlements = subscriptionInfo.entitlements;
    } catch (error) {
      console.error("RevenueCat error:", error);
    }

    // Get the limit for this period type
    const internalLimits = this.entitlementHelper.getRateLimits(entitlements);
    const periodLimit = this.getLimitForPeriod(internalLimits, periodType);

    // Get history from database
    const history = await this.rateLimitChecker.getHistory(
      userId,
      internalPeriodType,
      subscriptionStartedAt,
      limit
    );

    // Convert to API format
    const entries: RateLimitHistoryEntry[] = history.entries.map(entry => ({
      periodStart: entry.period_start.toISOString(),
      periodEnd: entry.period_end.toISOString(),
      requestCount: entry.request_count,
      limit: periodLimit,
    }));

    return {
      periodType,
      entries,
      totalEntries: entries.length,
    };
  }

  /**
   * Get display name for an entitlement.
   *
   * Checks custom display names first, then defaults, then falls back
   * to capitalizing the first letter of the entitlement name.
   *
   * @param entitlement - The entitlement identifier
   * @returns Human-readable display name for the entitlement
   */
  private getDisplayName(entitlement: string): string {
    if (this.displayNames[entitlement]) {
      return this.displayNames[entitlement];
    }
    // Capitalize first letter as fallback
    return entitlement.charAt(0).toUpperCase() + entitlement.slice(1);
  }

  /**
   * Get the primary entitlement from a list.
   * Returns the first entitlement that has configured limits, or "none".
   *
   * @param entitlements - Array of entitlement names from RevenueCat
   * @returns The first non-"none" entitlement with configured limits, or "none"
   */
  private getPrimaryEntitlement(entitlements: string[]): string {
    for (const entitlement of entitlements) {
      if (
        entitlement !== NONE_ENTITLEMENT &&
        this.rateLimitsConfig[entitlement]
      ) {
        return entitlement;
      }
    }
    return NONE_ENTITLEMENT;
  }

  /**
   * Convert internal RateLimits to API RateLimits.
   * Internal uses `undefined` for unlimited, API uses `null`.
   *
   * @param limits - Internal rate limits with undefined for unlimited
   * @returns API rate limits with null for unlimited
   */
  private convertLimits(limits: InternalRateLimits): ApiRateLimits {
    return {
      hourly: limits.hourly ?? null,
      daily: limits.daily ?? null,
      monthly: limits.monthly ?? null,
    };
  }

  /**
   * Convert API period type to internal period type.
   *
   * @param periodType - API period type string ("hour", "day", "month")
   * @returns Internal PeriodType enum value
   * @throws Error if an invalid period type is provided
   */
  private convertPeriodType(periodType: RateLimitPeriodType): PeriodType {
    switch (periodType) {
      case "hour":
        return PeriodType.HOURLY;
      case "day":
        return PeriodType.DAILY;
      case "month":
        return PeriodType.MONTHLY;
      default:
        throw new Error(`Invalid period type: ${periodType}`);
    }
  }

  /**
   * Get the limit for a specific period type.
   *
   * @param limits - Internal rate limits
   * @param periodType - API period type string ("hour", "day", "month")
   * @returns The limit number for the period, or null if unlimited
   */
  private getLimitForPeriod(
    limits: InternalRateLimits,
    periodType: RateLimitPeriodType
  ): number | null {
    switch (periodType) {
      case "hour":
        return limits.hourly ?? null;
      case "day":
        return limits.daily ?? null;
      case "month":
        return limits.monthly ?? null;
      default:
        return null;
    }
  }
}
