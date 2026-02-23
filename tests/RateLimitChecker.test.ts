import { describe, it, expect, vi } from "vitest";
import { RateLimitChecker } from "../src/helpers/RateLimitChecker";
import { PeriodType } from "../src/types/responses";
import type { RateLimits } from "../src/types/rate-limits";

/**
 * Creates a mock Drizzle database for testing RateLimitChecker.
 *
 * The mock stores rows in-memory and uses a simple predicate-tracking system
 * to emulate Drizzle's query builder chain:
 *   db.select().from(table).where(and(eq(col, val), ...)).limit(n)
 *
 * Drizzle's eq() and and() are real functions from drizzle-orm that produce
 * SQL objects. We intercept the query at the .where() level by tracking
 * which values were passed to eq() calls via proxied table columns.
 */
function createMockDb() {
  const rows: any[] = [];

  /** Tracks the last set of eq() conditions captured during a where() call. */
  let capturedConditions: Record<string, any> = {};

  /**
   * When RateLimitChecker builds queries, it accesses table columns like
   * `tableAny.user_id`, `tableAny.period_type`, etc. Drizzle's eq() function
   * compares a column reference to a value. We can't easily intercept drizzle-orm's
   * real eq/and functions, so instead we override the db.select() chain to match
   * rows by inspecting all rows that could match.
   *
   * Since the RateLimitChecker code uses `and(eq(col, val1), eq(col, val2), ...)`
   * and drizzle-orm's `eq` and `and` produce opaque SQL objects, the simplest
   * approach is to spy on what values are being compared by making the table
   * columns return identifiable markers.
   */

  /**
   * Finds rows matching the given conditions.
   * The conditions map column names to expected values.
   */
  function findMatchingRows(conditions: Record<string, any>): any[] {
    return rows.filter(row => {
      for (const [key, value] of Object.entries(conditions)) {
        if (key === "id") {
          if (row.id !== value) return false;
        } else if (value instanceof Date) {
          if (!(row[key] instanceof Date) || row[key].getTime() !== value.getTime()) {
            return false;
          }
        } else {
          if (row[key] !== value) return false;
        }
      }
      return true;
    });
  }

  // Build a proxy-based mock that intercepts the query chain.
  // We need to handle two query patterns:
  //
  // Pattern 1: select().from(table).where(and(eq(t.user_id, X), eq(t.period_type, Y), eq(t.period_start, Z))).limit(1)
  // Pattern 2: select().from(table).where(and(eq(t.user_id, X), eq(t.period_type, Y))).orderBy(desc(t.period_start)).limit(N)
  // Pattern 3: update(table).set({...}).where(eq(t.id, X))
  //
  // To handle this, we override the entire where() to accept a filter function or
  // alternatively, we intercept eq/and at the module level with vi.mock.
  //
  // The simplest approach: provide a mock where queries always succeed by returning
  // rows from our in-memory store. We track what fields are being queried by
  // registering expected conditions before each test method call.

  let pendingConditions: Record<string, any> | null = null;

  const db: any = {
    select: () => ({
      from: (_table: any) => ({
        where: (_predicate: any) => {
          // Use pendingConditions if set, otherwise return empty
          const matching = pendingConditions
            ? findMatchingRows(pendingConditions)
            : [];
          pendingConditions = null;
          return {
            limit: (n: number) => Promise.resolve(matching.slice(0, n)),
            orderBy: (_desc: any) => ({
              limit: (n: number) => Promise.resolve(matching.slice(0, n)),
            }),
          };
        },
      }),
    }),
    update: (_table: any) => ({
      set: (values: any) => ({
        where: (_pred: any) => {
          // Update matching rows with pendingConditions
          if (pendingConditions) {
            const matching = findMatchingRows(pendingConditions);
            for (const row of matching) {
              Object.assign(row, values);
            }
            pendingConditions = null;
          }
          return Promise.resolve();
        },
      }),
    }),
    insert: (_table: any) => ({
      values: (values: any) => {
        rows.push({ id: "mock-id-" + rows.length, ...values });
        return Promise.resolve();
      },
    }),

    // Test utilities
    _rows: rows,
    _clearRows: () => {
      rows.length = 0;
    },
    _setPendingConditions: (conditions: Record<string, any>) => {
      pendingConditions = conditions;
    },
  };

  return db;
}

const mockTable = {} as any;

/**
 * The RateLimitChecker uses real drizzle-orm eq/and/desc functions that produce
 * SQL AST objects. Our mock DB can't inspect these directly. Instead, we need
 * to use a different strategy: mock the drizzle-orm functions themselves.
 *
 * However, that's complex. A simpler approach for unit testing the checker's
 * logic is to test the public API behavior with a mock that returns specific
 * row data based on the order of queries it receives.
 *
 * RateLimitChecker.checkAndIncrement flow:
 * 1. getCurrentCounts: 3 parallel queries (hourly, daily, monthly)
 * 2. checkLimits: pure logic
 * 3. incrementCounters: N parallel upserts (for each defined limit)
 *
 * Each getCurrentCounts query calls getCountForPeriod which does:
 *   db.select().from(table).where(and(eq(user_id), eq(period_type), eq(period_start))).limit(1)
 *
 * Each incrementPeriodCounter does:
 *   db.select().from(table).where(...).limit(1)  // find existing
 *   then either update or insert
 *
 * We can mock the db to return specific sequences of results.
 */
function createSequenceMockDb() {
  const rows: any[] = [];
  const selectResults: any[][] = [];
  let selectCallIndex = 0;

  const db: any = {
    select: () => ({
      from: (_table: any) => ({
        where: (_predicate: any) => {
          const result = selectResults[selectCallIndex] ?? [];
          selectCallIndex++;
          return {
            limit: (n: number) => Promise.resolve(result.slice(0, n)),
            orderBy: (_desc: any) => ({
              limit: (n: number) => Promise.resolve(result.slice(0, n)),
            }),
          };
        },
      }),
    }),
    update: (_table: any) => ({
      set: (values: any) => ({
        where: (_pred: any) => {
          // Find and update the row
          return Promise.resolve();
        },
      }),
    }),
    insert: (_table: any) => ({
      values: (values: any) => {
        rows.push({ id: "mock-id-" + rows.length, ...values });
        return Promise.resolve();
      },
    }),

    // Test utilities
    _rows: rows,
    _clearRows: () => {
      rows.length = 0;
    },
    _addSelectResult: (result: any[]) => {
      selectResults.push(result);
    },
    _resetSelectIndex: () => {
      selectCallIndex = 0;
      selectResults.length = 0;
    },
  };

  return db;
}

describe("RateLimitChecker", () => {
  describe("checkAndIncrement with zero counts", () => {
    it("should allow request when all counts are zero", async () => {
      const db = createSequenceMockDb();
      // getCurrentCounts: 3 queries, all return empty (count = 0)
      db._addSelectResult([]); // hourly count
      db._addSelectResult([]); // daily count
      db._addSelectResult([]); // monthly count
      // incrementCounters: 3 queries to check existing, all return empty
      db._addSelectResult([]); // hourly existing check
      db._addSelectResult([]); // daily existing check
      db._addSelectResult([]); // monthly existing check

      const checker = new RateLimitChecker({ db, table: mockTable });
      const limits: RateLimits = { hourly: 10, daily: 100, monthly: 1000 };
      const result = await checker.checkAndIncrement("user-1", limits);

      expect(result.allowed).toBe(true);
      expect(result.statusCode).toBe(200);
    });

    it("should return correct remaining values after first request", async () => {
      const db = createSequenceMockDb();
      // getCurrentCounts: all empty
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);
      // incrementCounters: all empty (new inserts)
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);

      const checker = new RateLimitChecker({ db, table: mockTable });
      const limits: RateLimits = { hourly: 10, daily: 100, monthly: 1000 };
      const result = await checker.checkAndIncrement("user-1", limits);

      // After increment: count goes from 0 to 1, so remaining = limit - 1
      expect(result.remaining.hourly).toBe(9);
      expect(result.remaining.daily).toBe(99);
      expect(result.remaining.monthly).toBe(999);
    });
  });

  describe("checkAndIncrement with unlimited limits", () => {
    it("should handle all unlimited (undefined) limits", async () => {
      const db = createSequenceMockDb();
      // getCurrentCounts: all empty
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);
      // No increment queries because all limits are undefined

      const checker = new RateLimitChecker({ db, table: mockTable });
      const limits: RateLimits = {
        hourly: undefined,
        daily: undefined,
        monthly: undefined,
      };
      const result = await checker.checkAndIncrement("user-1", limits);

      expect(result.allowed).toBe(true);
      expect(result.remaining.hourly).toBeUndefined();
      expect(result.remaining.daily).toBeUndefined();
      expect(result.remaining.monthly).toBeUndefined();
    });

    it("should handle partially unlimited limits", async () => {
      const db = createSequenceMockDb();
      // getCurrentCounts: all empty
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);
      // incrementCounters: only hourly and monthly (daily is unlimited)
      db._addSelectResult([]); // hourly existing check
      db._addSelectResult([]); // monthly existing check

      const checker = new RateLimitChecker({ db, table: mockTable });
      const limits: RateLimits = {
        hourly: 5,
        daily: undefined,
        monthly: 100,
      };
      const result = await checker.checkAndIncrement("user-1", limits);

      expect(result.allowed).toBe(true);
      expect(result.remaining.hourly).toBe(4);
      expect(result.remaining.daily).toBeUndefined();
      expect(result.remaining.monthly).toBe(99);
    });
  });

  describe("checkAndIncrement with exceeded limits", () => {
    it("should deny request when hourly limit is reached", async () => {
      const now = new Date();
      const db = createSequenceMockDb();
      // getCurrentCounts: hourly at limit
      db._addSelectResult([
        {
          id: "c1",
          user_id: "user-1",
          period_type: PeriodType.HOURLY,
          period_start: now,
          request_count: 5,
          created_at: now,
          updated_at: now,
        },
      ]);
      db._addSelectResult([]); // daily count = 0
      db._addSelectResult([]); // monthly count = 0
      // No increment queries because check fails

      const checker = new RateLimitChecker({ db, table: mockTable });
      const limits: RateLimits = { hourly: 5, daily: 100, monthly: 1000 };
      const result = await checker.checkAndIncrement("user-1", limits);

      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(429);
      expect(result.exceededLimit).toBe("hourly");
    });

    it("should deny request when daily limit is reached", async () => {
      const now = new Date();
      const db = createSequenceMockDb();
      // getCurrentCounts
      db._addSelectResult([]); // hourly = 0
      db._addSelectResult([
        {
          id: "c1",
          user_id: "user-1",
          period_type: PeriodType.DAILY,
          period_start: now,
          request_count: 20,
          created_at: now,
          updated_at: now,
        },
      ]); // daily at limit
      db._addSelectResult([]); // monthly = 0

      const checker = new RateLimitChecker({ db, table: mockTable });
      const limits: RateLimits = {
        hourly: undefined,
        daily: 20,
        monthly: 1000,
      };
      const result = await checker.checkAndIncrement("user-1", limits);

      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(429);
      expect(result.exceededLimit).toBe("daily");
    });

    it("should deny request when monthly limit is reached", async () => {
      const now = new Date();
      const db = createSequenceMockDb();
      // getCurrentCounts
      db._addSelectResult([]); // hourly = 0
      db._addSelectResult([]); // daily = 0
      db._addSelectResult([
        {
          id: "c1",
          user_id: "user-1",
          period_type: PeriodType.MONTHLY,
          period_start: now,
          request_count: 100,
          created_at: now,
          updated_at: now,
        },
      ]); // monthly at limit

      const checker = new RateLimitChecker({ db, table: mockTable });
      const limits: RateLimits = {
        hourly: undefined,
        daily: undefined,
        monthly: 100,
      };
      const result = await checker.checkAndIncrement("user-1", limits);

      expect(result.allowed).toBe(false);
      expect(result.statusCode).toBe(429);
      expect(result.exceededLimit).toBe("monthly");
    });

    it("should return remaining of 0 (not negative) when count exceeds limit", async () => {
      const now = new Date();
      const db = createSequenceMockDb();
      // Count is higher than limit (e.g., limit was lowered after usage)
      db._addSelectResult([
        {
          id: "c1",
          user_id: "user-1",
          period_type: PeriodType.HOURLY,
          period_start: now,
          request_count: 15,
          created_at: now,
          updated_at: now,
        },
      ]);
      db._addSelectResult([]);
      db._addSelectResult([]);

      const checker = new RateLimitChecker({ db, table: mockTable });
      const limits: RateLimits = { hourly: 10, daily: 100, monthly: 1000 };
      const result = await checker.checkAndIncrement("user-1", limits);

      expect(result.allowed).toBe(false);
      expect(result.remaining.hourly).toBe(0); // not -5
    });
  });

  describe("checkAndIncrement should include limits in result", () => {
    it("should include the limits object in the result", async () => {
      const db = createSequenceMockDb();
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);

      const checker = new RateLimitChecker({ db, table: mockTable });
      const limits: RateLimits = { hourly: 10, daily: 50, monthly: 200 };
      const result = await checker.checkAndIncrement("user-1", limits);

      expect(result.limits).toEqual(limits);
    });
  });

  describe("checkOnly", () => {
    it("should return current status without incrementing", async () => {
      const db = createSequenceMockDb();
      // getCurrentCounts: all empty
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);

      const checker = new RateLimitChecker({ db, table: mockTable });
      const limits: RateLimits = { hourly: 10, daily: 100, monthly: 1000 };
      const result = await checker.checkOnly("user-1", limits);

      expect(result.allowed).toBe(true);
      expect(result.remaining.hourly).toBe(10);
      expect(result.remaining.daily).toBe(100);
      expect(result.remaining.monthly).toBe(1000);

      // checkOnly should not insert any rows
      expect(db._rows.length).toBe(0);
    });

    it("should report exceeded when at limit without incrementing", async () => {
      const now = new Date();
      const db = createSequenceMockDb();
      db._addSelectResult([
        {
          id: "c1",
          user_id: "user-1",
          period_type: PeriodType.HOURLY,
          period_start: now,
          request_count: 10,
          created_at: now,
          updated_at: now,
        },
      ]);
      db._addSelectResult([]);
      db._addSelectResult([]);

      const checker = new RateLimitChecker({ db, table: mockTable });
      const limits: RateLimits = { hourly: 10, daily: 100, monthly: 1000 };
      const result = await checker.checkOnly("user-1", limits);

      expect(result.allowed).toBe(false);
      expect(result.exceededLimit).toBe("hourly");
      // Should not have inserted any new rows
      expect(db._rows.length).toBe(0);
    });
  });

  describe("increment behavior", () => {
    it("should insert new counter rows when none exist", async () => {
      const db = createSequenceMockDb();
      // getCurrentCounts
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);
      // incrementCounters: existing check returns empty (inserts)
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);

      const checker = new RateLimitChecker({ db, table: mockTable });
      const limits: RateLimits = { hourly: 10, daily: 100, monthly: 1000 };
      await checker.checkAndIncrement("user-1", limits);

      // Should have inserted rows for hourly, daily, and monthly
      const insertedRows = db._rows.filter(
        (r: any) => r.request_count === 1
      );
      expect(insertedRows.length).toBe(3);
    });

    it("should not increment counters for unlimited periods", async () => {
      const db = createSequenceMockDb();
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);
      // No increment queries

      const checker = new RateLimitChecker({ db, table: mockTable });
      const limits: RateLimits = {
        hourly: undefined,
        daily: undefined,
        monthly: undefined,
      };
      await checker.checkAndIncrement("user-1", limits);

      // No rows should be inserted
      expect(db._rows.length).toBe(0);
    });

    it("should only increment counters for defined limits", async () => {
      const db = createSequenceMockDb();
      // getCurrentCounts
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);
      // incrementCounters: only hourly and monthly (daily is undefined)
      db._addSelectResult([]); // hourly existing check
      db._addSelectResult([]); // monthly existing check

      const checker = new RateLimitChecker({ db, table: mockTable });
      const limits: RateLimits = {
        hourly: 10,
        daily: undefined,
        monthly: 100,
      };
      await checker.checkAndIncrement("user-1", limits);

      // Should have inserted rows for hourly and monthly only
      const periodTypes = db._rows.map((r: any) => r.period_type);
      expect(periodTypes).toContain(PeriodType.HOURLY);
      expect(periodTypes).toContain(PeriodType.MONTHLY);
      expect(periodTypes).not.toContain(PeriodType.DAILY);
    });
  });

  describe("subscription-based monthly periods", () => {
    it("should use calendar month start when no subscription", async () => {
      const db = createSequenceMockDb();
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]); // monthly existing check

      const checker = new RateLimitChecker({ db, table: mockTable });
      const limits: RateLimits = {
        hourly: undefined,
        daily: undefined,
        monthly: 100,
      };
      await checker.checkAndIncrement("user-1", limits, null);

      // The monthly row should have period_start on the 1st of the month
      const monthlyRow = db._rows.find(
        (r: any) => r.period_type === PeriodType.MONTHLY
      );
      expect(monthlyRow).toBeDefined();
      expect(monthlyRow.period_start.getUTCDate()).toBe(1);
    });

    it("should use subscription-based month start when subscription exists", async () => {
      const db = createSequenceMockDb();
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]); // monthly existing check

      const checker = new RateLimitChecker({ db, table: mockTable });
      const subStart = new Date("2025-03-15T10:00:00Z");
      const limits: RateLimits = {
        hourly: undefined,
        daily: undefined,
        monthly: 100,
      };
      await checker.checkAndIncrement("user-1", limits, subStart);

      const monthlyRow = db._rows.find(
        (r: any) => r.period_type === PeriodType.MONTHLY
      );
      expect(monthlyRow).toBeDefined();
      // Period start day should be based on subscription day 15
      // (or adjusted for shorter months)
      const periodDay = monthlyRow.period_start.getUTCDate();
      expect(periodDay).toBeLessThanOrEqual(15);
    });
  });

  describe("different tiers", () => {
    it("should enforce free tier limits (low)", async () => {
      const db = createSequenceMockDb();
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);

      const checker = new RateLimitChecker({ db, table: mockTable });
      const freeLimits: RateLimits = { hourly: 2, daily: 5, monthly: 20 };
      const result = await checker.checkAndIncrement("free-user", freeLimits);

      expect(result.allowed).toBe(true);
      expect(result.remaining.hourly).toBe(1);
      expect(result.remaining.daily).toBe(4);
      expect(result.remaining.monthly).toBe(19);
    });

    it("should enforce pro tier limits (high)", async () => {
      const db = createSequenceMockDb();
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]); // only hourly increment

      const checker = new RateLimitChecker({ db, table: mockTable });
      const proLimits: RateLimits = {
        hourly: 100,
        daily: undefined,
        monthly: undefined,
      };
      const result = await checker.checkAndIncrement("pro-user", proLimits);

      expect(result.allowed).toBe(true);
      expect(result.remaining.hourly).toBe(99);
      expect(result.remaining.daily).toBeUndefined();
      expect(result.remaining.monthly).toBeUndefined();
    });

    it("should allow all requests for enterprise tier (unlimited)", async () => {
      const db = createSequenceMockDb();
      db._addSelectResult([]);
      db._addSelectResult([]);
      db._addSelectResult([]);

      const checker = new RateLimitChecker({ db, table: mockTable });
      const enterpriseLimits: RateLimits = {
        hourly: undefined,
        daily: undefined,
        monthly: undefined,
      };
      const result = await checker.checkAndIncrement(
        "enterprise-user",
        enterpriseLimits
      );

      expect(result.allowed).toBe(true);
      expect(result.remaining.hourly).toBeUndefined();
      expect(result.remaining.daily).toBeUndefined();
      expect(result.remaining.monthly).toBeUndefined();
    });
  });

  describe("getHistory", () => {
    it("should return empty entries when no history exists", async () => {
      const db = createSequenceMockDb();
      db._addSelectResult([]);

      const checker = new RateLimitChecker({ db, table: mockTable });
      const history = await checker.getHistory(
        "user-1",
        PeriodType.HOURLY,
        null,
        100
      );

      expect(history.user_id).toBe("user-1");
      expect(history.period_type).toBe(PeriodType.HOURLY);
      expect(history.entries).toEqual([]);
    });

    it("should return history entries with period_end calculated for hourly", async () => {
      const periodStart = new Date("2025-06-15T14:00:00Z");
      const db = createSequenceMockDb();
      db._addSelectResult([
        {
          id: "h1",
          user_id: "user-1",
          period_type: PeriodType.HOURLY,
          period_start: periodStart,
          request_count: 5,
          created_at: periodStart,
          updated_at: periodStart,
        },
      ]);

      const checker = new RateLimitChecker({ db, table: mockTable });
      const history = await checker.getHistory(
        "user-1",
        PeriodType.HOURLY,
        null,
        100
      );

      expect(history.entries.length).toBe(1);
      expect(history.entries[0]!.request_count).toBe(5);
      expect(history.entries[0]!.period_start).toEqual(periodStart);
      expect(history.entries[0]!.period_end).toEqual(
        new Date("2025-06-15T15:00:00Z")
      );
    });

    it("should calculate daily period end correctly", async () => {
      const periodStart = new Date("2025-06-15T00:00:00Z");
      const db = createSequenceMockDb();
      db._addSelectResult([
        {
          id: "h1",
          user_id: "user-1",
          period_type: PeriodType.DAILY,
          period_start: periodStart,
          request_count: 10,
          created_at: periodStart,
          updated_at: periodStart,
        },
      ]);

      const checker = new RateLimitChecker({ db, table: mockTable });
      const history = await checker.getHistory(
        "user-1",
        PeriodType.DAILY,
        null,
        100
      );

      expect(history.entries.length).toBe(1);
      expect(history.entries[0]!.period_end).toEqual(
        new Date("2025-06-16T00:00:00Z")
      );
    });

    it("should calculate monthly period end correctly with subscription", async () => {
      const periodStart = new Date("2025-06-05T00:00:00Z");
      const db = createSequenceMockDb();
      db._addSelectResult([
        {
          id: "h1",
          user_id: "user-1",
          period_type: PeriodType.MONTHLY,
          period_start: periodStart,
          request_count: 50,
          created_at: periodStart,
          updated_at: periodStart,
        },
      ]);

      const subStart = new Date("2025-03-05T10:00:00Z");
      const checker = new RateLimitChecker({ db, table: mockTable });
      const history = await checker.getHistory(
        "user-1",
        PeriodType.MONTHLY,
        subStart,
        100
      );

      expect(history.entries.length).toBe(1);
      expect(history.entries[0]!.period_end).toEqual(
        new Date("2025-07-05T00:00:00Z")
      );
    });
  });

  describe("priority of limit checks", () => {
    it("should report hourly as exceeded when both hourly and daily are at limit", async () => {
      const now = new Date();
      const db = createSequenceMockDb();
      // Both hourly and daily at limit
      db._addSelectResult([
        {
          id: "c1",
          user_id: "user-1",
          period_type: PeriodType.HOURLY,
          period_start: now,
          request_count: 5,
          created_at: now,
          updated_at: now,
        },
      ]);
      db._addSelectResult([
        {
          id: "c2",
          user_id: "user-1",
          period_type: PeriodType.DAILY,
          period_start: now,
          request_count: 5,
          created_at: now,
          updated_at: now,
        },
      ]);
      db._addSelectResult([]);

      const checker = new RateLimitChecker({ db, table: mockTable });
      const limits: RateLimits = { hourly: 5, daily: 5, monthly: 1000 };
      const result = await checker.checkAndIncrement("user-1", limits);

      expect(result.allowed).toBe(false);
      // Hourly is checked first, so it should be reported as the exceeded limit
      expect(result.exceededLimit).toBe("hourly");
    });

    it("should report daily when hourly is fine but daily is exceeded", async () => {
      const now = new Date();
      const db = createSequenceMockDb();
      db._addSelectResult([]); // hourly = 0
      db._addSelectResult([
        {
          id: "c1",
          user_id: "user-1",
          period_type: PeriodType.DAILY,
          period_start: now,
          request_count: 20,
          created_at: now,
          updated_at: now,
        },
      ]);
      db._addSelectResult([]); // monthly = 0

      const checker = new RateLimitChecker({ db, table: mockTable });
      const limits: RateLimits = { hourly: 10, daily: 20, monthly: 1000 };
      const result = await checker.checkAndIncrement("user-1", limits);

      expect(result.allowed).toBe(false);
      expect(result.exceededLimit).toBe("daily");
    });
  });
});
