import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgTable, TableConfig } from "drizzle-orm/pg-core";
import type {
  RateLimitsConfigData,
  RateLimitTier,
  RateLimits as ApiRateLimits,
  RateLimitUsage,
  RateLimitHistoryData,
  RateLimitHistoryEntry,
  RateLimitPeriodType,
} from "@sudobility/types";
import { RevenueCatHelper } from "./RevenueCatHelper";
import { EntitlementHelper } from "./EntitlementHelper";
import { RateLimitChecker } from "./RateLimitChecker";
import {
  NONE_ENTITLEMENT,
  PeriodType,
  type RateLimitsConfig,
  type RateLimits as InternalRateLimits,
} from "../types";

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
 * Provides data for /ratelimits and /ratelimits/history endpoints.
 */
export class RateLimitRouteHandler {
  private readonly rcHelper: RevenueCatHelper;
  private readonly entitlementHelper: EntitlementHelper;
  private readonly rateLimitChecker: RateLimitChecker;
  private readonly rateLimitsConfig: RateLimitsConfig;
  private readonly displayNames: Record<string, string>;

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
   * @returns RateLimitsConfigData for API response
   */
  async getRateLimitsConfigData(userId: string): Promise<RateLimitsConfigData> {
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
      const subscriptionInfo = await this.rcHelper.getSubscriptionInfo(userId);
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

    return {
      tiers,
      currentEntitlement,
      currentLimits,
      currentUsage,
    };
  }

  /**
   * Get rate limit history data for /ratelimits/history/{periodType} endpoint.
   *
   * @param userId - The user's ID (e.g., Firebase UID)
   * @param periodType - The period type (hour, day, month)
   * @param limit - Maximum number of entries to return (default: 100)
   * @returns RateLimitHistoryData for API response
   */
  async getRateLimitHistoryData(
    userId: string,
    periodType: RateLimitPeriodType,
    limit: number = 100
  ): Promise<RateLimitHistoryData> {
    // Convert API period type to internal period type
    const internalPeriodType = this.convertPeriodType(periodType);

    // Get user's subscription info for subscription month calculation
    let subscriptionStartedAt: Date | null = null;
    let entitlements: string[] = [NONE_ENTITLEMENT];
    try {
      const subscriptionInfo = await this.rcHelper.getSubscriptionInfo(userId);
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
   * Internal uses undefined for unlimited, API uses null.
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
