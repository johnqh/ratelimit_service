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

  constructor(config: RateLimitCheckerConfig) {
    this.db = config.db;
    this.table = config.table;
  }

  /**
   * Check if request is within rate limits and increment counters.
   *
   * @param userId - The user's ID
   * @param limits - The rate limits to apply
   * @param subscriptionStartedAt - When the subscription started (for monthly calculation)
   * @returns Result indicating if request is allowed and remaining limits
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
