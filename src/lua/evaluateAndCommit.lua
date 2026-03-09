-- evaluateAndCommit.lua
--
-- This script performs the full rate-limit decision + state commit atomically.
-- Atomic here means Redis executes the whole script as a single isolated unit,
-- so concurrent pods cannot interleave reads/writes and over-admit requests.
--
-- Return format:
--   { allowedFlag, reason, retryAfterMs }
-- where:
--   allowedFlag = 1 or 0
--   reason      = machine-friendly decision token
--   retryAfterMs= milliseconds until likely next allowed attempt

-- KEYS
local kGlobal = KEYS[1]
local kAppUser = KEYS[2]
local kMailboxMsg = KEYS[3]
local kMailboxRecipients = KEYS[4]
local kMailboxUpload = KEYS[5]
local kPenalty = KEYS[6]
local kConcurrency = KEYS[7]

-- ARGV request fields
local nowMs = tonumber(ARGV[1])
local kind = ARGV[2]
local recipientCount = tonumber(ARGV[3])
local payloadBytes = tonumber(ARGV[4])
local attachmentBytes = tonumber(ARGV[5])
local uploadSessionCreatedAtMs = tonumber(ARGV[6])
local allowUpTo1000 = tonumber(ARGV[7])
local requestId = ARGV[8]

-- ARGV limits/windows
local globalLimit = tonumber(ARGV[9])
local globalWindowMs = tonumber(ARGV[10])
local appUserLimit = tonumber(ARGV[11])
local appUserWindowMs = tonumber(ARGV[12])
local mailboxMsgLimit = tonumber(ARGV[13])
local mailboxMsgWindowMs = tonumber(ARGV[14])
local mailboxRecipientsLimit = tonumber(ARGV[15])
local mailboxRecipientsWindowMs = tonumber(ARGV[16])
local mailboxUploadLimit = tonumber(ARGV[17])
local mailboxUploadWindowMs = tonumber(ARGV[18])
local payloadBytesPerMessageLimit = tonumber(ARGV[19])
local payloadBytesLargeBatchLimit = tonumber(ARGV[20])
local recipientCapDefault = tonumber(ARGV[21])
local recipientCapOverride = tonumber(ARGV[22])
local recipientPenaltyWindowMs = tonumber(ARGV[23])
local uploadSessionLifetimeMs = tonumber(ARGV[24])
local mailboxConcurrencyLimit = tonumber(ARGV[25])
local concurrencyLeaseMs = tonumber(ARGV[26])

local function reject(reason, retryAfterMs)
  return { 0, reason, retryAfterMs }
end

-- Remove all sorted-set events older than the rolling-window boundary.
local function pruneWindow(key, windowMs)
  redis.call("ZREMRANGEBYSCORE", key, 0, nowMs - windowMs)
end

-- Compute retry-after from the oldest event still in window.
local function retryAfterWindow(key, windowMs)
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  if oldest[2] == nil then
    return 0
  end

  local retry = tonumber(oldest[2]) + windowMs - nowMs
  if retry < 0 then
    return 0
  end

  return retry
end

-- Sum trailing numeric payload from members encoded like:
--   <timestamp>:<requestId>:<amount>
local function sumEncodedAmounts(key)
  local members = redis.call("ZRANGE", key, 0, -1)
  local total = 0

  for _, member in ipairs(members) do
    local amount = tonumber(string.match(member, ":(%d+)$"))
    if amount ~= nil then
      total = total + amount
    end
  end

  return total
end

-- Basic structural sanity checks.
if recipientCount < 0 or payloadBytes < 0 or attachmentBytes < 0 then
  return reject("negative_values_not_allowed", 0)
end

-- Message-specific policy branch.
if kind == "sendMessage" then
  local recipientCap = recipientCapDefault
  if allowUpTo1000 == 1 then
    recipientCap = recipientCapOverride
  end

  if recipientCount > recipientCap then
    return reject("recipient_count_exceeds_per_message_cap", 0)
  end

  if payloadBytes > payloadBytesPerMessageLimit then
    return reject("payload_too_large_for_message", 0)
  end

  if recipientCount > recipientCapDefault and payloadBytes > payloadBytesLargeBatchLimit then
    return reject("payload_too_large_for_large_recipient_batch", 0)
  end

  -- Penalty key stores absolute timestamp when penalty expires.
  local penaltyUntilMs = tonumber(redis.call("GET", kPenalty) or "0")
  if penaltyUntilMs > nowMs then
    return reject("recipient_daily_limit_penalty_active", penaltyUntilMs - nowMs)
  end

  pruneWindow(kMailboxMsg, mailboxMsgWindowMs)
  local mailboxMsgCount = tonumber(redis.call("ZCARD", kMailboxMsg))
  if mailboxMsgCount + 1 > mailboxMsgLimit then
    return reject("mailbox_message_rate_exceeded", retryAfterWindow(kMailboxMsg, mailboxMsgWindowMs))
  end

  if recipientCount > 0 then
    pruneWindow(kMailboxRecipients, mailboxRecipientsWindowMs)
    local currentRecipients = sumEncodedAmounts(kMailboxRecipients)
    if currentRecipients + recipientCount > mailboxRecipientsLimit then
      local penaltyUntil = nowMs + recipientPenaltyWindowMs
      redis.call("SET", kPenalty, tostring(penaltyUntil), "PX", recipientPenaltyWindowMs)
      return reject("mailbox_recipient_daily_limit_exceeded_penalty_started", recipientPenaltyWindowMs)
    end
  end
end

-- Attachment upload branch.
if kind == "uploadAttachment" then
  -- A negative value means "not provided" by caller.
  if uploadSessionCreatedAtMs >= 0 and (nowMs - uploadSessionCreatedAtMs) > uploadSessionLifetimeMs then
    return reject("upload_session_expired", 0)
  end

  pruneWindow(kMailboxUpload, mailboxUploadWindowMs)
  local currentUpload = sumEncodedAmounts(kMailboxUpload)
  if currentUpload + attachmentBytes > mailboxUploadLimit then
    return reject("mailbox_upload_bandwidth_exceeded", retryAfterWindow(kMailboxUpload, mailboxUploadWindowMs))
  end
end

-- Shared request windows.
pruneWindow(kGlobal, globalWindowMs)
local globalCount = tonumber(redis.call("ZCARD", kGlobal))
if globalCount + 1 > globalLimit then
  return reject("global_request_rate_exceeded", retryAfterWindow(kGlobal, globalWindowMs))
end

pruneWindow(kAppUser, appUserWindowMs)
local appUserCount = tonumber(redis.call("ZCARD", kAppUser))
if appUserCount + 1 > appUserLimit then
  return reject("app_user_request_rate_exceeded", retryAfterWindow(kAppUser, appUserWindowMs))
end

-- Concurrency permit acquisition (same atomic transaction scope as all checks).
local inFlight = tonumber(redis.call("GET", kConcurrency) or "0")
if inFlight >= mailboxConcurrencyLimit then
  return reject("mailbox_concurrency_exceeded", 0)
end

redis.call("INCR", kConcurrency)
redis.call("PEXPIRE", kConcurrency, concurrencyLeaseMs)

-- If execution reached this line, request is accepted and we can commit counters.
local countMember = tostring(nowMs) .. ":" .. requestId

redis.call("ZADD", kGlobal, nowMs, countMember)
redis.call("PEXPIRE", kGlobal, globalWindowMs * 2)

redis.call("ZADD", kAppUser, nowMs, countMember)
redis.call("PEXPIRE", kAppUser, appUserWindowMs * 2)

if kind == "sendMessage" then
  redis.call("ZADD", kMailboxMsg, nowMs, countMember)
  redis.call("PEXPIRE", kMailboxMsg, mailboxMsgWindowMs * 2)

  if recipientCount > 0 then
    local recipientMember = tostring(nowMs) .. ":" .. requestId .. ":" .. tostring(recipientCount)
    redis.call("ZADD", kMailboxRecipients, nowMs, recipientMember)
    redis.call("PEXPIRE", kMailboxRecipients, mailboxRecipientsWindowMs * 2)
  end
end

if kind == "uploadAttachment" and attachmentBytes > 0 then
  local uploadMember = tostring(nowMs) .. ":" .. requestId .. ":" .. tostring(attachmentBytes)
  redis.call("ZADD", kMailboxUpload, nowMs, uploadMember)
  redis.call("PEXPIRE", kMailboxUpload, mailboxUploadWindowMs * 2)
end

return { 1, "accepted", 0 }

