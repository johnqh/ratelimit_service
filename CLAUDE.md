# Subscription Service

Shared rate limiting library based on RevenueCat entitlements.

**npm**: `@sudobility/ratelimit_service` (public)

## Tech Stack

- **Language**: TypeScript (strict mode)
- **Build**: Dual ESM/CJS output
- **Runtime**: Bun
- **Package Manager**: Bun (do not use npm/yarn/pnpm for installing dependencies)
- **Testing**: bun:test
- **Peer Dependencies**: drizzle-orm, hono

## Commands

```bash
bun run verify       # All checks + build (use before commit)
bun test             # Run tests
bun run lint         # ESLint
bun run typecheck    # TypeScript check
bun run build        # Build ESM + CJS
```

## Project Structure

```
src/
├── index.ts                    # Main exports (re-exports from all modules)
├── types/
│   ├── index.ts                # Type re-exports
│   ├── rate-limits.ts          # RateLimits, RateLimitsConfig
│   ├── entitlements.ts         # RevenueCat types, NONE_ENTITLEMENT constant
│   └── responses.ts            # RateLimitCheckResult, PeriodType enum
├── schema/
│   └── rate-limits.ts          # Drizzle schema template (consumers copy this)
├── helpers/
│   ├── index.ts                # Helper re-exports
│   ├── RevenueCatHelper.ts     # Fetches entitlements from RevenueCat API
│   ├── EntitlementHelper.ts    # Resolves rate limits from entitlements
│   └── RateLimitChecker.ts     # Checks/increments counters in database
├── middleware/
│   └── hono.ts                 # createRateLimitMiddleware factory
└── utils/
    └── time.ts                 # Period calculation utilities
tests/
├── EntitlementHelper.test.ts   # Unit tests for EntitlementHelper
└── time.test.ts                # Unit tests for time utilities
```

## Architecture

### Data Flow
```
Request → Middleware → RevenueCatHelper → EntitlementHelper → RateLimitChecker → Response
                      (fetch entitlements) (resolve limits)   (check/increment DB)
```

### Key Classes

| Class | Purpose | Key Method |
|-------|---------|------------|
| `RevenueCatHelper` | Fetch user entitlements from RevenueCat API | `getSubscriptionInfo(userId)` |
| `EntitlementHelper` | Map entitlements to rate limits | `getRateLimits(entitlements)` |
| `RateLimitChecker` | Check limits and increment counters | `checkAndIncrement(userId, limits, subscriptionStartedAt)` |

### Export Structure (package.json exports)
```typescript
// Main entry: "@sudobility/ratelimit_service"
export { RevenueCatHelper, EntitlementHelper, RateLimitChecker, createRateLimitMiddleware }
export type { RateLimits, RateLimitsConfig, RateLimitCheckResult, ... }

// Middleware: "@sudobility/ratelimit_service/middleware/hono"
export { createRateLimitMiddleware }

// Schema: "@sudobility/ratelimit_service/schema"
export { rateLimitCounters }
```

## Business Logic

### Rate Limits
- `undefined` = unlimited (no limit for that period)
- Limits checked in order: hourly → daily → monthly
- Multiple entitlements: upper-bound (most permissive) wins

### Entitlement Resolution
```typescript
const config: RateLimitsConfig = {
  none: { hourly: 5, daily: 20, monthly: 100 },      // Required fallback
  starter: { hourly: 10, daily: 50, monthly: 500 },
  pro: { hourly: undefined, daily: undefined, monthly: undefined }, // unlimited
};

// Multiple entitlements → upper bound
getRateLimits(["starter", "pro"]) // → { hourly: undefined, daily: undefined, monthly: undefined }
```

### Subscription Month Calculation
Monthly periods are based on subscription start date, not calendar months:
- Subscription started March 5 → months are 3/5-4/4, 4/5-5/4, etc.
- Day overflow handled (Jan 31 → Feb 28 in non-leap year)
- No subscription → falls back to calendar month (1st of month)

### Database Schema
Uses period-based counters with history preservation:
- One row per (user_id, period_type, period_start)
- period_type: 'hourly' | 'daily' | 'monthly'
- Old periods NOT deleted (enables usage history UI)

## Coding Patterns

### Type Imports
```typescript
import type { RateLimits, RateLimitsConfig } from "../types/rate-limits";
import { NONE_ENTITLEMENT } from "../types/entitlements";
```

### Error Handling in Helpers
- RevenueCat 404 → return `["none"]` (user not found = no subscription)
- RevenueCat other errors → throw (let middleware handle)
- Unknown entitlement → fall back to "none" limits

### Testing Pattern
```typescript
import { describe, it, expect } from "bun:test";

describe("ClassName", () => {
  describe("methodName", () => {
    it("should do something", () => {
      // Arrange
      const helper = new ClassName(config);
      // Act
      const result = helper.method(input);
      // Assert
      expect(result).toEqual(expected);
    });
  });
});
```

### Time Utilities
All periods calculated in UTC:
```typescript
getCurrentHourStart(now)           // 14:35:22Z → 14:00:00Z
getCurrentDayStart(now)            // 2025-01-15T14:35Z → 2025-01-15T00:00Z
getSubscriptionMonthStart(subStart, now)  // Based on subscription day
```

## Consuming APIs

This library is used by:
- sudojo_api
- shapeshyft_api
- whisperly_api

Consumers must:
1. Copy schema from `@sudobility/ratelimit_service/schema` to their db/schema.ts
2. Run migrations to create the `rate_limit_counters` table
3. Configure middleware with their RevenueCat API key and rate limits config

## Workspace Context

This project is part of the **ShapeShyft** multi-project workspace at the parent directory. See `../CLAUDE.md` for the full architecture, dependency graph, and build order.

## Downstream Impact

| Downstream Consumer | Relationship |
|---------------------|-------------|
| `shapeshyft_api` | Direct dependency - uses rate limit middleware and schema |

After making changes:
1. `bun run verify` in this project (includes tests)
2. `npm publish`
3. In `shapeshyft_api`: `bun update @sudobility/ratelimit_service` then rebuild

If you change the Drizzle schema template, downstream consumers must update their copied schema and run database migrations.

## Local Dev Workflow

```bash
# In this project:
bun link

# In shapeshyft_api:
bun link @sudobility/ratelimit_service

# Rebuild after changes:
bun run build

# When done, unlink:
bun unlink @sudobility/ratelimit_service && bun install
```

## Pre-Commit Checklist

```bash
bun run verify    # Runs: typecheck -> lint -> test -> build
```

## Gotchas

- **The title at the top of this file says "Subscription Service" but this is the Rate Limit Service** -- known copy-paste error.
- **Schema is a template, not a migration** -- consumers must copy it to their own `db/schema.ts`. Changes here do NOT automatically propagate.
- **`undefined` means unlimited** -- in rate limit configs, `undefined` for a period means no limit. Do not confuse with `0` (zero allowed).
- **Monthly periods are subscription-relative, not calendar-relative** -- intentional. Calendar-month fallback only applies when `subscriptionStartedAt` is null.
- **Multiple entitlements resolve to upper bound** -- the most permissive limit wins.
