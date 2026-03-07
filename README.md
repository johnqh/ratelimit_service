# @sudobility/ratelimit_service

Shared rate limiting backend library based on RevenueCat entitlements with Hono middleware and Drizzle ORM schema.

## Installation

```bash
bun add @sudobility/ratelimit_service
```

### Peer Dependencies

- `drizzle-orm`
- `hono`

## Usage

```typescript
import {
  RevenueCatHelper,
  EntitlementHelper,
  RateLimitChecker,
  createRateLimitMiddleware,
} from '@sudobility/ratelimit_service';
import { rateLimitCounters } from '@sudobility/ratelimit_service/schema';

// Middleware setup
const middleware = createRateLimitMiddleware({
  revenueCatApiKey: process.env.REVENUECAT_API_KEY!,
  rateLimitsConfig: {
    none: { hourly: 5, daily: 20, monthly: 100 },
    pro: { hourly: undefined, daily: undefined, monthly: undefined },
  },
  db,
});
```

## API

### Key Classes

| Class | Purpose | Key Method |
|-------|---------|------------|
| `RevenueCatHelper` | Fetch user entitlements from RevenueCat API | `getSubscriptionInfo(userId)` |
| `EntitlementHelper` | Map entitlements to rate limits | `getRateLimits(entitlements)` |
| `RateLimitChecker` | Check limits and increment DB counters | `checkAndIncrement(userId, limits, subscriptionStartedAt)` |
| `RateLimitRouteHandler` | HTTP route handler for rate limit queries | Configured via `RateLimitRouteHandlerConfig` |

### Middleware

`createRateLimitMiddleware(config)` -- Hono middleware factory

### Schema

`rateLimitCounters` -- Drizzle schema template (consumers copy to their own `db/schema.ts`)

### Sub-path Exports

- `@sudobility/ratelimit_service` -- main entry (classes, types, utilities)
- `@sudobility/ratelimit_service/middleware/hono` -- middleware only
- `@sudobility/ratelimit_service/schema` -- Drizzle schema

### Key Types

`RateLimits`, `RateLimitsConfig`, `RateLimitCheckResult`, `PeriodType`

## Development

```bash
bun run verify       # All checks + build (typecheck -> lint -> test -> build)
bun test             # Run tests
bun run lint         # ESLint
bun run typecheck    # TypeScript check
bun run build        # Build ESM + CJS
```

## License

BUSL-1.1
