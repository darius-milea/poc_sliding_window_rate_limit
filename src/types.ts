export type RequestKind = "sendMessage" | "uploadAttachment" | "outlookApi";

export interface RateLimitRequest {
  appId: string;
  userId: string;
  mailboxId: string;
  kind: RequestKind;

  // Message and payload related properties.
  recipientCount?: number;
  payloadBytes?: number;

  // Attachment/upload related properties.
  attachmentBytes?: number;
  uploadSessionCreatedAtMs?: number;

  // For deterministic tests and simulation. Defaults to Date.now().
  timestampMs?: number;
}

export interface SharedRateLimitOptions {
  // If true, per-message recipient cap increases from 500 to 1000.
  allowUpTo1000RecipientsPerMessage?: boolean;

  // Optional custom clock for tests.
  nowMs?: () => number;
}

export interface AsyncLimitDecision {
  allowed: boolean;
  reason: string;
  retryAfterMs: number;

  // Must be awaited after an accepted request completes so distributed concurrency is released.
  releaseConcurrency?: () => Promise<void>;
}
