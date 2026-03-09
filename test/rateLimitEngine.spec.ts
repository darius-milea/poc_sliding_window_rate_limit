import test from "node:test";
import assert from "node:assert/strict";
import { RateLimitEngine } from "../src/RateLimitEngine";

const MB = 1024 * 1024;

test("allows four concurrent requests per mailbox and blocks the fifth", () => {
  const engine = new RateLimitEngine();

  const decisions = Array.from({ length: 5 }, () =>
    engine.evaluate({
      appId: "app",
      userId: "user",
      mailboxId: "mailbox-1",
      kind: "outlookApi"
    })
  );

  assert.equal(decisions.slice(0, 4).every((d) => d.allowed), true);
  assert.equal(decisions[4].allowed, false);
  assert.equal(decisions[4].reason, "mailbox_concurrency_exceeded");

  decisions.forEach((d) => d.releaseConcurrency?.());
});

test("enforces 30 messages per minute per mailbox", () => {
  const engine = new RateLimitEngine();
  const t0 = 1_000;

  for (let i = 0; i < 30; i += 1) {
    const allowed = engine.evaluate({
      appId: "app",
      userId: "user",
      mailboxId: "mailbox-2",
      kind: "sendMessage",
      recipientCount: 1,
      payloadBytes: 10,
      timestampMs: t0
    });

    assert.equal(allowed.allowed, true);
    allowed.releaseConcurrency?.();
  }

  const blocked = engine.evaluate({
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

test("starts 24h penalty when daily recipient budget is exceeded", () => {
  const engine = new RateLimitEngine({ allowUpTo1000RecipientsPerMessage: true });
  const t0 = 10_000;

  // Fill exactly 10,000 recipients with 10 valid batches of 1,000.
  for (let i = 0; i < 10; i += 1) {
    const decision = engine.evaluate({
      appId: "app",
      userId: "user",
      mailboxId: "mailbox-3",
      kind: "sendMessage",
      recipientCount: 1_000,
      payloadBytes: MB,
      timestampMs: t0
    });

    assert.equal(decision.allowed, true);
    decision.releaseConcurrency?.();
  }

  const exceeding = engine.evaluate({
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

  const penaltyActive = engine.evaluate({
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

test("limits app+user independently from other users", () => {
  const engine = new RateLimitEngine();
  const t0 = 50_000;

  for (let i = 0; i < 10_000; i += 1) {
    const d = engine.evaluate({
      appId: "app-x",
      userId: "user-1",
      mailboxId: `mailbox-${i}`,
      kind: "outlookApi",
      timestampMs: t0
    });

    assert.equal(d.allowed, true);
    d.releaseConcurrency?.();
  }

  const blocked = engine.evaluate({
    appId: "app-x",
    userId: "user-1",
    mailboxId: "mailbox-extra",
    kind: "outlookApi",
    timestampMs: t0
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "app_user_request_rate_exceeded");

  // Different user should still be allowed at the same time.
  const otherUser = engine.evaluate({
    appId: "app-x",
    userId: "user-2",
    mailboxId: "mailbox-other-user",
    kind: "outlookApi",
    timestampMs: t0
  });

  assert.equal(otherUser.allowed, true);
  otherUser.releaseConcurrency?.();
});

test("enforces 150MB upload budget per 5 minutes per mailbox", () => {
  const engine = new RateLimitEngine();
  const t0 = 100_000;

  const first = engine.evaluate({
    appId: "app",
    userId: "user",
    mailboxId: "mailbox-4",
    kind: "uploadAttachment",
    attachmentBytes: 120 * MB,
    timestampMs: t0
  });
  assert.equal(first.allowed, true);
  first.releaseConcurrency?.();

  const second = engine.evaluate({
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

