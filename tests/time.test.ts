import { describe, it, expect } from "bun:test";
import {
  getCurrentHourStart,
  getNextHourStart,
  getNextHourReset,
  getCurrentDayStart,
  getNextDayStart,
  getNextDayReset,
  getSubscriptionMonthStart,
  getNextSubscriptionMonthStart,
  getNextMonthReset,
  getTimeUntilReset,
} from "../src/utils/time";

describe("time utilities", () => {
  describe("getCurrentHourStart", () => {
    it("should return the start of the current hour in UTC", () => {
      const now = new Date("2025-06-15T14:30:45.123Z");
      const start = getCurrentHourStart(now);

      expect(start.getUTCHours()).toBe(14);
      expect(start.getUTCMinutes()).toBe(0);
      expect(start.getUTCSeconds()).toBe(0);
      expect(start.getUTCMilliseconds()).toBe(0);
    });

    it("should handle midnight correctly", () => {
      const now = new Date("2025-06-15T00:30:00Z");
      const start = getCurrentHourStart(now);

      expect(start.getUTCHours()).toBe(0);
      expect(start.getUTCDate()).toBe(15);
    });
  });

  describe("getNextHourStart", () => {
    it("should return the start of the next hour", () => {
      const now = new Date("2025-06-15T14:30:45.123Z");
      const reset = getNextHourStart(now);

      expect(reset.getUTCHours()).toBe(15);
      expect(reset.getUTCMinutes()).toBe(0);
      expect(reset.getUTCSeconds()).toBe(0);
      expect(reset.getUTCMilliseconds()).toBe(0);
    });

    it("should handle hour boundary correctly", () => {
      const now = new Date("2025-06-15T23:59:59.999Z");
      const reset = getNextHourStart(now);

      // Should roll over to next day
      expect(reset.getUTCHours()).toBe(0);
      expect(reset.getUTCDate()).toBe(16);
    });
  });

  describe("getNextHourReset (deprecated)", () => {
    it("should be an alias for getNextHourStart", () => {
      const now = new Date("2025-06-15T14:30:45.123Z");
      expect(getNextHourReset(now).getTime()).toBe(getNextHourStart(now).getTime());
    });
  });

  describe("getCurrentDayStart", () => {
    it("should return midnight UTC of the current day", () => {
      const now = new Date("2025-06-15T14:30:45.123Z");
      const start = getCurrentDayStart(now);

      expect(start.getUTCDate()).toBe(15);
      expect(start.getUTCHours()).toBe(0);
      expect(start.getUTCMinutes()).toBe(0);
      expect(start.getUTCSeconds()).toBe(0);
    });
  });

  describe("getNextDayStart", () => {
    it("should return midnight UTC of the next day", () => {
      const now = new Date("2025-06-15T14:30:45.123Z");
      const reset = getNextDayStart(now);

      expect(reset.getUTCDate()).toBe(16);
      expect(reset.getUTCHours()).toBe(0);
      expect(reset.getUTCMinutes()).toBe(0);
      expect(reset.getUTCSeconds()).toBe(0);
    });

    it("should handle month boundary correctly", () => {
      const now = new Date("2025-06-30T14:30:45.123Z");
      const reset = getNextDayStart(now);

      expect(reset.getUTCMonth()).toBe(6); // July (0-indexed)
      expect(reset.getUTCDate()).toBe(1);
    });
  });

  describe("getNextDayReset (deprecated)", () => {
    it("should be an alias for getNextDayStart", () => {
      const now = new Date("2025-06-15T14:30:45.123Z");
      expect(getNextDayReset(now).getTime()).toBe(getNextDayStart(now).getTime());
    });
  });

  describe("getSubscriptionMonthStart", () => {
    it("should return first of month when no subscription", () => {
      const now = new Date("2025-06-15T14:30:45.123Z");
      const start = getSubscriptionMonthStart(null, now);

      expect(start.getUTCFullYear()).toBe(2025);
      expect(start.getUTCMonth()).toBe(5); // June
      expect(start.getUTCDate()).toBe(1);
      expect(start.getUTCHours()).toBe(0);
    });

    it("should return subscription day when past that day in current month", () => {
      // Subscription started March 5, current date April 10
      const subscriptionStartedAt = new Date("2025-03-05T10:00:00Z");
      const now = new Date("2025-04-10T14:30:45.123Z");
      const start = getSubscriptionMonthStart(subscriptionStartedAt, now);

      expect(start.getUTCFullYear()).toBe(2025);
      expect(start.getUTCMonth()).toBe(3); // April
      expect(start.getUTCDate()).toBe(5);
    });

    it("should return previous month subscription day when before that day", () => {
      // Subscription started March 5, current date April 3
      const subscriptionStartedAt = new Date("2025-03-05T10:00:00Z");
      const now = new Date("2025-04-03T14:30:45.123Z");
      const start = getSubscriptionMonthStart(subscriptionStartedAt, now);

      expect(start.getUTCFullYear()).toBe(2025);
      expect(start.getUTCMonth()).toBe(2); // March
      expect(start.getUTCDate()).toBe(5);
    });

    it("should handle exactly on subscription day", () => {
      // Subscription started March 5, current date April 5
      const subscriptionStartedAt = new Date("2025-03-05T10:00:00Z");
      const now = new Date("2025-04-05T00:00:00Z");
      const start = getSubscriptionMonthStart(subscriptionStartedAt, now);

      expect(start.getUTCFullYear()).toBe(2025);
      expect(start.getUTCMonth()).toBe(3); // April
      expect(start.getUTCDate()).toBe(5);
    });

    it("should handle day 31 in short month (use last day)", () => {
      // Subscription started Jan 31, current date Feb 15
      const subscriptionStartedAt = new Date("2025-01-31T10:00:00Z");
      const now = new Date("2025-02-15T14:30:45.123Z");
      const start = getSubscriptionMonthStart(subscriptionStartedAt, now);

      // February has 28 days in 2025, so effective day is 28
      // Since 15 < 28, should be previous month
      expect(start.getUTCFullYear()).toBe(2025);
      expect(start.getUTCMonth()).toBe(0); // January
      expect(start.getUTCDate()).toBe(31);
    });

    it("should handle day 31 when current is past adjusted day", () => {
      // Subscription started Jan 31, current date Feb 28 (past adjusted day)
      const subscriptionStartedAt = new Date("2025-01-31T10:00:00Z");
      const now = new Date("2025-02-28T14:30:45.123Z");
      const start = getSubscriptionMonthStart(subscriptionStartedAt, now);

      // February has 28 days in 2025, so effective day is 28
      // Since 28 >= 28, should be this month
      expect(start.getUTCFullYear()).toBe(2025);
      expect(start.getUTCMonth()).toBe(1); // February
      expect(start.getUTCDate()).toBe(28);
    });

    it("should handle year boundary correctly", () => {
      // Subscription started Dec 15, current date Jan 10 (before 15th)
      const subscriptionStartedAt = new Date("2024-12-15T10:00:00Z");
      const now = new Date("2025-01-10T14:30:45.123Z");
      const start = getSubscriptionMonthStart(subscriptionStartedAt, now);

      expect(start.getUTCFullYear()).toBe(2024);
      expect(start.getUTCMonth()).toBe(11); // December
      expect(start.getUTCDate()).toBe(15);
    });
  });

  describe("getNextSubscriptionMonthStart", () => {
    it("should return next month when no subscription", () => {
      const now = new Date("2025-06-15T14:30:45.123Z");
      const next = getNextSubscriptionMonthStart(null, now);

      expect(next.getUTCFullYear()).toBe(2025);
      expect(next.getUTCMonth()).toBe(6); // July
      expect(next.getUTCDate()).toBe(1);
    });

    it("should return next subscription month start", () => {
      // Subscription started March 5, current date April 10
      // Current period started April 5, next period starts May 5
      const subscriptionStartedAt = new Date("2025-03-05T10:00:00Z");
      const now = new Date("2025-04-10T14:30:45.123Z");
      const next = getNextSubscriptionMonthStart(subscriptionStartedAt, now);

      expect(next.getUTCFullYear()).toBe(2025);
      expect(next.getUTCMonth()).toBe(4); // May
      expect(next.getUTCDate()).toBe(5);
    });

    it("should handle year boundary correctly", () => {
      // Subscription started March 5, current date December 10
      // Current period started Dec 5, next period starts Jan 5
      const subscriptionStartedAt = new Date("2025-03-05T10:00:00Z");
      const now = new Date("2025-12-10T14:30:45.123Z");
      const next = getNextSubscriptionMonthStart(subscriptionStartedAt, now);

      expect(next.getUTCFullYear()).toBe(2026);
      expect(next.getUTCMonth()).toBe(0); // January
      expect(next.getUTCDate()).toBe(5);
    });

    it("should handle day 31 overflow in next month", () => {
      // Subscription started Jan 31, current date Jan 31
      // Current period started Jan 31, next period should be Feb 28
      const subscriptionStartedAt = new Date("2025-01-31T10:00:00Z");
      const now = new Date("2025-01-31T14:30:45.123Z");
      const next = getNextSubscriptionMonthStart(subscriptionStartedAt, now);

      // February has 28 days, so next period starts Feb 28
      expect(next.getUTCFullYear()).toBe(2025);
      expect(next.getUTCMonth()).toBe(1); // February
      expect(next.getUTCDate()).toBe(28);
    });
  });

  describe("getNextMonthReset (deprecated)", () => {
    it("should return first of next month at midnight UTC", () => {
      const now = new Date("2025-06-15T14:30:45.123Z");
      const reset = getNextMonthReset(now);

      expect(reset.getUTCFullYear()).toBe(2025);
      expect(reset.getUTCMonth()).toBe(6); // July
      expect(reset.getUTCDate()).toBe(1);
      expect(reset.getUTCHours()).toBe(0);
      expect(reset.getUTCMinutes()).toBe(0);
    });

    it("should handle year boundary correctly", () => {
      const now = new Date("2025-12-15T14:30:45.123Z");
      const reset = getNextMonthReset(now);

      expect(reset.getUTCFullYear()).toBe(2026);
      expect(reset.getUTCMonth()).toBe(0); // January
      expect(reset.getUTCDate()).toBe(1);
    });
  });

  describe("getTimeUntilReset", () => {
    it("should return 'now' for past dates", () => {
      const resetAt = new Date("2025-06-15T10:00:00Z");
      const now = new Date("2025-06-15T12:00:00Z");

      expect(getTimeUntilReset(resetAt, now)).toBe("now");
    });

    it("should format seconds correctly", () => {
      const now = new Date("2025-06-15T12:00:00Z");
      const resetAt = new Date("2025-06-15T12:00:30Z");

      expect(getTimeUntilReset(resetAt, now)).toBe("30s");
    });

    it("should format minutes correctly", () => {
      const now = new Date("2025-06-15T12:00:00Z");
      const resetAt = new Date("2025-06-15T12:45:00Z");

      expect(getTimeUntilReset(resetAt, now)).toBe("45m");
    });

    it("should format hours and minutes correctly", () => {
      const now = new Date("2025-06-15T12:00:00Z");
      const resetAt = new Date("2025-06-15T14:30:00Z");

      expect(getTimeUntilReset(resetAt, now)).toBe("2h 30m");
    });

    it("should format days and hours correctly", () => {
      const now = new Date("2025-06-15T12:00:00Z");
      const resetAt = new Date("2025-06-18T14:00:00Z");

      expect(getTimeUntilReset(resetAt, now)).toBe("3d 2h");
    });
  });
});
