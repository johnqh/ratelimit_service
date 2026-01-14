/**
 * The special entitlement name for users without any subscription.
 * This is returned when a user has no active entitlements in RevenueCat.
 */
export const NONE_ENTITLEMENT = "none" as const;

/**
 * RevenueCat entitlement information from the subscriber API.
 */
export interface RevenueCatEntitlement {
  /** Expiration date in ISO format, or null if lifetime */
  expires_date: string | null;
  /** Grace period expiration date */
  grace_period_expires_date: string | null;
  /** Product identifier in the app store */
  product_identifier: string;
  /** Purchase date in ISO format */
  purchase_date: string;
}

/**
 * RevenueCat subscription information from the subscriber API.
 */
export interface RevenueCatSubscription {
  /** Expiration date in ISO format, or null if lifetime */
  expires_date: string | null;
  /** Purchase date in ISO format */
  purchase_date: string;
  /** Whether this is a sandbox purchase */
  sandbox: boolean;
  /** Store where the purchase was made */
  store: string;
}

/**
 * Response shape from RevenueCat's GET /subscribers/{user_id} endpoint.
 */
export interface RevenueCatSubscriberResponse {
  subscriber: {
    entitlements: {
      [key: string]: RevenueCatEntitlement;
    };
    subscriptions: {
      [key: string]: RevenueCatSubscription;
    };
  };
}
