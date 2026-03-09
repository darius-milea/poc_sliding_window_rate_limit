import fs from "node:fs";
import path from "node:path";
import { LIMITS, WINDOWS } from "./limits";
import { AsyncLimitDecision, RateLimitRequest, SharedRateLimitOptions } from "./types";

/**
 * Minimal Redis API needed when decision logic runs in Lua scripts.
 */
export interface RedisClientLike {
  /** Execute a Lua script atomically. */
  eval(
    script: string,
    options: {
      keys: string[];
      arguments: string[];
    }
  ): Promise<unknown>;
}

export interface RedisRateLimitEngineOptions extends SharedRateLimitOptions {
  redisKeyPrefix?: string;
  concurrencyLeaseMs?: number;
}

function loadLuaScript(fileName: string): string {
  const filePath = path.join(__dirname, "lua", fileName);
  return fs.readFileSync(filePath, "utf8");
}

const EVALUATE_AND_COMMIT_LUA = loadLuaScript("evaluateAndCommit.lua");
const RELEASE_CONCURRENCY_LUA = loadLuaScript("releaseConcurrency.lua");

/**
 * Redis-backed distributed limiter where evaluation and state commit are atomic.
 */
export class RedisRateLimitEngine {
  private readonly nowMs: () => number;
  private readonly keyPrefix: string;
  private readonly concurrencyLeaseMs: number;

  public constructor(
    private readonly redisClient: RedisClientLike,
    private readonly options: RedisRateLimitEngineOptions = {}
  ) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.keyPrefix = options.redisKeyPrefix ?? "rl:poc";
    this.concurrencyLeaseMs = options.concurrencyLeaseMs ?? 30 * 60 * 1000;
  }

  public async evaluate(request: RateLimitRequest): Promise<AsyncLimitDecision> {
    const nowMs = request.timestampMs ?? this.nowMs();
    const requestId = this.makeRequestId();
    const keys = this.buildKeyArray(request.appId, request.userId, request.mailboxId);

    const raw = (await this.redisClient.eval(EVALUATE_AND_COMMIT_LUA, {
      keys,
      arguments: [
        String(nowMs),
        request.kind,
        String(request.recipientCount ?? 0),
        String(request.payloadBytes ?? 0),
        String(request.attachmentBytes ?? 0),
        String(request.uploadSessionCreatedAtMs ?? -1),
        this.options.allowUpTo1000RecipientsPerMessage ? "1" : "0",
        requestId,
        String(LIMITS.globalRequestsPer10s),
        String(WINDOWS.global10sMs),
        String(LIMITS.appUserRequestsPer10m),
        String(WINDOWS.appUser10mMs),
        String(LIMITS.mailboxMessagesPer1m),
        String(WINDOWS.mailboxMessages1mMs),
        String(LIMITS.mailboxRecipientsPerDay),
        String(WINDOWS.mailboxRecipients1dMs),
        String(LIMITS.mailboxUploadBytesPer5m),
        String(WINDOWS.mailboxUpload5mMs),
        String(LIMITS.payloadBytesPerMessage),
        String(LIMITS.payloadBytesForLargeRecipientBatch),
        String(LIMITS.recipientCapDefault),
        String(LIMITS.recipientCapWithAdminOverride),
        String(LIMITS.recipientPenaltyWindowMs),
        String(LIMITS.uploadSessionLifetimeMs),
        String(LIMITS.mailboxConcurrency),
        String(this.concurrencyLeaseMs)
      ]
    })) as [number | string, string, number | string];

    const allowed = Number(raw[0]) === 1;
    const reason = String(raw[1] ?? "unknown");
    const retryAfterMs = Number(raw[2] ?? 0);

    if (!allowed) {
      return { allowed, reason, retryAfterMs };
    }

    const concurrencyKey = keys[6];
    return {
      allowed,
      reason,
      retryAfterMs,
      releaseConcurrency: async () => {
        await this.releaseConcurrencyKey(concurrencyKey);
      }
    };
  }

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

  private async releaseConcurrencyKey(key: string): Promise<void> {
    await this.redisClient.eval(RELEASE_CONCURRENCY_LUA, {
      keys: [key],
      arguments: [String(this.concurrencyLeaseMs)]
    });
  }

  private buildKeyArray(appId: string, userId: string, mailboxId: string): string[] {
    const mailboxRoot = `${this.keyPrefix}:mailbox:${mailboxId}`;
    return [
      `${this.keyPrefix}:global:req:10s`,
      `${this.keyPrefix}:appuser:${appId}:${userId}:req:10m`,
      `${mailboxRoot}:msg:1m`,
      `${mailboxRoot}:recipients:1d`,
      `${mailboxRoot}:upload:5m`,
      `${mailboxRoot}:recipient-penalty`,
      `${mailboxRoot}:concurrency`
    ];
  }

  private makeRequestId(): string {
    const randomPart = Math.random().toString(36).slice(2);
    return `${Date.now().toString(36)}-${randomPart}`;
  }
}
