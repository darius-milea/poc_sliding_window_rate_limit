import { createClient } from "redis";
import { RedisRateLimitEngine } from "./RedisRateLimitEngine";

const MB = 1024 * 1024;

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return defaultValue;
  }

  return value.toLowerCase() === "true";
}

async function main(): Promise<void> {
  const redisCluster = readBooleanEnv("REDIS_CLUSTER", false);
  if (redisCluster) {
    throw new Error("REDIS_CLUSTER=true is not supported in this demo. Use a single Redis node.");
  }

  const redisHost = process.env.REDIS_HOST ?? "localhost";
  const redisPort = Number(process.env.REDIS_PORT ?? 6379);
  const redisUser = process.env.REDIS_USER;
  const redisPassword = process.env.REDIS_PASSWORD;
  const redisHealthTimeoutMs = Number(process.env.REDIS_HEALTH_TIMEOUT ?? 5000);

  const redis = createClient({
    username: redisUser,
    password: redisPassword,
    socket: {
      host: redisHost,
      port: redisPort,
      connectTimeout: redisHealthTimeoutMs
    }
  });

  redis.on("error", (error) => {
    console.error("Redis client error:", error);
  });

  await redis.connect();

  const engine = new RedisRateLimitEngine(redis, {
    redisKeyPrefix: process.env.REDIS_KEY_PREFIX ?? "rl:poc:demo",
    concurrencyLeaseMs: Number(process.env.REDIS_CONCURRENCY_LEASE_MS ?? 30 * 60 * 1000),
    allowUpTo1000RecipientsPerMessage:
      process.env.ALLOW_UP_TO_1000_RECIPIENTS_PER_MESSAGE !== "false"
  });

  try {
    console.log("=== Demo: concurrency (4 in-flight per mailbox) ===");
    const concurrencyDecisions = await Promise.all(
      Array.from({ length: 5 }, () =>
        engine.evaluate({
          appId: "app-a",
          userId: "user-a",
          mailboxId: "mailbox-1",
          kind: "outlookApi"
        })
      )
    );

    concurrencyDecisions.forEach((d, i) => {
      console.log(`Request ${i + 1}:`, d.allowed, d.reason);
    });

    for (const decision of concurrencyDecisions) {
      await decision.releaseConcurrency?.();
    }

    console.log("\n=== Demo: per-mailbox 30 messages/minute ===");
    const now = Date.now();

    for (let i = 1; i <= 31; i += 1) {
      const decision = await engine.evaluate({
        appId: "app-a",
        userId: "user-a",
        mailboxId: "mailbox-2",
        kind: "sendMessage",
        recipientCount: 1,
        payloadBytes: 64 * 1024,
        timestampMs: now
      });

      if (!decision.allowed) {
        console.log(`Blocked at message #${i}`, decision.reason, "retryAfterMs=", decision.retryAfterMs);
        break;
      }

      await decision.releaseConcurrency?.();
    }

    console.log("\n=== Demo: recipient daily cap + 24h penalty ===");
    for (let i = 0; i < 10; i += 1) {
      const fill = await engine.evaluate({
        appId: "app-a",
        userId: "user-a",
        mailboxId: "mailbox-3",
        kind: "sendMessage",
        recipientCount: 1_000,
        payloadBytes: 256 * 1024,
        timestampMs: now
      });
      await fill.releaseConcurrency?.();
    }

    const overflow = await engine.evaluate({
      appId: "app-a",
      userId: "user-a",
      mailboxId: "mailbox-3",
      kind: "sendMessage",
      recipientCount: 1,
      payloadBytes: 128 * 1024,
      timestampMs: now + 1_000
    });
    console.log("Overflow send:", overflow.allowed, overflow.reason, "retryAfterMs=", overflow.retryAfterMs);

    const blockedByPenalty = await engine.evaluate({
      appId: "app-a",
      userId: "user-a",
      mailboxId: "mailbox-3",
      kind: "sendMessage",
      recipientCount: 1,
      payloadBytes: 128 * 1024,
      timestampMs: now + 2_000
    });
    console.log(
      "Send during penalty:",
      blockedByPenalty.allowed,
      blockedByPenalty.reason,
      "retryAfterMs=",
      blockedByPenalty.retryAfterMs
    );

    console.log("\n=== Demo: upload 150MB/5m ===");
    const upload1 = await engine.evaluate({
      appId: "app-a",
      userId: "user-a",
      mailboxId: "mailbox-4",
      kind: "uploadAttachment",
      attachmentBytes: 120 * MB,
      timestampMs: now
    });
    await upload1.releaseConcurrency?.();

    const upload2 = await engine.evaluate({
      appId: "app-a",
      userId: "user-a",
      mailboxId: "mailbox-4",
      kind: "uploadAttachment",
      attachmentBytes: 40 * MB,
      timestampMs: now + 10_000
    });
    console.log(
      "Second upload in 5m window:",
      upload2.allowed,
      upload2.reason,
      "retryAfterMs=",
      upload2.retryAfterMs
    );
  } finally {
    await redis.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
