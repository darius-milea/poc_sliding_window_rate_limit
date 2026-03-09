const MB = 1024 * 1024;

export const LIMITS = {
  globalRequestsPer10s: 130_000,
  appUserRequestsPer10m: 10_000,
  mailboxMessagesPer1m: 30,
  mailboxRecipientsPerDay: 10_000,
  mailboxUploadBytesPer5m: 150 * MB,
  payloadBytesPerMessage: 4 * MB,
  payloadBytesForLargeRecipientBatch: 60 * MB,
  mailboxConcurrency: 4,
  recipientCapDefault: 500,
  recipientCapWithAdminOverride: 1000,
  recipientPenaltyWindowMs: 24 * 60 * 60 * 1000,
  uploadSessionLifetimeMs: 7 * 24 * 60 * 60 * 1000
} as const;

export const WINDOWS = {
  global10sMs: 10_000,
  appUser10mMs: 10 * 60 * 1000,
  mailboxMessages1mMs: 60 * 1000,
  mailboxRecipients1dMs: 24 * 60 * 60 * 1000,
  mailboxUpload5mMs: 5 * 60 * 1000
} as const;

