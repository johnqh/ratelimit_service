import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimitRouteHandler } from "../src/helpers/RateLimitRouteHandler";
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
 * Creates a mock Drizzle database for testing.
 * Returns empty results for all queries (simulating zero usage).
 */
function createMockDb() {
  const rows: any[] = [];

  const db: any = {
    select: () => ({
      from: (_table: any) => ({
        where: (_pred: any) => ({
          limit: (n: number) => Promise.resolve(rows.slice(0, n)),
          orderBy: (_desc: any) => ({
            limit: (n: number) => Promise.resolve(rows.slice(0, n)),
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
    _rows: rows,
  };

  return db;
}

const mockTable = {} as any;

/**
 * Creates a RevenueCat API response for a given entitlement.
 */
function createRevenueCatResponse(
  entitlementName: string,
  purchaseDate: string = "2025-01-15T10:00:00Z",
  expiresDate: string | null = "2026-12-31T00:00:00Z",
  sandbox: boolean = false
) {
  return {
    subscriber: {
      entitlements: {
        [entitlementName]: {
          expires_date: expiresDate,
          grace_period_expires_date: null,
          product_identifier: `${entitlementName}_monthly`,
          purchase_date: purchaseDate,
        },
      },
      subscriptions: {
        [`${entitlementName}_monthly`]: {
          expires_date: expiresDate,
          purchase_date: purchaseDate,
          sandbox,
          store: "app_store",
        },
      },
    },
  };
}

describe("RateLimitRouteHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getRateLimitsConfigData", () => {
    it("should return all tiers from config", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => createRevenueCatResponse("starter"),
      });

      const db = createMockDb();
      const handler = new RateLimitRouteHandler({
        revenueCatApiKey: "test-key",
        rateLimitsConfig: testConfig,
        db,
        rateLimitsTable: mockTable,
      });

      const data = await handler.getRateLimitsConfigData("user-1");

      expect(data.tiers).toHaveLength(3); // none, starter, pro
      expect(data.tiers.map(t => t.entitlement)).toContain("none");
      expect(data.tiers.map(t => t.entitlement)).toContain("starter");
      expect(data.tiers.map(t => t.entitlement)).toContain("pro");
    });

    it("should resolve current entitlement from RevenueCat", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => createRevenueCatResponse("starter"),
      });

      const db = createMockDb();
      const handler = new RateLimitRouteHandler({
        revenueCatApiKey: "test-key",
        rateLimitsConfig: testConfig,
        db,
        rateLimitsTable: mockTable,
      });

      const data = await handler.getRateLimitsConfigData("user-1");

      expect(data.currentEntitlement).toBe("starter");
    });

    it("should fall back to 'none' when RevenueCat returns 404", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const db = createMockDb();
      const handler = new RateLimitRouteHandler({
        revenueCatApiKey: "test-key",
        rateLimitsConfig: testConfig,
        db,
        rateLimitsTable: mockTable,
      });

      const data = await handler.getRateLimitsConfigData("unknown-user");

      expect(data.currentEntitlement).toBe("none");
    });

    it("should fall back to 'none' when RevenueCat throws error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const db = createMockDb();
      const handler = new RateLimitRouteHandler({
        revenueCatApiKey: "test-key",
        rateLimitsConfig: testConfig,
        db,
        rateLimitsTable: mockTable,
      });

      const data = await handler.getRateLimitsConfigData("user-1");

      expect(data.currentEntitlement).toBe("none");
    });

    it("should include current limits based on entitlement", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => createRevenueCatResponse("starter"),
      });

      const db = createMockDb();
      const handler = new RateLimitRouteHandler({
        revenueCatApiKey: "test-key",
        rateLimitsConfig: testConfig,
        db,
        rateLimitsTable: mockTable,
      });

      const data = await handler.getRateLimitsConfigData("user-1");

      // Starter limits: hourly: 10, daily: 50, monthly: 500
      expect(data.currentLimits.hourly).toBe(10);
      expect(data.currentLimits.daily).toBe(50);
      expect(data.currentLimits.monthly).toBe(500);
    });

    it("should convert unlimited (undefined) to null in API limits", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => createRevenueCatResponse("pro"),
      });

      const db = createMockDb();
      const handler = new RateLimitRouteHandler({
        revenueCatApiKey: "test-key",
        rateLimitsConfig: testConfig,
        db,
        rateLimitsTable: mockTable,
      });

      const data = await handler.getRateLimitsConfigData("user-1");

      // Pro limits: all unlimited (undefined -> null in API)
      expect(data.currentLimits.hourly).toBeNull();
      expect(data.currentLimits.daily).toBeNull();
      expect(data.currentLimits.monthly).toBeNull();
    });

    it("should include current usage (zero for fresh user)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => createRevenueCatResponse("starter"),
      });

      const db = createMockDb();
      const handler = new RateLimitRouteHandler({
        revenueCatApiKey: "test-key",
        rateLimitsConfig: testConfig,
        db,
        rateLimitsTable: mockTable,
      });

      const data = await handler.getRateLimitsConfigData("user-1");

      expect(data.currentUsage.hourly).toBe(0);
      expect(data.currentUsage.daily).toBe(0);
      expect(data.currentUsage.monthly).toBe(0);
    });

    it("should include reset times", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => createRevenueCatResponse("starter"),
      });

      const db = createMockDb();
      const handler = new RateLimitRouteHandler({
        revenueCatApiKey: "test-key",
        rateLimitsConfig: testConfig,
        db,
        rateLimitsTable: mockTable,
      });

      const data = await handler.getRateLimitsConfigData("user-1");

      expect(data.resets).toBeDefined();
      expect(data.resets!.hourly).toBeDefined();
      expect(data.resets!.daily).toBeDefined();
      expect(data.resets!.monthly).toBeDefined();

      // Resets should be valid ISO date strings
      expect(() => new Date(data.resets!.hourly)).not.toThrow();
      expect(() => new Date(data.resets!.daily)).not.toThrow();
      expect(() => new Date(data.resets!.monthly)).not.toThrow();
    });

    it("should use custom display names when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => createRevenueCatResponse("starter"),
      });

      const db = createMockDb();
      const handler = new RateLimitRouteHandler({
        revenueCatApiKey: "test-key",
        rateLimitsConfig: testConfig,
        db,
        rateLimitsTable: mockTable,
        entitlementDisplayNames: {
          starter: "Basic Plan",
          pro: "Professional",
        },
      });

      const data = await handler.getRateLimitsConfigData("user-1");

      const starterTier = data.tiers.find(t => t.entitlement === "starter");
      expect(starterTier?.displayName).toBe("Basic Plan");

      const proTier = data.tiers.find(t => t.entitlement === "pro");
      expect(proTier?.displayName).toBe("Professional");
    });

    it("should use default display names when not provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => createRevenueCatResponse("starter"),
      });

      const db = createMockDb();
      const handler = new RateLimitRouteHandler({
        revenueCatApiKey: "test-key",
        rateLimitsConfig: testConfig,
        db,
        rateLimitsTable: mockTable,
      });

      const data = await handler.getRateLimitsConfigData("user-1");

      const noneTier = data.tiers.find(t => t.entitlement === "none");
      expect(noneTier?.displayName).toBe("Free");

      const starterTier = data.tiers.find(t => t.entitlement === "starter");
      expect(starterTier?.displayName).toBe("Starter");

      const proTier = data.tiers.find(t => t.entitlement === "pro");
      expect(proTier?.displayName).toBe("Pro");
    });
  });

  describe("getRateLimitHistoryData", () => {
    it("should return empty history for new user", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => createRevenueCatResponse("starter"),
      });

      const db = createMockDb();
      const handler = new RateLimitRouteHandler({
        revenueCatApiKey: "test-key",
        rateLimitsConfig: testConfig,
        db,
        rateLimitsTable: mockTable,
      });

      const data = await handler.getRateLimitHistoryData("user-1", "hour");

      expect(data.periodType).toBe("hour");
      expect(data.entries).toEqual([]);
      expect(data.totalEntries).toBe(0);
    });

    it("should handle all period types", async () => {
      const db = createMockDb();
      const handler = new RateLimitRouteHandler({
        revenueCatApiKey: "test-key",
        rateLimitsConfig: testConfig,
        db,
        rateLimitsTable: mockTable,
      });

      // Test each period type
      for (const periodType of ["hour", "day", "month"] as const) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => createRevenueCatResponse("starter"),
        });

        const data = await handler.getRateLimitHistoryData(
          "user-1",
          periodType
        );
        expect(data.periodType).toBe(periodType);
      }
    });

    it("should fall back gracefully when RevenueCat fails for history", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const db = createMockDb();
      const handler = new RateLimitRouteHandler({
        revenueCatApiKey: "test-key",
        rateLimitsConfig: testConfig,
        db,
        rateLimitsTable: mockTable,
      });

      // Should not throw, should use "none" entitlement
      const data = await handler.getRateLimitHistoryData("user-1", "hour");
      expect(data.periodType).toBe("hour");
      expect(data.entries).toEqual([]);
    });
  });
});
