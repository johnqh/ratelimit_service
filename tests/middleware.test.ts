import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRateLimitMiddleware } from "../src/middleware/hono";
import type { RateLimitsConfig } from "../src/types/rate-limits";

// Mock fetch globally for RevenueCat API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const testConfig: RateLimitsConfig = {
  none: { hourly: 5, daily: 20, monthly: 100 },
  starter: { hourly: 10, daily: 50, monthly: 500 },
  pro: { hourly: undefined, daily: undefined, monthly: undefined },
};

/**
 * Creates a mock Hono Context object for testing middleware.
 */
function createMockContext(overrides?: {
  userId?: string;
  customData?: Record<string, any>;
}) {
  const headers: Record<string, string> = {};
  let jsonResponse: any = null;
  let jsonStatus: number | undefined;

  const c: any = {
    get: (key: string) => overrides?.customData?.[key],
    set: vi.fn(),
    header: (name: string, value: string) => {
      headers[name] = value;
    },
    json: (body: any, status?: number) => {
      jsonResponse = body;
      jsonStatus = status;
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    },
    // Expose for assertions
    _headers: headers,
    _getJsonResponse: () => jsonResponse,
    _getJsonStatus: () => jsonStatus,
  };

  return c;
}

/**
 * Creates a mock Drizzle database that returns empty results.
 */
function createMockDb() {
  return {
    select: () => ({
      from: (_table: any) => ({
        where: (_pred: any) => ({
          limit: (_n: number) => Promise.resolve([]),
          orderBy: (_desc: any) => ({
            limit: (_n: number) => Promise.resolve([]),
          }),
        }),
      }),
    }),
    update: (_table: any) => ({
      set: (_values: any) => ({
        where: (_pred: any) => Promise.resolve(),
      }),
    }),
    insert: (_table: any) => ({
      values: (_values: any) => Promise.resolve(),
    }),
  } as any;
}

const mockTable = {} as any;

/**
 * Creates a RevenueCat API response for testing.
 */
function createRevenueCatResponse(entitlementName: string) {
  const futureDate = new Date(
    Date.now() + 365 * 24 * 60 * 60 * 1000
  ).toISOString();
  return {
    subscriber: {
      entitlements: {
        [entitlementName]: {
          expires_date: futureDate,
          grace_period_expires_date: null,
          product_identifier: `${entitlementName}_monthly`,
          purchase_date: "2025-01-15T10:00:00Z",
        },
      },
      subscriptions: {
        [`${entitlementName}_monthly`]: {
          expires_date: futureDate,
          purchase_date: "2025-01-15T10:00:00Z",
          sandbox: false,
          store: "app_store",
        },
      },
    },
  };
}

describe("createRateLimitMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should call next() when rate limit is not exceeded", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => createRevenueCatResponse("starter"),
    });

    const middleware = createRateLimitMiddleware({
      revenueCatApiKey: "test-key",
      rateLimitsConfig: testConfig,
      db: createMockDb(),
      rateLimitsTable: mockTable,
      getUserId: () => "user-1",
    });

    const c = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(c, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("should set rate limit headers on successful request", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => createRevenueCatResponse("starter"),
    });

    const middleware = createRateLimitMiddleware({
      revenueCatApiKey: "test-key",
      rateLimitsConfig: testConfig,
      db: createMockDb(),
      rateLimitsTable: mockTable,
      getUserId: () => "user-1",
    });

    const c = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(c, next);

    // Starter has hourly: 10, daily: 50, monthly: 500
    // After one request, remaining should be 9, 49, 499
    expect(c._headers["X-RateLimit-Hourly-Remaining"]).toBe("9");
    expect(c._headers["X-RateLimit-Daily-Remaining"]).toBe("49");
    expect(c._headers["X-RateLimit-Monthly-Remaining"]).toBe("499");
  });

  it("should not set headers for unlimited periods", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => createRevenueCatResponse("pro"),
    });

    const middleware = createRateLimitMiddleware({
      revenueCatApiKey: "test-key",
      rateLimitsConfig: testConfig,
      db: createMockDb(),
      rateLimitsTable: mockTable,
      getUserId: () => "user-1",
    });

    const c = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(c, next);

    // Pro has all unlimited - should not set headers
    expect(c._headers["X-RateLimit-Hourly-Remaining"]).toBeUndefined();
    expect(c._headers["X-RateLimit-Daily-Remaining"]).toBeUndefined();
    expect(c._headers["X-RateLimit-Monthly-Remaining"]).toBeUndefined();
  });

  it("should skip rate limiting when shouldSkip returns true", async () => {
    const middleware = createRateLimitMiddleware({
      revenueCatApiKey: "test-key",
      rateLimitsConfig: testConfig,
      db: createMockDb(),
      rateLimitsTable: mockTable,
      getUserId: () => "user-1",
      shouldSkip: () => true,
    });

    const c = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(c, next);

    expect(next).toHaveBeenCalledOnce();
    // Should not have called RevenueCat
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should not skip when shouldSkip returns false", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => createRevenueCatResponse("starter"),
    });

    const middleware = createRateLimitMiddleware({
      revenueCatApiKey: "test-key",
      rateLimitsConfig: testConfig,
      db: createMockDb(),
      rateLimitsTable: mockTable,
      getUserId: () => "user-1",
      shouldSkip: () => false,
    });

    const c = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(c, next);

    expect(mockFetch).toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("should use async getUserId function", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => createRevenueCatResponse("starter"),
    });

    const middleware = createRateLimitMiddleware({
      revenueCatApiKey: "test-key",
      rateLimitsConfig: testConfig,
      db: createMockDb(),
      rateLimitsTable: mockTable,
      getUserId: async () => "async-user-id",
    });

    const c = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(c, next);

    // Verify the fetch was called with the correct user ID
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("async-user-id"),
      expect.any(Object)
    );
  });

  it("should fall back to 'none' entitlement on RevenueCat error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const middleware = createRateLimitMiddleware({
      revenueCatApiKey: "test-key",
      rateLimitsConfig: testConfig,
      db: createMockDb(),
      rateLimitsTable: mockTable,
      getUserId: () => "user-1",
    });

    const c = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);

    // Should not throw, should fall back to "none" limits
    await middleware(c, next);

    expect(next).toHaveBeenCalledOnce();
    // "none" limits: hourly: 5, daily: 20, monthly: 100
    // After one request: 4, 19, 99
    expect(c._headers["X-RateLimit-Hourly-Remaining"]).toBe("4");
    expect(c._headers["X-RateLimit-Daily-Remaining"]).toBe("19");
    expect(c._headers["X-RateLimit-Monthly-Remaining"]).toBe("99");
  });

  it("should pass testMode to RevenueCat when getTestMode is provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        // In test mode, sandbox purchases should be accepted
        const futureDate = new Date(
          Date.now() + 365 * 24 * 60 * 60 * 1000
        ).toISOString();
        return {
          subscriber: {
            entitlements: {
              pro: {
                expires_date: futureDate,
                grace_period_expires_date: null,
                product_identifier: "pro_monthly",
                purchase_date: "2025-01-15T10:00:00Z",
              },
            },
            subscriptions: {
              pro_monthly: {
                expires_date: futureDate,
                purchase_date: "2025-01-15T10:00:00Z",
                sandbox: true, // sandbox purchase
                store: "app_store",
              },
            },
          },
        };
      },
    });

    const middleware = createRateLimitMiddleware({
      revenueCatApiKey: "test-key",
      rateLimitsConfig: testConfig,
      db: createMockDb(),
      rateLimitsTable: mockTable,
      getUserId: () => "user-1",
      getTestMode: () => true, // Enable test mode
    });

    const c = createMockContext();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(c, next);

    // With testMode=true, sandbox pro purchase should be accepted
    // Pro has unlimited limits, so no rate limit headers should be set
    expect(c._headers["X-RateLimit-Hourly-Remaining"]).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  describe("rate limit exceeded response", () => {
    it("should return 429 when rate limit is exceeded", async () => {
      // Create a DB that reports the hourly limit is reached
      const now = new Date();
      const hourStart = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          now.getUTCHours(),
          0,
          0,
          0
        )
      );

      const mockDb: any = {
        select: () => ({
          from: (_table: any) => ({
            where: (_pred: any) => ({
              limit: (_n: number) =>
                Promise.resolve([
                  {
                    id: "counter-1",
                    user_id: "user-1",
                    period_type: "hourly",
                    period_start: hourStart,
                    request_count: 5, // at limit for "none" tier
                    created_at: now,
                    updated_at: now,
                  },
                ]),
              orderBy: (_desc: any) => ({
                limit: (_n: number) => Promise.resolve([]),
              }),
            }),
          }),
        }),
        update: (_table: any) => ({
          set: (_values: any) => ({
            where: (_pred: any) => Promise.resolve(),
          }),
        }),
        insert: (_table: any) => ({
          values: (_values: any) => Promise.resolve(),
        }),
      };

      // User has "none" entitlement (not found in RevenueCat)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const middleware = createRateLimitMiddleware({
        revenueCatApiKey: "test-key",
        rateLimitsConfig: testConfig,
        db: mockDb,
        rateLimitsTable: mockTable,
        getUserId: () => "user-1",
      });

      const c = createMockContext();
      const next = vi.fn().mockResolvedValue(undefined);

      const response = await middleware(c, next);

      // next() should NOT be called when rate limited
      expect(next).not.toHaveBeenCalled();

      // Should return a JSON response
      const jsonResponse = c._getJsonResponse();
      expect(jsonResponse).toBeDefined();
      expect(jsonResponse.success).toBe(false);
      expect(jsonResponse.error).toBe("Rate limit exceeded");
      expect(jsonResponse.exceededLimit).toBe("hourly");
      expect(jsonResponse.remaining).toBeDefined();
      expect(jsonResponse.timestamp).toBeDefined();
    });
  });
});
