# poc_sliding_window_rate_limit

Redis-first Node.js + TypeScript proof-of-concept for enforcing mailbox/API limits in distributed pods.

## What this project does

`RedisRateLimitEngine` enforces these limits with Redis as the shared state:

1. 4 parallel in-flight requests per mailbox
2. 130,000 requests per 10 seconds (global)
3. 10,000 requests per 10 minutes per app+user
4. 30 messages per minute per mailbox
5. 10,000 recipients per day per mailbox
   - exceeding starts a 24-hour penalty window
6. 150 MB upload traffic per 5 minutes per mailbox
7. 4 MB per message payload
8. 500 recipients/message by default, optional 1000 override
9. 60 MiB payload cap for 501-1000 recipient batches
10. upload session age check (~7 days)

## Project layout

- `src/RedisRateLimitEngine.ts`: distributed Redis-backed limiter
- `src/limits.ts`: shared numeric limits/windows
- `src/types.ts`: request and decision contracts
- `src/demo.ts`: Redis-backed runnable demo
- `test/rateLimitEngine.spec.ts`: Redis engine tests (fake Redis client)
- `.env.example`: local configuration template

## Redis env variables

Copy `.env.example` and set values:

- `REDIS_CLUSTER=false`
- `REDIS_HOST=localhost`
- `REDIS_USER=dev-zenithmaster`
- `REDIS_PASSWORD=REDISPASSWORD`
- `REDIS_PORT=6376`
- `REDIS_HEALTH_TIMEOUT=500`
- `REDIS_KEY_PREFIX=rl:poc`
- `REDIS_CONCURRENCY_LEASE_MS=1800000`
- `ALLOW_UP_TO_1000_RECIPIENTS_PER_MESSAGE=true`

## Quick start

```bash
npm install
npm run test
REDIS_HOST=localhost REDIS_PORT=6376 REDIS_USER=dev-zenithmaster REDIS_PASSWORD=REDISPASSWORD npm run start
```

## Redis key model

For mailbox `mailbox-42` and prefix `rl:poc`:

- `rl:poc:global:req:10s`
- `rl:poc:appuser:<appId>:<userId>:req:10m`
- `rl:poc:mailbox:mailbox-42:msg:1m`
- `rl:poc:mailbox:mailbox-42:recipients:1d`
- `rl:poc:mailbox:mailbox-42:upload:5m`
- `rl:poc:mailbox:mailbox-42:recipient-penalty`
- `rl:poc:mailbox:mailbox-42:concurrency`

## Notes

- This is still a POC.
- Lua is intentionally minimal (atomic acquire/release only).
- Tests do not need a live Redis instance; the demo does.
