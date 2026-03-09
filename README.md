# poc_sliding_window_rate_limit

Node.js + TypeScript proof-of-concept for enforcing mixed mailbox/API limits with:

- semaphore-based concurrency control (4 parallel requests per mailbox)
- sliding-window rate limiting for request/message/recipient/upload rules
- mailbox penalty lock for recipient-day overflow (24h)

## Why this design

Some limits are **"requests over time"** (good fit for sliding windows), but mailbox concurrency is **"how many are running right now"** (needs a semaphore/lock). This POC now has:

- `RateLimitEngine` for in-memory single-instance mode
- `RedisRateLimitEngine` for distributed multi-pod mode

## Implemented limits

1. **Concurrency**: max 4 in-flight requests per mailbox (semaphore in-memory, Redis counter distributed)
2. **Global**: 130,000 requests / 10 seconds
3. **Per app+user**: 10,000 requests / 10 minutes
4. **Per mailbox messages**: 30 messages / minute
5. **Per mailbox recipients/day**: 10,000 recipients/day
   - if exceeded, a 24h penalty window starts immediately
6. **Per mailbox upload traffic**: 150 MB / 5 minutes
7. **Per message payload**: 4 MB max
8. **Recipient cap per message**:
   - 500 default
   - optional 1000 with config (`allowUpTo1000RecipientsPerMessage: true`)
9. **Large recipient batch payload rule**:
   - when recipients are 501-1000, payload must be <= 60 MiB
10. **Upload session TTL check (optional input)**:
    - if provided, upload sessions older than ~7 days are treated as expired

## Project layout

- `src/RateLimitEngine.ts`: in-memory policy engine
- `src/RedisRateLimitEngine.ts`: Redis distributed policy engine (single Redis, non-cluster)
- `src/limits.ts`: shared limits/windows constants
- `src/limiting/SlidingWindowCounter.ts`: generic rolling-window accumulator (in-memory)
- `src/limiting/ConcurrencySemaphore.ts`: mailbox in-flight gate (in-memory)
- `src/types.ts`: request/decision types
- `src/demo.ts`: runnable Redis simulation examples
- `test/rateLimitEngine.spec.ts`: deterministic tests

## Distributed mode with Redis

The Redis engine keeps most policy logic in TypeScript and uses small Lua scripts only for atomic concurrency acquire/release.

- JS performs window pruning, counting/summing, penalty checks, and accepted-event commits
- Lua only protects in-flight permit increments/decrements across pods
- TTLs are used to clean stale window keys automatically

### Redis key model

Given prefix `rl:poc` and mailbox `mailbox-42`, keys are:

- `rl:poc:global:req:10s`
- `rl:poc:appuser:<appId>:<userId>:req:10m`
- `rl:poc:mailbox:mailbox-42:msg:1m`
- `rl:poc:mailbox:mailbox-42:recipients:1d`
- `rl:poc:mailbox:mailbox-42:upload:5m`
- `rl:poc:mailbox:mailbox-42:recipient-penalty`
- `rl:poc:mailbox:mailbox-42:concurrency`

### .env variables

Create `.env` from `.env.example` and fill values for your environment:

- `RATE_LIMIT_BACKEND=in-memory|redis`
- `REDIS_CLUSTER=false`
- `REDIS_HOST=localhost`
- `REDIS_PORT=6376`
- `REDIS_USER=dev-zenithmaster`
- `REDIS_PASSWORD=REDISPASSWORD`
- `REDIS_HEALTH_TIMEOUT=500`
- `REDIS_KEY_PREFIX=rl:poc`
- `REDIS_CONCURRENCY_LEASE_MS=1800000`
- `ALLOW_UP_TO_1000_RECIPIENTS_PER_MESSAGE=true`

### Redis engine usage example

```ts
import { createClient } from "redis";
import { RedisRateLimitEngine } from "./src/RedisRateLimitEngine";

const redis = createClient({
  username: process.env.REDIS_USER,
  password: process.env.REDIS_PASSWORD,
  socket: {
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
    connectTimeout: Number(process.env.REDIS_HEALTH_TIMEOUT ?? 5000)
  }
});
await redis.connect();

const engine = new RedisRateLimitEngine(redis, {
  redisKeyPrefix: process.env.REDIS_KEY_PREFIX,
  concurrencyLeaseMs: Number(process.env.REDIS_CONCURRENCY_LEASE_MS ?? 1800000),
  allowUpTo1000RecipientsPerMessage:
    process.env.ALLOW_UP_TO_1000_RECIPIENTS_PER_MESSAGE === "true"
});

const decision = await engine.evaluate({
  appId: "my-app",
  userId: "user-42",
  mailboxId: "mailbox-42",
  kind: "sendMessage",
  recipientCount: 10,
  payloadBytes: 128 * 1024
});

if (decision.allowed) {
  try {
    // Execute API call.
  } finally {
    await decision.releaseConcurrency?.();
  }
}
```

## Install, build, run

```bash
npm install
npm run build
npm run test
REDIS_HOST=localhost REDIS_PORT=6376 REDIS_USER=dev-zenithmaster REDIS_PASSWORD=REDISPASSWORD npm run start
```

The demo (`src/demo.ts`) now uses `RedisRateLimitEngine`, so it expects a reachable Redis instance.

## Minimal usage example

```ts
import { RateLimitEngine } from "./src/RateLimitEngine";

const engine = new RateLimitEngine({
  allowUpTo1000RecipientsPerMessage: true
});

const decision = engine.evaluate({
  appId: "my-app",
  userId: "user-42",
  mailboxId: "mailbox-42",
  kind: "sendMessage",
  recipientCount: 10,
  payloadBytes: 128 * 1024
});

if (!decision.allowed) {
  console.log("Blocked:", decision.reason, "retryAfterMs:", decision.retryAfterMs);
} else {
  try {
    // Execute API call.
  } finally {
    decision.releaseConcurrency?.();
  }
}
```

## Notes and assumptions

- This is still a **POC**.
- Redis mode assumes a single Redis deployment (non-cluster), as requested.
- For high throughput, parsing member payloads in Lua can be optimized later with bucketed counters.
- "Common OneDrive limits" are referenced but not fully modeled here because they depend on external service behavior and tenant configuration.
- Upload attachments count toward the 150 MB / 5 min budget per mailbox.

## Next production upgrades

1. Add heartbeat/lease renewal for long-running requests.
2. Move Lua scripts to separate files and preload SHA hashes.
3. Add Redis integration tests behind an opt-in flag.
4. Add metrics + traces (permit wait/reject rates/penalty activations).
