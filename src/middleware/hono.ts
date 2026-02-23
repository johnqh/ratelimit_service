import type { Context, Next } from "hono";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgTable, TableConfig } from "drizzle-orm/pg-core";
import { RevenueCatHelper } from "../helpers/RevenueCatHelper";
import { EntitlementHelper } from "../helpers/EntitlementHelper";
import { RateLimitChecker } from "../helpers/RateLimitChecker";
import { NONE_ENTITLEMENT } from "@sudobility/types";
import type { RateLimitsConfig } from "../types";

/**
 * Configuration for the rate limit middleware factory.
 */
export interface RateLimitMiddlewareConfig {
  /** RevenueCat API key */
  revenueCatApiKey: string;
  /** Rate limits configuration */
  rateLimitsConfig: RateLimitsConfig;
  /** Drizzle database instance */
  db: PostgresJsDatabase<any>;
  /** The rate_limit_counters table from your schema */
  rateLimitsTable: PgTable<TableConfig>;
  /** Function to extract user ID from context */
  getUserId: (c: Context) => string | Promise<string>;
  /** Optional: Skip rate limiting for certain conditions (e.g., admin tokens) */
  shouldSkip?: (c: Context) => boolean | Promise<boolean>;
  /** Optional: Function to get testMode from context. If true, sandbox purchases are accepted. Defaults to false. */
  getTestMode?: (c: Context) => boolean | Promise<boolean>;
}

/**
 * Create a Hono middleware for rate limiting based on RevenueCat entitlements.
 *
 * This middleware:
 * 1. Optionally skips rate limiting via the `shouldSkip` callback
 * 2. Extracts the user ID via the `getUserId` callback
 * 3. Fetches user's subscription info from RevenueCat (falls back to "none" on error)
 * 4. Resolves rate limits based on entitlements using the most permissive limits
 * 5. Checks and increments counters in the database
 * 6. Sets `X-RateLimit-Hourly-Remaining`, `X-RateLimit-Daily-Remaining`,
 *    and `X-RateLimit-Monthly-Remaining` response headers
 * 7. Returns 429 JSON response if rate limit exceeded, otherwise calls `next()`
 *
 * @param config - Middleware configuration options
 * @param config.revenueCatApiKey - RevenueCat secret API key for server-side use
 * @param config.rateLimitsConfig - Mapping of entitlement names to rate limits (must include "none")
 * @param config.db - Drizzle PostgresJs database instance
 * @param config.rateLimitsTable - The rate_limit_counters Drizzle table reference
 * @param config.getUserId - Function to extract user ID from Hono context (sync or async)
 * @param config.shouldSkip - Optional function to skip rate limiting (e.g., for admin tokens)
 * @param config.getTestMode - Optional function to determine if sandbox purchases should be accepted
 * @returns A Hono middleware function `(c: Context, next: Next) => Promise<Response | void>`
 *
 * @example
 * ```typescript
 * import { createRateLimitMiddleware } from "@sudobility/ratelimit_service/middleware/hono";
 * import { db, rateLimitCounters } from "./db";
 *
 * const rateLimitMiddleware = createRateLimitMiddleware({
 *   revenueCatApiKey: process.env.REVENUECAT_API_KEY!,
 *   rateLimitsConfig: {
 *     none: { hourly: 5, daily: 20, monthly: 100 },
 *     pro: { hourly: undefined, daily: undefined, monthly: undefined },
 *   },
 *   db,
 *   rateLimitsTable: rateLimitCounters,
 *   getUserId: (c) => c.get("firebaseUser").uid,
 * });
 *
 * app.use("/api/*", rateLimitMiddleware);
 * ```
 */
export function createRateLimitMiddleware(config: RateLimitMiddlewareConfig) {
  const rcHelper = new RevenueCatHelper({ apiKey: config.revenueCatApiKey });
  const entitlementHelper = new EntitlementHelper(config.rateLimitsConfig);
  const rateLimitChecker = new RateLimitChecker({
    db: config.db,
    table: config.rateLimitsTable,
  });

  return async (c: Context, next: Next) => {
    // Check if rate limiting should be skipped
    if (config.shouldSkip) {
      const skip = await config.shouldSkip(c);
      if (skip) {
        await next();
        return;
      }
    }

    // Get user ID
    const userId = await config.getUserId(c);

    // Get testMode (defaults to false - production mode)
    const testMode = config.getTestMode
      ? await config.getTestMode(c)
      : false;

    // Get user's subscription info from RevenueCat
    let entitlements: string[];
    let subscriptionStartedAt: Date | null = null;
    try {
      const subscriptionInfo = await rcHelper.getSubscriptionInfo(
        userId,
        testMode
      );
      entitlements = subscriptionInfo.entitlements;
      subscriptionStartedAt = subscriptionInfo.subscriptionStartedAt;
    } catch (error) {
      console.error("RevenueCat error, using 'none' entitlement:", error);
      entitlements = [NONE_ENTITLEMENT];
    }

    // Get rate limits for user's entitlements
    const limits = entitlementHelper.getRateLimits(entitlements);

    // Check and increment rate limits
    const result = await rateLimitChecker.checkAndIncrement(
      userId,
      limits,
      subscriptionStartedAt
    );

    // Set rate limit headers
    if (result.remaining.hourly !== undefined) {
      c.header(
        "X-RateLimit-Hourly-Remaining",
        result.remaining.hourly.toString()
      );
    }
    if (result.remaining.daily !== undefined) {
      c.header(
        "X-RateLimit-Daily-Remaining",
        result.remaining.daily.toString()
      );
    }
    if (result.remaining.monthly !== undefined) {
      c.header(
        "X-RateLimit-Monthly-Remaining",
        result.remaining.monthly.toString()
      );
    }

    if (!result.allowed) {
      return c.json(
        {
          success: false,
          error: "Rate limit exceeded",
          message: `You have exceeded your ${result.exceededLimit} request limit. Please try again later or upgrade your subscription.`,
          remaining: result.remaining,
          exceededLimit: result.exceededLimit,
          timestamp: new Date().toISOString(),
        },
        429
      );
    }

    await next();
  };
}
