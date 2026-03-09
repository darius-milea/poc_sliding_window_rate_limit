import { LIMITS, WINDOWS } from "./limits";
import { AsyncLimitDecision, RateLimitEngineOptions, RateLimitRequest } from "./types";

/**
 * Redis sorted set entry returned by zRangeWithScores.
 *
 * - value: encoded event payload (for example "<timestamp>:<requestId>:<amount>")
 * - score: event timestamp in milliseconds
 */
interface SortedSetEntry {
  value: string;
  score: number;
}

/**
 * Minimal Redis API surface required by RedisRateLimitEngine.
 *
 * This interface intentionally captures only the commands this limiter needs,
 * so the engine can be tested with mocks/fakes and not tightly coupled to one
 * concrete Redis client type.
 */
export interface RedisClientLike {
  /**
   * Execute a Lua script atomically.
   *
   * Used for operations that must be race-safe across pods (permit acquire/release).
   */
  eval(
    script: string,
    options: {
      keys: string[];
      arguments: string[];
    }
  ): Promise<unknown>;

  /**
   * Remove all sorted-set members with score in [min, max].
   *
   * Used to prune events outside a rolling window.
   */
  zRemRangeByScore(key: string, min: number, max: number): Promise<number>;

  /**
   * Return the number of members in a sorted set.
   *
   * Used by count-based windows (request counters).
   */
  zCard(key: string): Promise<number>;

  /**
   * Return sorted-set members including scores for the requested range.
   *
   * Used to fetch oldest event timestamp when computing retryAfterMs.
   */
  zRangeWithScores(key: string, start: number, stop: number): Promise<SortedSetEntry[]>;

  /**
   * Return sorted-set member values for the requested range.
   *
   * Used by amount-based windows where the amount is encoded in the member value.
   */
  zRange(key: string, start: number, stop: number): Promise<string[]>;

  /**
   * Add one or more members to a sorted set.
   *
   * Score is the event timestamp and value carries event identity (+ optional amount).
   */
  zAdd(key: string, members: Array<{ score: number; value: string }>): Promise<number>;

  /**
   * Set key TTL in milliseconds.
   *
   * The return type varies across Redis clients; both numeric and boolean responses
   * are accepted here.
   */
  pExpire(key: string, milliseconds: number): Promise<number | boolean>;

  /**
   * Read a plain string value.
   *
   * Used for penalty-until timestamps and script-managed counters.
   */
  get(key: string): Promise<string | null>;

  /**
   * Write a plain string value with optional millisecond TTL.
   *
   * Used to set recipient penalty-until markers with expiration.
   */
  set(key: string, value: string, options?: { PX?: number }): Promise<string | null>;
}

/**
 * Runtime options for the distributed Redis-backed limiter.
 */
export interface RedisRateLimitEngineOptions extends RateLimitEngineOptions {
  /** Key namespace prefix used for all Redis keys created by this engine. */
  redisKeyPrefix?: string;

  /**
   * TTL for the mailbox concurrency key.
   *
   * Acts as a safety valve if a pod crashes before releasing a permit.
   */
  concurrencyLeaseMs?: number;
}

/**
 * Atomically try to acquire one mailbox concurrency permit.
 *
 * Returns:
 * - 0 when permit cannot be acquired (limit reached)
 * - new in-flight count (>0) when acquired
 */
const TRY_ACQUIRE_CONCURRENCY_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local leaseMs = tonumber(ARGV[2])

local current = tonumber(redis.call("GET", key) or "0")
if current >= limit then
  return 0
end

local next = redis.call("INCR", key)
redis.call("PEXPIRE", key, leaseMs)
return next
`;

/**
 * Atomically release one mailbox concurrency permit.
 *
 * Behavior:
 * - if counter is already 0, no-op
 * - if counter is 1, delete key
 * - otherwise decrement and refresh TTL
 */
const RELEASE_CONCURRENCY_LUA = `
local key = KEYS[1]
local leaseMs = tonumber(ARGV[1])

local current = tonumber(redis.call("GET", key) or "0")
if current <= 0 then
  return 0
end

if current == 1 then
  redis.call("DEL", key)
  return 0
end

local next = redis.call("DECR", key)
redis.call("PEXPIRE", key, leaseMs)
return next
`;

/**
 * Distributed rate limiter with Redis as centralized state.
 *
 * Design:
 * - Most policy logic is executed in TypeScript for readability and maintainability.
 * - Only concurrency permit acquire/release uses Lua for cross-pod atomicity.
 */
export class RedisRateLimitEngine {
  private readonly nowMs: () => number;
  private readonly keyPrefix: string;
  private readonly concurrencyLeaseMs: number;

  /**
   * @param redisClient Redis command provider (real client or test double)
   * @param options    Engine tuning and policy options
   */
  public constructor(
    private readonly redisClient: RedisClientLike,
    private readonly options: RedisRateLimitEngineOptions = {}
  ) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.keyPrefix = options.redisKeyPrefix ?? "rl:poc";
    this.concurrencyLeaseMs = options.concurrencyLeaseMs ?? 30 * 60 * 1000;
  }

  /**
   * Evaluate one request against all configured limits.
   *
   * Flow:
   * 1) Validate payload fields
   * 2) Enforce kind-specific policies (message/upload)
   * 3) Enforce shared request windows (global + app-user)
   * 4) Atomically acquire mailbox concurrency permit
   * 5) Commit accepted events to rolling windows
   *
   * On success, returns a decision with async `releaseConcurrency` callback that must be
   * called once the external request finishes.
   */
  public async evaluate(request: RateLimitRequest): Promise<AsyncLimitDecision> {
    const nowMs = request.timestampMs ?? this.nowMs();
    const requestId = this.makeRequestId();
    const keys = this.buildKeys(request.appId, request.userId, request.mailboxId);

    const recipientCount = request.recipientCount ?? 0;
    const payloadBytes = request.payloadBytes ?? 0;
    const attachmentBytes = request.attachmentBytes ?? 0;

    if (recipientCount < 0 || payloadBytes < 0 || attachmentBytes < 0) {
      return this.reject("negative_values_not_allowed", 0);
    }

    if (request.kind === "sendMessage") {
      const recipientCap = this.options.allowUpTo1000RecipientsPerMessage
        ? LIMITS.recipientCapWithAdminOverride
        : LIMITS.recipientCapDefault;

      if (recipientCount > recipientCap) {
        return this.reject("recipient_count_exceeds_per_message_cap", 0);
      }

      if (payloadBytes > LIMITS.payloadBytesPerMessage) {
        return this.reject("payload_too_large_for_message", 0);
      }

      if (
        recipientCount > LIMITS.recipientCapDefault &&
        payloadBytes > LIMITS.payloadBytesForLargeRecipientBatch
      ) {
        return this.reject("payload_too_large_for_large_recipient_batch", 0);
      }

      const penaltyUntilMs = await this.readNumberValue(keys.penalty);
      if (penaltyUntilMs > nowMs) {
        return this.reject("recipient_daily_limit_penalty_active", penaltyUntilMs - nowMs);
      }

      const messageWindow = await this.readCountWindow(keys.mailboxMessages, WINDOWS.mailboxMessages1mMs, nowMs);
      if (messageWindow.currentCount + 1 > LIMITS.mailboxMessagesPer1m) {
        return this.reject("mailbox_message_rate_exceeded", messageWindow.retryAfterMs);
      }

      if (recipientCount > 0) {
        const recipientsWindow = await this.readAmountWindow(
          keys.mailboxRecipients,
          WINDOWS.mailboxRecipients1dMs,
          nowMs
        );

        if (recipientsWindow.currentAmount + recipientCount > LIMITS.mailboxRecipientsPerDay) {
          const penaltyUntil = nowMs + LIMITS.recipientPenaltyWindowMs;
          await this.redisClient.set(keys.penalty, String(penaltyUntil), {
            PX: LIMITS.recipientPenaltyWindowMs
          });
          return this.reject(
            "mailbox_recipient_daily_limit_exceeded_penalty_started",
            LIMITS.recipientPenaltyWindowMs
          );
        }
      }
    }

    if (request.kind === "uploadAttachment") {
      if (request.uploadSessionCreatedAtMs !== undefined) {
        const ageMs = nowMs - request.uploadSessionCreatedAtMs;
        if (ageMs > LIMITS.uploadSessionLifetimeMs) {
          return this.reject("upload_session_expired", 0);
        }
      }

      const uploadWindow = await this.readAmountWindow(keys.mailboxUpload, WINDOWS.mailboxUpload5mMs, nowMs);
      if (uploadWindow.currentAmount + attachmentBytes > LIMITS.mailboxUploadBytesPer5m) {
        return this.reject("mailbox_upload_bandwidth_exceeded", uploadWindow.retryAfterMs);
      }
    }

    const globalWindow = await this.readCountWindow(keys.global, WINDOWS.global10sMs, nowMs);
    if (globalWindow.currentCount + 1 > LIMITS.globalRequestsPer10s) {
      return this.reject("global_request_rate_exceeded", globalWindow.retryAfterMs);
    }

    const appUserWindow = await this.readCountWindow(keys.appUser, WINDOWS.appUser10mMs, nowMs);
    if (appUserWindow.currentCount + 1 > LIMITS.appUserRequestsPer10m) {
      return this.reject("app_user_request_rate_exceeded", appUserWindow.retryAfterMs);
    }

    const acquired = await this.tryAcquireConcurrency(keys.concurrency);
    if (!acquired) {
      return this.reject("mailbox_concurrency_exceeded", 0);
    }

    try {
      await this.commitAcceptedRequest({
        keys,
        request,
        nowMs,
        requestId,
        recipientCount,
        attachmentBytes
      });
    } catch (error) {
      await this.releaseConcurrencyKey(keys.concurrency);
      throw error;
    }

    return {
      allowed: true,
      reason: "accepted",
      retryAfterMs: 0,
      releaseConcurrency: async () => {
        await this.releaseConcurrencyKey(keys.concurrency);
      }
    };
  }

  /**
   * Helper that acquires permit, runs operation, and always releases permit.
   *
   * Useful to avoid forgetting `releaseConcurrency` in async call paths.
   */
  public async runWithPermit<T>(
    request: RateLimitRequest,
    operation: () => Promise<T>
  ): Promise<{ decision: AsyncLimitDecision; result?: T }> {
    const decision = await this.evaluate(request);
    if (!decision.allowed || !decision.releaseConcurrency) {
      return { decision };
    }

    try {
      const result = await operation();
      return { decision, result };
    } finally {
      await decision.releaseConcurrency();
    }
  }

  /**
   * Persist counters/amounts for a request that has already passed all checks.
   */
  private async commitAcceptedRequest(input: {
    keys: ReturnType<RedisRateLimitEngine["buildKeys"]>;
    request: RateLimitRequest;
    nowMs: number;
    requestId: string;
    recipientCount: number;
    attachmentBytes: number;
  }): Promise<void> {
    const countMember = this.makeCountMember(input.nowMs, input.requestId);

    await this.addCountEvent(input.keys.global, countMember, input.nowMs, WINDOWS.global10sMs);
    await this.addCountEvent(input.keys.appUser, countMember, input.nowMs, WINDOWS.appUser10mMs);

    if (input.request.kind === "sendMessage") {
      await this.addCountEvent(
        input.keys.mailboxMessages,
        countMember,
        input.nowMs,
        WINDOWS.mailboxMessages1mMs
      );

      if (input.recipientCount > 0) {
        const recipientMember = this.makeAmountMember(input.nowMs, input.requestId, input.recipientCount);
        await this.addCountEvent(
          input.keys.mailboxRecipients,
          recipientMember,
          input.nowMs,
          WINDOWS.mailboxRecipients1dMs
        );
      }
    }

    if (input.request.kind === "uploadAttachment" && input.attachmentBytes > 0) {
      const uploadMember = this.makeAmountMember(input.nowMs, input.requestId, input.attachmentBytes);
      await this.addCountEvent(input.keys.mailboxUpload, uploadMember, input.nowMs, WINDOWS.mailboxUpload5mMs);
    }
  }

  /**
   * Write one sorted-set event and refresh TTL for that rolling window key.
   */
  private async addCountEvent(
    key: string,
    member: string,
    nowMs: number,
    windowMs: number
  ): Promise<void> {
    await this.redisClient.zAdd(key, [{ score: nowMs, value: member }]);
    await this.redisClient.pExpire(key, windowMs * 2);
  }

  /**
   * Read a count-based rolling window.
   *
   * Returns current count and retry-after estimate based on the oldest event.
   */
  private async readCountWindow(
    key: string,
    windowMs: number,
    nowMs: number
  ): Promise<{ currentCount: number; retryAfterMs: number }> {
    await this.pruneWindow(key, windowMs, nowMs);
    const currentCount = await this.redisClient.zCard(key);
    const retryAfterMs = await this.retryAfterWindow(key, windowMs, nowMs);
    return { currentCount, retryAfterMs };
  }

  /**
   * Read an amount-based rolling window (for recipients or uploaded bytes).
   *
   * Amounts are encoded in the tail of each zset member value and summed in JS.
   */
  private async readAmountWindow(
    key: string,
    windowMs: number,
    nowMs: number
  ): Promise<{ currentAmount: number; retryAfterMs: number }> {
    await this.pruneWindow(key, windowMs, nowMs);
    const values = await this.redisClient.zRange(key, 0, -1);

    let currentAmount = 0;
    for (const value of values) {
      const amount = this.parseTrailingAmount(value);
      currentAmount += amount;
    }

    const retryAfterMs = await this.retryAfterWindow(key, windowMs, nowMs);
    return { currentAmount, retryAfterMs };
  }

  /**
   * Remove events that are outside the rolling window boundary.
   */
  private async pruneWindow(key: string, windowMs: number, nowMs: number): Promise<void> {
    await this.redisClient.zRemRangeByScore(key, 0, nowMs - windowMs);
  }

  /**
   * Estimate how long until at least one event leaves this window.
   */
  private async retryAfterWindow(key: string, windowMs: number, nowMs: number): Promise<number> {
    const oldest = await this.redisClient.zRangeWithScores(key, 0, 0);
    if (oldest.length === 0) {
      return 0;
    }

    const retryAfterMs = oldest[0].score + windowMs - nowMs;
    return retryAfterMs > 0 ? retryAfterMs : 0;
  }

  /**
   * Try to acquire a mailbox concurrency permit atomically via Lua.
   */
  private async tryAcquireConcurrency(key: string): Promise<boolean> {
    const raw = (await this.redisClient.eval(TRY_ACQUIRE_CONCURRENCY_LUA, {
      keys: [key],
      arguments: [String(LIMITS.mailboxConcurrency), String(this.concurrencyLeaseMs)]
    })) as number | string;

    return Number(raw) > 0;
  }

  /**
   * Release a previously acquired mailbox concurrency permit atomically via Lua.
   */
  private async releaseConcurrencyKey(key: string): Promise<void> {
    await this.redisClient.eval(RELEASE_CONCURRENCY_LUA, {
      keys: [key],
      arguments: [String(this.concurrencyLeaseMs)]
    });
  }

  /**
   * Read a numeric key safely, returning 0 for missing or invalid values.
   */
  private async readNumberValue(key: string): Promise<number> {
    const raw = await this.redisClient.get(key);
    if (!raw) {
      return 0;
    }

    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Parse trailing amount from encoded member strings like:
   * - "<timestamp>:<requestId>:<amount>"
   *
   * Returns 0 if parsing fails.
   */
  private parseTrailingAmount(member: string): number {
    const lastColon = member.lastIndexOf(":");
    if (lastColon < 0) {
      return 0;
    }

    const amount = Number(member.slice(lastColon + 1));
    return Number.isFinite(amount) ? amount : 0;
  }

  /**
   * Build a standardized reject decision payload.
   */
  private reject(reason: string, retryAfterMs: number): AsyncLimitDecision {
    return {
      allowed: false,
      reason,
      retryAfterMs
    };
  }

  /**
   * Build all Redis keys used for this app-user-mailbox scope.
   */
  private buildKeys(appId: string, userId: string, mailboxId: string) {
    const mailboxRoot = `${this.keyPrefix}:mailbox:${mailboxId}`;
    return {
      global: `${this.keyPrefix}:global:req:10s`,
      appUser: `${this.keyPrefix}:appuser:${appId}:${userId}:req:10m`,
      mailboxMessages: `${mailboxRoot}:msg:1m`,
      mailboxRecipients: `${mailboxRoot}:recipients:1d`,
      mailboxUpload: `${mailboxRoot}:upload:5m`,
      penalty: `${mailboxRoot}:recipient-penalty`,
      concurrency: `${mailboxRoot}:concurrency`
    };
  }

  /**
   * Create a lightweight unique identifier for one evaluated request.
   */
  private makeRequestId(): string {
    const randomPart = Math.random().toString(36).slice(2);
    return `${Date.now().toString(36)}-${randomPart}`;
  }

  /**
   * Build member format for count-based windows.
   */
  private makeCountMember(nowMs: number, requestId: string): string {
    return `${nowMs}:${requestId}`;
  }

  /**
   * Build member format for amount-based windows.
   */
  private makeAmountMember(nowMs: number, requestId: string, amount: number): string {
    return `${nowMs}:${requestId}:${amount}`;
  }
}
