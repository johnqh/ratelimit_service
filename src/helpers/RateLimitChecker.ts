import { eq, and, desc } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgTable, TableConfig } from "drizzle-orm/pg-core";
import {
  PeriodType,
  type RateLimits,
  type RateLimitCheckResult,
  type RateLimitRemaining,
  type RateLimitCounterRow,
  type UsageHistory,
  type UsageHistoryEntry,
} from "../types";
import {
  getCurrentHourStart,
  getNextHourStart,
  getCurrentDayStart,
  getNextDayStart,
  getSubscriptionMonthStart,
  getNextSubscriptionMonthStart,
} from "../utils/time";

/**
 * Configuration for RateLimitChecker.
 */
export interface RateLimitCheckerConfig {
  /** Drizzle database instance */
  db: PostgresJsDatabase<any>;
  /** The rate_limit_counters table from your schema */
  table: PgTable<TableConfig>;
}

/**
 * Checks and updates rate limits for a user.
 * Uses period-based counters with history preservation.
 *
 * @example
 * ```typescript
 * import { db, rateLimitCounters } from "./db";
 *
 * const checker = new RateLimitChecker({ db, table: rateLimitCounters });
 *
 * const result = await checker.checkAndIncrement(
 *   userId,
 *   { hourly: 10, daily: 100, monthly: undefined },
 *   subscriptionStartedAt  // from RevenueCat
 * );
 *
 * if (!result.allowed) {
 *   return c.json({ error: "Rate limit exceeded" }, 429);
 * }
 * ```
 */
export class RateLimitChecker {
  private readonly db: PostgresJsDatabase<any>;
  private readonly table: PgTable<TableConfig>;

  /**
   * Create a new RateLimitChecker.
   *
   * @param config - Configuration containing the Drizzle database instance and table reference
   */
  constructor(config: RateLimitCheckerConfig) {
    this.db = config.db;
    this.table = config.table;
  }

  /**
   * Check if request is within rate limits and increment counters.
   *
   * Checks hourly, daily, and monthly limits in order. If all checks pass,
   * increments the corresponding counters in the database. If any limit is
   * exceeded, returns immediately without incrementing.
   *
   * @param userId - The user's ID (e.g., Firebase UID)
   * @param limits - The rate limits to apply. Use `undefined` for unlimited periods.
   * @param subscriptionStartedAt - When the subscription started (for monthly period calculation).
   *   If null, monthly periods fall back to calendar months (1st of each month).
   * @returns Result indicating if request is allowed, remaining limits, and which limit was exceeded (if any)
   * @throws Will propagate database errors if the underlying Drizzle queries fail
   */
  async checkAndIncrement(
    userId: string,
    limits: RateLimits,
    subscriptionStartedAt: Date | null = null
  ): Promise<RateLimitCheckResult> {
    const now = new Date();

    // Get current counts for each period type
    const counts = await this.getCurrentCounts(
      userId,
      subscriptionStartedAt,
      now
    );

    // Check limits before incrementing
    const checkResult = this.checkLimits(counts, limits);

    if (!checkResult.allowed) {
      return checkResult;
    }

    // Increment counters for enabled limit types
    await this.incrementCounters(userId, limits, subscriptionStartedAt, now);

    // Calculate remaining after increment
    const remaining = this.calculateRemaining(
      {
        hourly: counts.hourly + (limits.hourly !== undefined ? 1 : 0),
        daily: counts.daily + (limits.daily !== undefined ? 1 : 0),
        monthly: counts.monthly + (limits.monthly !== undefined ? 1 : 0),
      },
      limits
    );

    return {
      allowed: true,
      statusCode: 200,
      remaining,
      limits,
    };
  }

  /**
   * Get current usage without incrementing (for status queries).
   *
   * Unlike {@link checkAndIncrement}, this method only reads the current counters
   * and does not modify any database state. Useful for displaying usage dashboards
   * or status endpoints.
   *
   * @param userId - The user's ID (e.g., Firebase UID)
   * @param limits - The rate limits to check against. Use `undefined` for unlimited periods.
   * @param subscriptionStartedAt - When the subscription started (for monthly period calculation).
   *   If null, monthly periods fall back to calendar months.
   * @returns Result indicating if request would be allowed and remaining limits
   * @throws Will propagate database errors if the underlying Drizzle queries fail
   */
  async checkOnly(
    userId: string,
    limits: RateLimits,
    subscriptionStartedAt: Date | null = null
  ): Promise<RateLimitCheckResult> {
    const now = new Date();
    const counts = await this.getCurrentCounts(
      userId,
      subscriptionStartedAt,
      now
    );
    const checkResult = this.checkLimits(counts, limits);
    const remaining = this.calculateRemaining(counts, limits);

    return {
      ...checkResult,
      remaining,
      limits,
    };
  }

  /**
   * Get usage history for a user.
   *
   * @param userId - The user's ID
   * @param periodType - The period type to get history for
   * @param subscriptionStartedAt - When the subscription started (for calculating period_end)
   * @param limit - Maximum number of entries to return (default: 100)
   * @returns Usage history with period start/end and counts
   */
  async getHistory(
    userId: string,
    periodType: PeriodType,
    subscriptionStartedAt: Date | null = null,
    limit: number = 100
  ): Promise<UsageHistory> {
    const tableAny = this.table as any;

    const rows = await this.db
      .select()
      .from(this.table)
      .where(
        and(eq(tableAny.user_id, userId), eq(tableAny.period_type, periodType))
      )
      .orderBy(desc(tableAny.period_start))
      .limit(limit);

    const entries: UsageHistoryEntry[] = rows.map(row => {
      const counter = row as unknown as RateLimitCounterRow;
      return {
        period_start: counter.period_start,
        period_end: this.getPeriodEnd(
          periodType,
          counter.period_start,
          subscriptionStartedAt
        ),
        request_count: counter.request_count,
      };
    });

    return {
      user_id: userId,
      period_type: periodType,
      entries,
    };
  }

  /**
   * Get current counts for each period type.
   *
   * Runs three parallel queries to fetch the current counter values for
   * hourly, daily, and monthly periods.
   *
   * @param userId - The user's ID
   * @param subscriptionStartedAt - Subscription start date for monthly period calculation
   * @param now - Current timestamp used for period boundary calculation
   * @returns Object with hourly, daily, and monthly count values (0 if no counter exists)
   */
  private async getCurrentCounts(
    userId: string,
    subscriptionStartedAt: Date | null,
    now: Date
  ): Promise<{ hourly: number; daily: number; monthly: number }> {
    const [hourlyCount, dailyCount, monthlyCount] = await Promise.all([
      this.getCountForPeriod(
        userId,
        PeriodType.HOURLY,
        getCurrentHourStart(now)
      ),
      this.getCountForPeriod(userId, PeriodType.DAILY, getCurrentDayStart(now)),
      this.getCountForPeriod(
        userId,
        PeriodType.MONTHLY,
        getSubscriptionMonthStart(subscriptionStartedAt, now)
      ),
    ]);

    return {
      hourly: hourlyCount,
      daily: dailyCount,
      monthly: monthlyCount,
    };
  }

  /**
   * Get the counter value for a specific period.
   *
   * @param userId - The user's ID
   * @param periodType - The rate limit period type (hourly, daily, monthly)
   * @param periodStart - The start timestamp of the current period window
   * @returns The current request count, or 0 if no counter exists for this period
   */
  private async getCountForPeriod(
    userId: string,
    periodType: PeriodType,
    periodStart: Date
  ): Promise<number> {
    const tableAny = this.table as any;

    const rows = await this.db
      .select()
      .from(this.table)
      .where(
        and(
          eq(tableAny.user_id, userId),
          eq(tableAny.period_type, periodType),
          eq(tableAny.period_start, periodStart)
        )
      )
      .limit(1);

    if (rows.length === 0) {
      return 0;
    }

    const counter = rows[0] as unknown as RateLimitCounterRow;
    return counter.request_count;
  }

  /**
   * Increment counters for enabled limit types.
   *
   * Only increments counters for periods that have defined (non-undefined) limits.
   * Runs all increments in parallel for performance.
   *
   * @param userId - The user's ID
   * @param limits - Rate limits configuration; only periods with defined limits are incremented
   * @param subscriptionStartedAt - Subscription start date for monthly period calculation
   * @param now - Current timestamp used for period boundary calculation
   */
  private async incrementCounters(
    userId: string,
    limits: RateLimits,
    subscriptionStartedAt: Date | null,
    now: Date
  ): Promise<void> {
    const updates: Promise<void>[] = [];

    if (limits.hourly !== undefined) {
      updates.push(
        this.incrementPeriodCounter(
          userId,
          PeriodType.HOURLY,
          getCurrentHourStart(now),
          now
        )
      );
    }

    if (limits.daily !== undefined) {
      updates.push(
        this.incrementPeriodCounter(
          userId,
          PeriodType.DAILY,
          getCurrentDayStart(now),
          now
        )
      );
    }

    if (limits.monthly !== undefined) {
      updates.push(
        this.incrementPeriodCounter(
          userId,
          PeriodType.MONTHLY,
          getSubscriptionMonthStart(subscriptionStartedAt, now),
          now
        )
      );
    }

    await Promise.all(updates);
  }

  /**
   * Increment a specific period counter (upsert).
   *
   * If a counter row already exists for the given user/period/start combination,
   * increments its request_count by 1. Otherwise, inserts a new row with
   * request_count of 1.
   *
   * @param userId - The user's ID
   * @param periodType - The rate limit period type
   * @param periodStart - The start timestamp of the current period window
   * @param now - Current timestamp used for the updated_at field
   */
  private async incrementPeriodCounter(
    userId: string,
    periodType: PeriodType,
    periodStart: Date,
    now: Date
  ): Promise<void> {
    const tableAny = this.table as any;

    // Try to find existing counter
    const existing = await this.db
      .select()
      .from(this.table)
      .where(
        and(
          eq(tableAny.user_id, userId),
          eq(tableAny.period_type, periodType),
          eq(tableAny.period_start, periodStart)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      // Update existing counter
      const counter = existing[0] as unknown as RateLimitCounterRow;
      await this.db
        .update(this.table)
        .set({
          request_count: counter.request_count + 1,
          updated_at: now,
        })
        .where(eq(tableAny.id, counter.id));
    } else {
      // Insert new counter
      await this.db.insert(this.table).values({
        user_id: userId,
        period_type: periodType,
        period_start: periodStart,
        request_count: 1,
        created_at: now,
        updated_at: now,
      });
    }
  }

  /**
   * Check limits and return result.
   *
   * Checks hourly, daily, and monthly limits in order. Returns the first
   * exceeded limit encountered, or an allowed result if all checks pass.
   *
   * @param counts - Current usage counts for each period
   * @param limits - Rate limits to check against. Periods with `undefined` are skipped (unlimited).
   * @returns Check result with allowed status, remaining counts, and exceeded limit info
   */
  private checkLimits(
    counts: { hourly: number; daily: number; monthly: number },
    limits: RateLimits
  ): RateLimitCheckResult {
    const remaining = this.calculateRemaining(counts, limits);

    // Check hourly limit
    if (limits.hourly !== undefined && counts.hourly >= limits.hourly) {
      return {
        allowed: false,
        statusCode: 429,
        remaining,
        exceededLimit: "hourly",
        limits,
      };
    }

    // Check daily limit
    if (limits.daily !== undefined && counts.daily >= limits.daily) {
      return {
        allowed: false,
        statusCode: 429,
        remaining,
        exceededLimit: "daily",
        limits,
      };
    }

    // Check monthly limit
    if (limits.monthly !== undefined && counts.monthly >= limits.monthly) {
      return {
        allowed: false,
        statusCode: 429,
        remaining,
        exceededLimit: "monthly",
        limits,
      };
    }

    return {
      allowed: true,
      statusCode: 200,
      remaining,
      limits,
    };
  }

  /**
   * Calculate remaining requests for each period.
   *
   * For defined limits, returns `max(0, limit - count)` to avoid negative values.
   * For undefined (unlimited) limits, returns `undefined`.
   *
   * @param counts - Current usage counts for each period
   * @param limits - Rate limits to calculate remaining against
   * @returns Remaining request counts for each period
   */
  private calculateRemaining(
    counts: { hourly: number; daily: number; monthly: number },
    limits: RateLimits
  ): RateLimitRemaining {
    return {
      hourly:
        limits.hourly !== undefined
          ? Math.max(0, limits.hourly - counts.hourly)
          : undefined,
      daily:
        limits.daily !== undefined
          ? Math.max(0, limits.daily - counts.daily)
          : undefined,
      monthly:
        limits.monthly !== undefined
          ? Math.max(0, limits.monthly - counts.monthly)
          : undefined,
    };
  }

  /**
   * Get the end of a period for history entries.
   *
   * Calculates the exclusive end timestamp for a given period, based on the
   * period type and start date. For monthly periods, uses subscription start
   * date for accurate billing cycle boundaries.
   *
   * @param periodType - The rate limit period type
   * @param periodStart - The start timestamp of the period
   * @param subscriptionStartedAt - Subscription start date for monthly period end calculation
   * @returns The exclusive end timestamp of the period
   */
  private getPeriodEnd(
    periodType: PeriodType,
    periodStart: Date,
    subscriptionStartedAt: Date | null
  ): Date {
    switch (periodType) {
      case PeriodType.HOURLY:
        return getNextHourStart(periodStart);
      case PeriodType.DAILY:
        return getNextDayStart(periodStart);
      case PeriodType.MONTHLY:
        return getNextSubscriptionMonthStart(
          subscriptionStartedAt,
          periodStart
        );
    }
  }
}
