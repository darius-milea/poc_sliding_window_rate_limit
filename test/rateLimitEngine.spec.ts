import test from "node:test";
import assert from "node:assert/strict";
import { RedisClientLike, RedisRateLimitEngine } from "../src/RedisRateLimitEngine";

const MB = 1024 * 1024;

class FakeRedisClient implements RedisClientLike {
  private readonly strings = new Map<string, string>();
  private readonly zsets = new Map<string, Array<{ score: number; member: string }>>();

  public async eval(
    script: string,
    options: {
      keys: string[];
      arguments: string[];
    }
  ): Promise<unknown> {
    if (script.includes("releaseConcurrency.lua") || script.includes("local leaseMs = tonumber(ARGV[1])")) {
      return this.releaseConcurrency(options.keys[0]);
    }

    return this.evaluateAndCommit(options.keys, options.arguments);
  }

  private releaseConcurrency(key: string): number {
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

  private evaluateAndCommit(keys: string[], args: string[]): [number, string, number] {
    const [kGlobal, kAppUser, kMailboxMsg, kMailboxRecipients, kMailboxUpload, kPenalty, kConcurrency] = keys;

    const nowMs = Number(args[0]);
    const kind = args[1];
    const recipientCount = Number(args[2]);
    const payloadBytes = Number(args[3]);
    const attachmentBytes = Number(args[4]);
    const uploadSessionCreatedAtMs = Number(args[5]);
    const allowUpTo1000 = Number(args[6]);
    const requestId = args[7];

    const globalLimit = Number(args[8]);
    const globalWindowMs = Number(args[9]);
    const appUserLimit = Number(args[10]);
    const appUserWindowMs = Number(args[11]);
    const mailboxMsgLimit = Number(args[12]);
    const mailboxMsgWindowMs = Number(args[13]);
    const mailboxRecipientsLimit = Number(args[14]);
    const mailboxRecipientsWindowMs = Number(args[15]);
    const mailboxUploadLimit = Number(args[16]);
    const mailboxUploadWindowMs = Number(args[17]);
    const payloadBytesPerMessageLimit = Number(args[18]);
    const payloadBytesLargeBatchLimit = Number(args[19]);
    const recipientCapDefault = Number(args[20]);
    const recipientCapOverride = Number(args[21]);
    const recipientPenaltyWindowMs = Number(args[22]);
    const uploadSessionLifetimeMs = Number(args[23]);
    const mailboxConcurrencyLimit = Number(args[24]);

    const reject = (reason: string, retryAfterMs: number): [number, string, number] => [0, reason, retryAfterMs];

    if (recipientCount < 0 || payloadBytes < 0 || attachmentBytes < 0) {
      return reject("negative_values_not_allowed", 0);
    }

    if (kind === "sendMessage") {
      const recipientCap = allowUpTo1000 === 1 ? recipientCapOverride : recipientCapDefault;

      if (recipientCount > recipientCap) {
        return reject("recipient_count_exceeds_per_message_cap", 0);
      }

      if (payloadBytes > payloadBytesPerMessageLimit) {
        return reject("payload_too_large_for_message", 0);
      }

      if (recipientCount > recipientCapDefault && payloadBytes > payloadBytesLargeBatchLimit) {
        return reject("payload_too_large_for_large_recipient_batch", 0);
      }

      const penaltyUntil = Number(this.strings.get(kPenalty) ?? "0");
      if (penaltyUntil > nowMs) {
        return reject("recipient_daily_limit_penalty_active", penaltyUntil - nowMs);
      }

      this.pruneWindow(kMailboxMsg, nowMs - mailboxMsgWindowMs);
      if (this.zCard(kMailboxMsg) + 1 > mailboxMsgLimit) {
        return reject(
          "mailbox_message_rate_exceeded",
          this.retryAfterWindow(kMailboxMsg, mailboxMsgWindowMs, nowMs)
        );
      }

      if (recipientCount > 0) {
        this.pruneWindow(kMailboxRecipients, nowMs - mailboxRecipientsWindowMs);
        if (this.sumAmountMembers(kMailboxRecipients) + recipientCount > mailboxRecipientsLimit) {
          this.strings.set(kPenalty, String(nowMs + recipientPenaltyWindowMs));
          return reject("mailbox_recipient_daily_limit_exceeded_penalty_started", recipientPenaltyWindowMs);
        }
      }
    }

    if (kind === "uploadAttachment") {
      if (uploadSessionCreatedAtMs >= 0 && nowMs - uploadSessionCreatedAtMs > uploadSessionLifetimeMs) {
        return reject("upload_session_expired", 0);
      }

      this.pruneWindow(kMailboxUpload, nowMs - mailboxUploadWindowMs);
      if (this.sumAmountMembers(kMailboxUpload) + attachmentBytes > mailboxUploadLimit) {
        return reject(
          "mailbox_upload_bandwidth_exceeded",
          this.retryAfterWindow(kMailboxUpload, mailboxUploadWindowMs, nowMs)
        );
      }
    }

    this.pruneWindow(kGlobal, nowMs - globalWindowMs);
    if (this.zCard(kGlobal) + 1 > globalLimit) {
      return reject("global_request_rate_exceeded", this.retryAfterWindow(kGlobal, globalWindowMs, nowMs));
    }

    this.pruneWindow(kAppUser, nowMs - appUserWindowMs);
    if (this.zCard(kAppUser) + 1 > appUserLimit) {
      return reject("app_user_request_rate_exceeded", this.retryAfterWindow(kAppUser, appUserWindowMs, nowMs));
    }

    const inFlight = Number(this.strings.get(kConcurrency) ?? "0");
    if (inFlight >= mailboxConcurrencyLimit) {
      return reject("mailbox_concurrency_exceeded", 0);
    }
    this.strings.set(kConcurrency, String(inFlight + 1));

    const countMember = `${nowMs}:${requestId}`;
    this.zAdd(kGlobal, nowMs, countMember);
    this.zAdd(kAppUser, nowMs, countMember);

    if (kind === "sendMessage") {
      this.zAdd(kMailboxMsg, nowMs, countMember);
      if (recipientCount > 0) {
        this.zAdd(kMailboxRecipients, nowMs, `${nowMs}:${requestId}:${recipientCount}`);
      }
    }

    if (kind === "uploadAttachment" && attachmentBytes > 0) {
      this.zAdd(kMailboxUpload, nowMs, `${nowMs}:${requestId}:${attachmentBytes}`);
    }

    return [1, "accepted", 0];
  }

  private zAdd(key: string, score: number, member: string): void {
    const zset = this.zsets.get(key) ?? [];
    const filtered = zset.filter((item) => item.member !== member);
    filtered.push({ score, member });
    this.zsets.set(key, filtered);
  }

  private zCard(key: string): number {
    return this.zsets.get(key)?.length ?? 0;
  }

  private pruneWindow(key: string, minScore: number): void {
    const zset = this.zsets.get(key) ?? [];
    this.zsets.set(
      key,
      zset.filter((item) => item.score > minScore)
    );
  }

  private retryAfterWindow(key: string, windowMs: number, nowMs: number): number {
    const zset = this.zsets.get(key) ?? [];
    if (zset.length === 0) {
      return 0;
    }

    const oldest = zset.reduce((acc, item) => (item.score < acc.score ? item : acc));
    return Math.max(oldest.score + windowMs - nowMs, 0);
  }

  private sumAmountMembers(key: string): number {
    const zset = this.zsets.get(key) ?? [];
    let total = 0;

    for (const item of zset) {
      const idx = item.member.lastIndexOf(":");
      if (idx > -1) {
        const amount = Number(item.member.slice(idx + 1));
        if (Number.isFinite(amount)) {
          total += amount;
        }
      }
    }

    return total;
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
