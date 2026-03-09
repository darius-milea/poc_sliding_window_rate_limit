import test from "node:test";
import assert from "node:assert/strict";
import { RedisClientLike, RedisRateLimitEngine } from "../src/RedisRateLimitEngine";

const MB = 1024 * 1024;

class FakeRedisClient implements RedisClientLike {
  private readonly strings = new Map<string, string>();
  private readonly zsets = new Map<string, Map<string, number>>();

  public async eval(
    script: string,
    options: {
      keys: string[];
      arguments: string[];
    }
  ): Promise<unknown> {
    const key = options.keys[0];

    // Acquire script call shape: [limit, leaseMs]
    if (options.arguments.length === 2 && script.includes("current >= limit")) {
      const limit = Number(options.arguments[0]);
      const current = Number(this.strings.get(key) ?? "0");
      if (current >= limit) {
        return 0;
      }

      const next = current + 1;
      this.strings.set(key, String(next));
      return next;
    }

    // Release script call shape: [leaseMs]
    if (options.arguments.length === 1 && script.includes("DECR")) {
      const current = Number(this.strings.get(key) ?? "0");
      if (current <= 0) {
        return 0;
      }

      if (current === 1) {
        this.strings.delete(key);
        return 0;
      }

      const next = current - 1;
      this.strings.set(key, String(next));
      return next;
    }

    throw new Error("Unsupported fake eval invocation");
  }

  public async zRemRangeByScore(key: string, min: number, max: number): Promise<number> {
    const zset = this.zsets.get(key);
    if (!zset) {
      return 0;
    }

    let removed = 0;
    for (const [member, score] of zset.entries()) {
      if (score >= min && score <= max) {
        zset.delete(member);
        removed += 1;
      }
    }

    return removed;
  }

  public async zCard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }

  public async zRangeWithScores(key: string, start: number, stop: number): Promise<Array<{ value: string; score: number }>> {
    const sorted = this.getSortedEntries(key);
    return this.sliceRange(sorted, start, stop).map((entry) => ({ value: entry.member, score: entry.score }));
  }

  public async zRange(key: string, start: number, stop: number): Promise<string[]> {
    const sorted = this.getSortedEntries(key);
    return this.sliceRange(sorted, start, stop).map((entry) => entry.member);
  }

  public async zAdd(key: string, members: Array<{ score: number; value: string }>): Promise<number> {
    let zset = this.zsets.get(key);
    if (!zset) {
      zset = new Map<string, number>();
      this.zsets.set(key, zset);
    }

    for (const member of members) {
      zset.set(member.value, member.score);
    }

    return members.length;
  }

  public async pExpire(_key: string, _milliseconds: number): Promise<number> {
    return 1;
  }

  public async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  public async set(key: string, value: string): Promise<string | null> {
    this.strings.set(key, value);
    return "OK";
  }

  private getSortedEntries(key: string): Array<{ member: string; score: number }> {
    const zset = this.zsets.get(key);
    if (!zset) {
      return [];
    }

    return Array.from(zset.entries())
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
  }

  private sliceRange<T>(values: T[], start: number, stop: number): T[] {
    const normalizedStop = stop < 0 ? values.length - 1 : stop;
    if (values.length === 0 || start > normalizedStop) {
      return [];
    }

    return values.slice(start, normalizedStop + 1);
  }
}

function createEngine(allowUpTo1000RecipientsPerMessage = false): RedisRateLimitEngine {
  return new RedisRateLimitEngine(new FakeRedisClient(), {
    redisKeyPrefix: `rl:test:${Math.random().toString(36).slice(2)}`,
    allowUpTo1000RecipientsPerMessage
  });
}

test("allows four concurrent requests per mailbox and blocks the fifth", async () => {
  const engine = createEngine();

  const decisions = await Promise.all(
    Array.from({ length: 5 }, () =>
      engine.evaluate({
        appId: "app",
        userId: "user",
        mailboxId: "mailbox-1",
        kind: "outlookApi"
      })
    )
  );

  assert.equal(decisions.slice(0, 4).every((d) => d.allowed), true);
  assert.equal(decisions[4].allowed, false);
  assert.equal(decisions[4].reason, "mailbox_concurrency_exceeded");

  for (const decision of decisions) {
    await decision.releaseConcurrency?.();
  }
});

test("enforces 30 messages per minute per mailbox", async () => {
  const engine = createEngine();
  const t0 = 1_000;

  for (let i = 0; i < 30; i += 1) {
    const allowed = await engine.evaluate({
      appId: "app",
      userId: "user",
      mailboxId: "mailbox-2",
      kind: "sendMessage",
      recipientCount: 1,
      payloadBytes: 10,
      timestampMs: t0
    });

    assert.equal(allowed.allowed, true);
    await allowed.releaseConcurrency?.();
  }

  const blocked = await engine.evaluate({
    appId: "app",
    userId: "user",
    mailboxId: "mailbox-2",
    kind: "sendMessage",
    recipientCount: 1,
    payloadBytes: 10,
    timestampMs: t0
  });

  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "mailbox_message_rate_exceeded");
});

test("starts 24h penalty when daily recipient budget is exceeded", async () => {
  const engine = createEngine(true);
  const t0 = 10_000;

  for (let i = 0; i < 10; i += 1) {
    const decision = await engine.evaluate({
      appId: "app",
      userId: "user",
      mailboxId: "mailbox-3",
      kind: "sendMessage",
      recipientCount: 1_000,
      payloadBytes: MB,
      timestampMs: t0
    });

    assert.equal(decision.allowed, true);
    await decision.releaseConcurrency?.();
  }

  const exceeding = await engine.evaluate({
    appId: "app",
    userId: "user",
    mailboxId: "mailbox-3",
    kind: "sendMessage",
    recipientCount: 1,
    payloadBytes: MB,
    timestampMs: t0 + 1
  });

  assert.equal(exceeding.allowed, false);
  assert.equal(exceeding.reason, "mailbox_recipient_daily_limit_exceeded_penalty_started");

  const penaltyActive = await engine.evaluate({
    appId: "app",
    userId: "user",
    mailboxId: "mailbox-3",
    kind: "sendMessage",
    recipientCount: 1,
    payloadBytes: MB,
    timestampMs: t0 + 1_000
  });

  assert.equal(penaltyActive.allowed, false);
  assert.equal(penaltyActive.reason, "recipient_daily_limit_penalty_active");
  assert.ok(penaltyActive.retryAfterMs > 0);
});

test("limits app+user independently from other users", async () => {
  const engine = createEngine();
  const t0 = 50_000;

  for (let i = 0; i < 10_000; i += 1) {
    const d = await engine.evaluate({
      appId: "app-x",
      userId: "user-1",
      mailboxId: `mailbox-${i}`,
      kind: "outlookApi",
      timestampMs: t0
    });

    assert.equal(d.allowed, true);
    await d.releaseConcurrency?.();
  }

  const blocked = await engine.evaluate({
    appId: "app-x",
    userId: "user-1",
    mailboxId: "mailbox-extra",
    kind: "outlookApi",
    timestampMs: t0
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "app_user_request_rate_exceeded");

  const otherUser = await engine.evaluate({
    appId: "app-x",
    userId: "user-2",
    mailboxId: "mailbox-other-user",
    kind: "outlookApi",
    timestampMs: t0
  });

  assert.equal(otherUser.allowed, true);
  await otherUser.releaseConcurrency?.();
});

test("enforces 150MB upload budget per 5 minutes per mailbox", async () => {
  const engine = createEngine();
  const t0 = 100_000;

  const first = await engine.evaluate({
    appId: "app",
    userId: "user",
    mailboxId: "mailbox-4",
    kind: "uploadAttachment",
    attachmentBytes: 120 * MB,
    timestampMs: t0
  });
  assert.equal(first.allowed, true);
  await first.releaseConcurrency?.();

  const second = await engine.evaluate({
    appId: "app",
    userId: "user",
    mailboxId: "mailbox-4",
    kind: "uploadAttachment",
    attachmentBytes: 40 * MB,
    timestampMs: t0 + 1_000
  });

  assert.equal(second.allowed, false);
  assert.equal(second.reason, "mailbox_upload_bandwidth_exceeded");
});
