/**
 * Drizzle schema and database initialization for rate limit tracking.
 *
 * Provides:
 * - createRateLimitCountersTable: Factory for Drizzle table with custom schema
 * - initRateLimitTable: SQL initialization for the table
 * - Default rateLimitCounters table for public schema
 */

import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Create a rate limit counters table for a specific PostgreSQL schema.
 *
 * @param schema - The Drizzle pgSchema object (e.g., pgSchema("shapeshyft"))
 * @param indexPrefix - Prefix for index names to avoid conflicts
 * @returns Drizzle table definition
 *
 * @example
 * ```typescript
 * import { pgSchema } from "drizzle-orm/pg-core";
 * import { createRateLimitCountersTable } from "@sudobility/ratelimit_service";
 *
 * const mySchema = pgSchema("myapp");
 * export const rateLimitCounters = createRateLimitCountersTable(mySchema, "myapp");
 * ```
 */
export function createRateLimitCountersTable(
  schema: any,
  indexPrefix: string
) {
  return schema.table(
    "rate_limit_counters",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      user_id: varchar("user_id", { length: 128 }).notNull(),
      period_type: varchar("period_type", { length: 16 }).notNull(),
      period_start: timestamp("period_start", { withTimezone: true }).notNull(),
      request_count: integer("request_count").notNull().default(0),
      created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
      updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    },
    (table: any) => ({
      userPeriodUniqueIdx: uniqueIndex(`${indexPrefix}_rate_limit_user_period_idx`).on(
        table.user_id,
        table.period_type,
        table.period_start
      ),
      userTypeIdx: index(`${indexPrefix}_rate_limit_user_type_idx`).on(
        table.user_id,
        table.period_type
      ),
    })
  );
}

/**
 * Create a rate limit counters table for the public schema.
 *
 * @param indexPrefix - Prefix for index names
 * @returns Drizzle table definition
 *
 * @example
 * ```typescript
 * import { createRateLimitCountersTablePublic } from "@sudobility/ratelimit_service";
 *
 * export const rateLimitCounters = createRateLimitCountersTablePublic("sudojo");
 * ```
 */
export function createRateLimitCountersTablePublic(indexPrefix: string) {
  return pgTable(
    "rate_limit_counters",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      user_id: varchar("user_id", { length: 128 }).notNull(),
      period_type: varchar("period_type", { length: 16 }).notNull(),
      period_start: timestamp("period_start", { withTimezone: true }).notNull(),
      request_count: integer("request_count").notNull().default(0),
      created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
      updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    },
    table => ({
      userPeriodUniqueIdx: uniqueIndex(`${indexPrefix}_rate_limit_user_period_idx`).on(
        table.user_id,
        table.period_type,
        table.period_start
      ),
      userTypeIdx: index(`${indexPrefix}_rate_limit_user_type_idx`).on(
        table.user_id,
        table.period_type
      ),
    })
  );
}

/**
 * Default rate limit counters table for public schema.
 * Use createRateLimitCountersTable for custom schemas.
 */
export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: varchar("user_id", { length: 128 }).notNull(),
    period_type: varchar("period_type", { length: 16 }).notNull(),
    period_start: timestamp("period_start", { withTimezone: true }).notNull(),
    request_count: integer("request_count").notNull().default(0),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  table => ({
    userPeriodUniqueIdx: uniqueIndex("rate_limit_counters_user_period_idx").on(
      table.user_id,
      table.period_type,
      table.period_start
    ),
    userTypeIdx: index("rate_limit_counters_user_type_idx").on(
      table.user_id,
      table.period_type
    ),
  })
);

/**
 * TypeScript type for the rate_limit_counters table row (select)
 */
export type RateLimitCounterRecord = typeof rateLimitCounters.$inferSelect;

/**
 * TypeScript type for inserting into rate_limit_counters table
 */
export type NewRateLimitCounterRecord = typeof rateLimitCounters.$inferInsert;

/**
 * Initialize the rate limit counters table in the database.
 *
 * @param client - postgres-js client instance
 * @param schemaName - PostgreSQL schema name (e.g., "shapeshyft", "whisperly", or null for public)
 * @param indexPrefix - Prefix for index names to avoid conflicts
 *
 * @example
 * ```typescript
 * import postgres from "postgres";
 * import { initRateLimitTable } from "@sudobility/ratelimit_service";
 *
 * const client = postgres(connectionString);
 *
 * // For public schema
 * await initRateLimitTable(client, null, "sudojo");
 *
 * // For custom schema
 * await initRateLimitTable(client, "shapeshyft", "shapeshyft");
 * ```
 */
export async function initRateLimitTable(
  client: ReturnType<typeof import("postgres")>,
  schemaName: string | null,
  indexPrefix: string
): Promise<void> {
  const tableName = schemaName
    ? `${schemaName}.rate_limit_counters`
    : "rate_limit_counters";

  const uniqueIdxName = `${indexPrefix}_rate_limit_user_period_idx`;
  const typeIdxName = `${indexPrefix}_rate_limit_user_type_idx`;

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id VARCHAR(128) NOT NULL,
      period_type VARCHAR(16) NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${uniqueIdxName}
    ON ${tableName} (user_id, period_type, period_start)
  `);

  await client.unsafe(`
    CREATE INDEX IF NOT EXISTS ${typeIdxName}
    ON ${tableName} (user_id, period_type)
  `);
}
