/**
 * Time utilities for rate limit period calculation.
 *
 * All periods are calculated in UTC:
 * - Hourly: top of hour (e.g., 10:00:00Z, 11:00:00Z)
 * - Daily: midnight UTC (e.g., 2025-01-15T00:00:00Z)
 * - Monthly: based on subscription start date
 *   (e.g., if subscription started 3/5, months are 3/5-4/4, 4/5-5/4, etc.)
 */

// ============================================================================
// Hourly Period Functions
// ============================================================================

/**
 * Get the start of the current hour in UTC.
 *
 * Truncates minutes, seconds, and milliseconds to zero.
 *
 * @param now - Reference date (defaults to current time)
 * @returns Date object representing the top of the current hour in UTC
 * @example
 * ```typescript
 * getCurrentHourStart(new Date("2025-06-15T14:35:22Z"))
 * // Returns: 2025-06-15T14:00:00.000Z
 * ```
 */
export function getCurrentHourStart(now: Date = new Date()): Date {
  return new Date(
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
}

/**
 * Get the start of the next hour in UTC.
 *
 * @param now - Reference date (defaults to current time)
 * @returns Date object representing the top of the next hour in UTC
 * @example
 * ```typescript
 * getNextHourStart(new Date("2025-06-15T14:35:22Z"))
 * // Returns: 2025-06-15T15:00:00.000Z
 * ```
 */
export function getNextHourStart(now: Date = new Date()): Date {
  const next = new Date(getCurrentHourStart(now));
  next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

/**
 * Get the next hour reset timestamp.
 *
 * @param now - Reference date (defaults to current time)
 * @returns Date object representing the next hour boundary
 * @deprecated Use {@link getNextHourStart} instead
 */
export function getNextHourReset(now: Date = new Date()): Date {
  return getNextHourStart(now);
}

// ============================================================================
// Daily Period Functions
// ============================================================================

/**
 * Get the start of the current day in UTC (midnight).
 *
 * @param now - Reference date (defaults to current time)
 * @returns Date object representing midnight UTC of the current day
 * @example
 * ```typescript
 * getCurrentDayStart(new Date("2025-01-15T14:35:22Z"))
 * // Returns: 2025-01-15T00:00:00.000Z
 * ```
 */
export function getCurrentDayStart(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );
}

/**
 * Get the start of the next day in UTC (midnight).
 *
 * @param now - Reference date (defaults to current time)
 * @returns Date object representing midnight UTC of the next day
 * @example
 * ```typescript
 * getNextDayStart(new Date("2025-01-15T14:35:22Z"))
 * // Returns: 2025-01-16T00:00:00.000Z
 * ```
 */
export function getNextDayStart(now: Date = new Date()): Date {
  const next = new Date(getCurrentDayStart(now));
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/**
 * Get the next day reset timestamp.
 *
 * @param now - Reference date (defaults to current time)
 * @returns Date object representing the next day boundary
 * @deprecated Use {@link getNextDayStart} instead
 */
export function getNextDayReset(now: Date = new Date()): Date {
  return getNextDayStart(now);
}

// ============================================================================
// Monthly Period Functions (Subscription-based)
// ============================================================================

/**
 * Get the start of the current subscription month.
 *
 * Subscription months are based on the subscription start date:
 * - If subscription started on day 5, months are: 3/5-4/4, 4/5-5/4, etc.
 * - If subscription started on day 31 but current month has fewer days,
 *   uses the last day of the month.
 *
 * @param subscriptionStartedAt - When the subscription started (null for no subscription)
 * @param now - Current date (defaults to now)
 * @returns Start of the current subscription month
 *
 * @example
 * // Subscription started March 5, current date April 10
 * getSubscriptionMonthStart(new Date('2025-03-05'), new Date('2025-04-10'))
 * // Returns: 2025-04-05T00:00:00Z
 *
 * @example
 * // Subscription started March 5, current date April 3
 * getSubscriptionMonthStart(new Date('2025-03-05'), new Date('2025-04-03'))
 * // Returns: 2025-03-05T00:00:00Z
 */
export function getSubscriptionMonthStart(
  subscriptionStartedAt: Date | null,
  now: Date = new Date()
): Date {
  // If no subscription, fall back to first of current calendar month
  if (!subscriptionStartedAt) {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
    );
  }

  const startDay = subscriptionStartedAt.getUTCDate();
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth();
  const nowDay = now.getUTCDate();

  // Get the last day of the current month
  const lastDayOfMonth = new Date(
    Date.UTC(nowYear, nowMonth + 1, 0)
  ).getUTCDate();

  // Adjust start day if it's greater than days in current month
  const effectiveStartDay = Math.min(startDay, lastDayOfMonth);

  // Check if we're past the subscription day in this month
  if (nowDay >= effectiveStartDay) {
    // Current period started this month
    return new Date(Date.UTC(nowYear, nowMonth, effectiveStartDay, 0, 0, 0, 0));
  } else {
    // Current period started last month
    const prevMonth = nowMonth === 0 ? 11 : nowMonth - 1;
    const prevYear = nowMonth === 0 ? nowYear - 1 : nowYear;

    // Get last day of previous month to handle day overflow
    const lastDayOfPrevMonth = new Date(
      Date.UTC(prevYear, prevMonth + 1, 0)
    ).getUTCDate();
    const effectivePrevStartDay = Math.min(startDay, lastDayOfPrevMonth);

    return new Date(
      Date.UTC(prevYear, prevMonth, effectivePrevStartDay, 0, 0, 0, 0)
    );
  }
}

/**
 * Get the start of the next subscription month.
 *
 * @param subscriptionStartedAt - When the subscription started (null for no subscription)
 * @param now - Current date (defaults to now)
 * @returns Start of the next subscription month
 */
export function getNextSubscriptionMonthStart(
  subscriptionStartedAt: Date | null,
  now: Date = new Date()
): Date {
  const currentMonthStart = getSubscriptionMonthStart(
    subscriptionStartedAt,
    now
  );

  // If no subscription, use first of next calendar month
  if (!subscriptionStartedAt) {
    return new Date(
      Date.UTC(
        currentMonthStart.getUTCFullYear(),
        currentMonthStart.getUTCMonth() + 1,
        1,
        0,
        0,
        0,
        0
      )
    );
  }

  const startDay = subscriptionStartedAt.getUTCDate();
  const nextMonth = currentMonthStart.getUTCMonth() + 1;
  const nextYear =
    nextMonth > 11
      ? currentMonthStart.getUTCFullYear() + 1
      : currentMonthStart.getUTCFullYear();
  const normalizedMonth = nextMonth % 12;

  // Get last day of next month to handle day overflow
  const lastDayOfNextMonth = new Date(
    Date.UTC(nextYear, normalizedMonth + 1, 0)
  ).getUTCDate();
  const effectiveStartDay = Math.min(startDay, lastDayOfNextMonth);

  return new Date(
    Date.UTC(nextYear, normalizedMonth, effectiveStartDay, 0, 0, 0, 0)
  );
}

/**
 * Get the next month reset timestamp (calendar month).
 *
 * Returns the first day of the next calendar month at midnight UTC.
 *
 * @param now - Reference date (defaults to current time)
 * @returns Date object representing the first day of the next calendar month
 * @deprecated Use {@link getNextSubscriptionMonthStart} for subscription-based months
 */
export function getNextMonthReset(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)
  );
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get time until reset in human-readable format.
 *
 * Formats the duration between now and the reset timestamp into a compact
 * human-readable string. Uses the largest meaningful units.
 *
 * @param resetAt - The reset timestamp
 * @param now - Current time (defaults to `new Date()`)
 * @returns Formatted string like "now", "30s", "45m", "2h 30m", or "3d 2h"
 *
 * @example
 * ```typescript
 * const now = new Date("2025-06-15T12:00:00Z");
 * getTimeUntilReset(new Date("2025-06-15T14:30:00Z"), now) // "2h 30m"
 * getTimeUntilReset(new Date("2025-06-15T11:00:00Z"), now) // "now" (past)
 * ```
 */
export function getTimeUntilReset(
  resetAt: Date,
  now: Date = new Date()
): string {
  const diffMs = resetAt.getTime() - now.getTime();

  if (diffMs <= 0) return "now";

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}
