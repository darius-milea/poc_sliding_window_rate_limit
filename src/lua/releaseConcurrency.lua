-- releaseConcurrency.lua
--
-- Atomically release one concurrency permit for a mailbox.
-- The key stores current in-flight count for that mailbox.
--
-- Return value:
--   resulting in-flight count (or 0 when deleted/empty)

local key = KEYS[1]
local leaseMs = tonumber(ARGV[1])

local current = tonumber(redis.call("GET", key) or "0")
if current <= 0 then
  -- Nothing to release.
  return 0
end

if current == 1 then
  -- Last permit released; remove key entirely.
  redis.call("DEL", key)
  return 0
end

-- More permits still active, decrement and keep TTL as safety fallback.
local next = redis.call("DECR", key)
redis.call("PEXPIRE", key, leaseMs)
return next

