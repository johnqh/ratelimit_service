import {
  NONE_ENTITLEMENT,
  type RevenueCatSubscriberResponse,
} from "../types/entitlements";
import type { SubscriptionInfo } from "../types/responses";

/**
 * Configuration for RevenueCatHelper.
 */
export interface RevenueCatHelperConfig {
  /** RevenueCat API key (secret key for server-side use) */
  apiKey: string;
  /** Base URL for RevenueCat API. Defaults to https://api.revenuecat.com/v1 */
  baseUrl?: string;
}

/**
 * Helper class for interacting with RevenueCat API to get user entitlements
 * and subscription information.
 *
 * @example
 * ```typescript
 * const rcHelper = new RevenueCatHelper({
 *   apiKey: process.env.REVENUECAT_API_KEY!,
 * });
 *
 * // Get just entitlements (for backward compatibility)
 * const entitlements = await rcHelper.getEntitlements(userId);
 * // Returns: ["pro"] or ["none"] if no subscription
 *
 * // Get full subscription info including start date
 * const info = await rcHelper.getSubscriptionInfo(userId);
 * // Returns: { entitlements: ["pro"], subscriptionStartedAt: Date }
 * ```
 */
export class RevenueCatHelper {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: RevenueCatHelperConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.revenuecat.com/v1";
  }

  /**
   * Get active entitlement names for a user.
   *
   * @param userId - The RevenueCat app_user_id (usually Firebase UID)
   * @returns Array of active entitlement names, or ["none"] if no active entitlements
   * @throws Error if RevenueCat API returns an error (other than 404)
   */
  async getEntitlements(userId: string): Promise<string[]> {
    const info = await this.getSubscriptionInfo(userId);
    return info.entitlements;
  }

  /**
   * Get full subscription info including entitlements and subscription start date.
   *
   * @param userId - The RevenueCat app_user_id (usually Firebase UID)
   * @returns SubscriptionInfo with entitlements and subscriptionStartedAt
   * @throws Error if RevenueCat API returns an error (other than 404)
   */
  async getSubscriptionInfo(userId: string): Promise<SubscriptionInfo> {
    const response = await fetch(
      `${this.baseUrl}/subscribers/${encodeURIComponent(userId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    // User not found in RevenueCat - treat as no subscription
    if (response.status === 404) {
      return {
        entitlements: [NONE_ENTITLEMENT],
        subscriptionStartedAt: null,
      };
    }

    if (!response.ok) {
      throw new Error(
        `RevenueCat API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as RevenueCatSubscriberResponse;
    const entitlements = data.subscriber?.entitlements ?? {};

    const now = new Date();
    const activeEntitlements: string[] = [];
    let earliestPurchaseDate: Date | null = null;

    for (const [name, entitlement] of Object.entries(entitlements)) {
      // Check if entitlement is active (no expiry or not expired)
      const isActive =
        !entitlement.expires_date || new Date(entitlement.expires_date) > now;

      if (isActive) {
        activeEntitlements.push(name);

        // Track earliest purchase date for subscription month calculation
        const purchaseDate = new Date(entitlement.purchase_date);
        if (!earliestPurchaseDate || purchaseDate < earliestPurchaseDate) {
          earliestPurchaseDate = purchaseDate;
        }
      }
    }

    // If no active entitlements, return "none"
    if (activeEntitlements.length === 0) {
      return {
        entitlements: [NONE_ENTITLEMENT],
        subscriptionStartedAt: null,
      };
    }

    return {
      entitlements: activeEntitlements,
      subscriptionStartedAt: earliestPurchaseDate,
    };
  }
}
