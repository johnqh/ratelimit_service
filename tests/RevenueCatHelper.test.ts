import { describe, it, expect, vi, beforeEach } from "vitest";
import { RevenueCatHelper } from "../src/helpers/RevenueCatHelper";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/**
 * Creates a standard RevenueCat subscriber response.
 */
function createSubscriberResponse(options: {
  entitlements?: Record<
    string,
    {
      expires_date: string | null;
      product_identifier: string;
      purchase_date: string;
    }
  >;
  subscriptions?: Record<
    string,
    {
      expires_date: string | null;
      purchase_date: string;
      sandbox: boolean;
      store: string;
    }
  >;
}) {
  return {
    subscriber: {
      entitlements: Object.fromEntries(
        Object.entries(options.entitlements ?? {}).map(([name, ent]) => [
          name,
          {
            expires_date: ent.expires_date,
            grace_period_expires_date: null,
            product_identifier: ent.product_identifier,
            purchase_date: ent.purchase_date,
          },
        ])
      ),
      subscriptions: options.subscriptions ?? {},
    },
  };
}

describe("RevenueCatHelper", () => {
  const helper = new RevenueCatHelper({ apiKey: "test-api-key" });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getSubscriptionInfo", () => {
    it("should return active entitlements from RevenueCat", async () => {
      const futureDate = new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000
      ).toISOString();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () =>
          createSubscriberResponse({
            entitlements: {
              pro: {
                expires_date: futureDate,
                product_identifier: "pro_monthly",
                purchase_date: "2025-01-15T10:00:00Z",
              },
            },
            subscriptions: {
              pro_monthly: {
                expires_date: futureDate,
                purchase_date: "2025-01-15T10:00:00Z",
                sandbox: false,
                store: "app_store",
              },
            },
          }),
      });

      const info = await helper.getSubscriptionInfo("user-1");

      expect(info.entitlements).toEqual(["pro"]);
      expect(info.subscriptionStartedAt).toEqual(
        new Date("2025-01-15T10:00:00Z")
      );
    });

    it("should return ['none'] for user not found (404)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const info = await helper.getSubscriptionInfo("unknown-user");

      expect(info.entitlements).toEqual(["none"]);
      expect(info.subscriptionStartedAt).toBeNull();
    });

    it("should throw error for other HTTP errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(helper.getSubscriptionInfo("user-1")).rejects.toThrow(
        "RevenueCat API error: 500 Internal Server Error"
      );
    });

    it("should return ['none'] for expired entitlements", async () => {
      const pastDate = new Date(
        Date.now() - 24 * 60 * 60 * 1000
      ).toISOString();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () =>
          createSubscriberResponse({
            entitlements: {
              pro: {
                expires_date: pastDate,
                product_identifier: "pro_monthly",
                purchase_date: "2025-01-15T10:00:00Z",
              },
            },
            subscriptions: {
              pro_monthly: {
                expires_date: pastDate,
                purchase_date: "2025-01-15T10:00:00Z",
                sandbox: false,
                store: "app_store",
              },
            },
          }),
      });

      const info = await helper.getSubscriptionInfo("user-1");

      expect(info.entitlements).toEqual(["none"]);
      expect(info.subscriptionStartedAt).toBeNull();
    });

    it("should accept lifetime entitlements (null expires_date)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () =>
          createSubscriberResponse({
            entitlements: {
              pro: {
                expires_date: null,
                product_identifier: "pro_lifetime",
                purchase_date: "2025-01-15T10:00:00Z",
              },
            },
            subscriptions: {
              pro_lifetime: {
                expires_date: null,
                purchase_date: "2025-01-15T10:00:00Z",
                sandbox: false,
                store: "app_store",
              },
            },
          }),
      });

      const info = await helper.getSubscriptionInfo("user-1");

      expect(info.entitlements).toEqual(["pro"]);
    });

    it("should reject sandbox purchases in production mode (testMode=false)", async () => {
      const futureDate = new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000
      ).toISOString();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () =>
          createSubscriberResponse({
            entitlements: {
              pro: {
                expires_date: futureDate,
                product_identifier: "pro_monthly",
                purchase_date: "2025-01-15T10:00:00Z",
              },
            },
            subscriptions: {
              pro_monthly: {
                expires_date: futureDate,
                purchase_date: "2025-01-15T10:00:00Z",
                sandbox: true,
                store: "app_store",
              },
            },
          }),
      });

      const info = await helper.getSubscriptionInfo("user-1", false);

      expect(info.entitlements).toEqual(["none"]);
      expect(info.subscriptionStartedAt).toBeNull();
    });

    it("should accept sandbox purchases in test mode (testMode=true)", async () => {
      const futureDate = new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000
      ).toISOString();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () =>
          createSubscriberResponse({
            entitlements: {
              pro: {
                expires_date: futureDate,
                product_identifier: "pro_monthly",
                purchase_date: "2025-01-15T10:00:00Z",
              },
            },
            subscriptions: {
              pro_monthly: {
                expires_date: futureDate,
                purchase_date: "2025-01-15T10:00:00Z",
                sandbox: true,
                store: "app_store",
              },
            },
          }),
      });

      const info = await helper.getSubscriptionInfo("user-1", true);

      expect(info.entitlements).toEqual(["pro"]);
    });

    it("should return multiple active entitlements", async () => {
      const futureDate = new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000
      ).toISOString();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () =>
          createSubscriberResponse({
            entitlements: {
              starter: {
                expires_date: futureDate,
                product_identifier: "starter_monthly",
                purchase_date: "2025-01-15T10:00:00Z",
              },
              pro: {
                expires_date: futureDate,
                product_identifier: "pro_monthly",
                purchase_date: "2025-02-20T10:00:00Z",
              },
            },
            subscriptions: {
              starter_monthly: {
                expires_date: futureDate,
                purchase_date: "2025-01-15T10:00:00Z",
                sandbox: false,
                store: "app_store",
              },
              pro_monthly: {
                expires_date: futureDate,
                purchase_date: "2025-02-20T10:00:00Z",
                sandbox: false,
                store: "app_store",
              },
            },
          }),
      });

      const info = await helper.getSubscriptionInfo("user-1");

      expect(info.entitlements).toContain("starter");
      expect(info.entitlements).toContain("pro");
      // subscriptionStartedAt should be the earliest purchase date
      expect(info.subscriptionStartedAt).toEqual(
        new Date("2025-01-15T10:00:00Z")
      );
    });

    it("should return ['none'] when subscriber has empty entitlements", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () =>
          createSubscriberResponse({
            entitlements: {},
            subscriptions: {},
          }),
      });

      const info = await helper.getSubscriptionInfo("user-1");

      expect(info.entitlements).toEqual(["none"]);
      expect(info.subscriptionStartedAt).toBeNull();
    });

    it("should use correct API URL and headers", async () => {
      const futureDate = new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000
      ).toISOString();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () =>
          createSubscriberResponse({
            entitlements: {},
            subscriptions: {},
          }),
      });

      await helper.getSubscriptionInfo("test-user-123");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.revenuecat.com/v1/subscribers/test-user-123",
        {
          method: "GET",
          headers: {
            Authorization: "Bearer test-api-key",
            "Content-Type": "application/json",
          },
        }
      );
    });

    it("should encode special characters in user ID", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () =>
          createSubscriberResponse({
            entitlements: {},
            subscriptions: {},
          }),
      });

      await helper.getSubscriptionInfo("user@domain.com");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.revenuecat.com/v1/subscribers/user%40domain.com",
        expect.any(Object)
      );
    });

    it("should use custom base URL when provided", async () => {
      const customHelper = new RevenueCatHelper({
        apiKey: "test-key",
        baseUrl: "https://custom.api.com/v2",
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () =>
          createSubscriberResponse({
            entitlements: {},
            subscriptions: {},
          }),
      });

      await customHelper.getSubscriptionInfo("user-1");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://custom.api.com/v2/subscribers/user-1",
        expect.any(Object)
      );
    });
  });

  describe("getEntitlements", () => {
    it("should return just entitlement names (no subscription start date)", async () => {
      const futureDate = new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000
      ).toISOString();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () =>
          createSubscriberResponse({
            entitlements: {
              pro: {
                expires_date: futureDate,
                product_identifier: "pro_monthly",
                purchase_date: "2025-01-15T10:00:00Z",
              },
            },
            subscriptions: {
              pro_monthly: {
                expires_date: futureDate,
                purchase_date: "2025-01-15T10:00:00Z",
                sandbox: false,
                store: "app_store",
              },
            },
          }),
      });

      const entitlements = await helper.getEntitlements("user-1");

      expect(entitlements).toEqual(["pro"]);
    });

    it("should return ['none'] for user not found", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const entitlements = await helper.getEntitlements("unknown-user");

      expect(entitlements).toEqual(["none"]);
    });
  });
});
