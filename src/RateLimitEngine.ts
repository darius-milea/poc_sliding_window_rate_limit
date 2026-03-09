import { LIMITS, WINDOWS } from "./limits";
import { ConcurrencySemaphore } from "./limiting/ConcurrencySemaphore";
import { SlidingWindowCounter } from "./limiting/SlidingWindowCounter";
import { LimitDecision, RateLimitEngineOptions, RateLimitRequest } from "./types";

interface MailboxState {
  concurrency: ConcurrencySemaphore;
  messagesPerMinute: SlidingWindowCounter;
  recipientsPerDay: SlidingWindowCounter;
  uploadBytesPerFiveMinutes: SlidingWindowCounter;
  recipientPenaltyUntilMs: number;
}

interface AppUserState {
  requestsPerTenMinutes: SlidingWindowCounter;
}

/**
 * POC in-memory rate limiter.
 *
 * Key design goals:
 * 1) Enforce mailbox concurrency via semaphore (not just timestamps).
 * 2) Use rolling windows for burst/sustained limits.
 * 3) Keep policy checks explicit and readable for easy refinement.
 */
export class RateLimitEngine {
  private readonly globalRequestsPerTenSeconds = new SlidingWindowCounter(WINDOWS.global10sMs);
  private readonly appUserState = new Map<string, AppUserState>();
  private readonly mailboxState = new Map<string, MailboxState>();
  private readonly nowMs: () => number;

  public constructor(private readonly options: RateLimitEngineOptions = {}) {
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  public evaluate(request: RateLimitRequest): LimitDecision {
    const nowMs = request.timestampMs ?? this.nowMs();

    const mailbox = this.getMailboxState(request.mailboxId);
    const appUser = this.getAppUserState(request.appId, request.userId);

    const recipientCount = request.recipientCount ?? 0;
    const payloadBytes = request.payloadBytes ?? 0;
    const attachmentBytes = request.attachmentBytes ?? 0;

    // First block structurally invalid requests.
    if (recipientCount < 0 || payloadBytes < 0 || attachmentBytes < 0) {
      return this.reject("negative_values_not_allowed", 0);
    }

    // Message-specific policies.
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

      // If admin override allows 501..1000 recipients, enforce the 60 MiB cap for that mode.
      if (
        recipientCount > LIMITS.recipientCapDefault &&
        payloadBytes > LIMITS.payloadBytesForLargeRecipientBatch
      ) {
        return this.reject("payload_too_large_for_large_recipient_batch", 0);
      }

      // Penalty lock starts only once the daily recipient budget is exceeded.
      if (mailbox.recipientPenaltyUntilMs > nowMs) {
        return this.reject(
          "recipient_daily_limit_penalty_active",
          mailbox.recipientPenaltyUntilMs - nowMs
        );
      }

      if (!mailbox.messagesPerMinute.canAdd(nowMs, 1, LIMITS.mailboxMessagesPer1m)) {
        return this.reject(
          "mailbox_message_rate_exceeded",
          mailbox.messagesPerMinute.retryAfterMs(nowMs)
        );
      }

      if (
        recipientCount > 0 &&
        !mailbox.recipientsPerDay.canAdd(nowMs, recipientCount, LIMITS.mailboxRecipientsPerDay)
      ) {
        mailbox.recipientPenaltyUntilMs = nowMs + LIMITS.recipientPenaltyWindowMs;
        return this.reject(
          "mailbox_recipient_daily_limit_exceeded_penalty_started",
          LIMITS.recipientPenaltyWindowMs
        );
      }
    }

    // Upload-specific policies.
    if (request.kind === "uploadAttachment") {
      if (request.uploadSessionCreatedAtMs !== undefined) {
        const ageMs = nowMs - request.uploadSessionCreatedAtMs;
        if (ageMs > LIMITS.uploadSessionLifetimeMs) {
          return this.reject("upload_session_expired", 0);
        }
      }

      // The stated 150 MB/5m rule counts attachment traffic per mailbox.
      if (
        !mailbox.uploadBytesPerFiveMinutes.canAdd(
          nowMs,
          attachmentBytes,
          LIMITS.mailboxUploadBytesPer5m
        )
      ) {
        return this.reject(
          "mailbox_upload_bandwidth_exceeded",
          mailbox.uploadBytesPerFiveMinutes.retryAfterMs(nowMs)
        );
      }
    }

    // Shared API request limits.
    if (!this.globalRequestsPerTenSeconds.canAdd(nowMs, 1, LIMITS.globalRequestsPer10s)) {
      return this.reject(
        "global_request_rate_exceeded",
        this.globalRequestsPerTenSeconds.retryAfterMs(nowMs)
      );
    }

    if (!appUser.requestsPerTenMinutes.canAdd(nowMs, 1, LIMITS.appUserRequestsPer10m)) {
      return this.reject(
        "app_user_request_rate_exceeded",
        appUser.requestsPerTenMinutes.retryAfterMs(nowMs)
      );
    }

    // Concurrency is a lock/semaphore concern, not a sliding window concern.
    if (!mailbox.concurrency.tryAcquire()) {
      return this.reject("mailbox_concurrency_exceeded", 0);
    }

    // Commit usage only after every guard has passed.
    this.globalRequestsPerTenSeconds.add(nowMs, 1);
    appUser.requestsPerTenMinutes.add(nowMs, 1);

    if (request.kind === "sendMessage") {
      mailbox.messagesPerMinute.add(nowMs, 1);
      if (recipientCount > 0) {
        mailbox.recipientsPerDay.add(nowMs, recipientCount);
      }
    }

    if (request.kind === "uploadAttachment" && attachmentBytes > 0) {
      mailbox.uploadBytesPerFiveMinutes.add(nowMs, attachmentBytes);
    }

    // The caller must release permit after the request finishes.
    return {
      allowed: true,
      reason: "accepted",
      retryAfterMs: 0,
      releaseConcurrency: () => mailbox.concurrency.release()
    };
  }

  /**
   * Convenience helper for correct semaphore release with async workflows.
   */
  public async runWithPermit<T>(
    request: RateLimitRequest,
    operation: () => Promise<T>
  ): Promise<{ decision: LimitDecision; result?: T }> {
    const decision = this.evaluate(request);
    if (!decision.allowed || !decision.releaseConcurrency) {
      return { decision };
    }

    try {
      const result = await operation();
      return { decision, result };
    } finally {
      decision.releaseConcurrency();
    }
  }

  private getAppUserState(appId: string, userId: string): AppUserState {
    const key = `${appId}::${userId}`;
    const existing = this.appUserState.get(key);
    if (existing) {
      return existing;
    }

    const created: AppUserState = {
      requestsPerTenMinutes: new SlidingWindowCounter(WINDOWS.appUser10mMs)
    };
    this.appUserState.set(key, created);
    return created;
  }

  private getMailboxState(mailboxId: string): MailboxState {
    const existing = this.mailboxState.get(mailboxId);
    if (existing) {
      return existing;
    }

    const created: MailboxState = {
      concurrency: new ConcurrencySemaphore(LIMITS.mailboxConcurrency),
      messagesPerMinute: new SlidingWindowCounter(WINDOWS.mailboxMessages1mMs),
      recipientsPerDay: new SlidingWindowCounter(WINDOWS.mailboxRecipients1dMs),
      uploadBytesPerFiveMinutes: new SlidingWindowCounter(WINDOWS.mailboxUpload5mMs),
      recipientPenaltyUntilMs: 0
    };

    this.mailboxState.set(mailboxId, created);
    return created;
  }

  private reject(reason: string, retryAfterMs: number): LimitDecision {
    return {
      allowed: false,
      reason,
      retryAfterMs
    };
  }
}

