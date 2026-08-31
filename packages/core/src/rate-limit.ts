import type { Redis } from 'ioredis';
import { config } from './config';

const KEY = 'buhc:ratelimit:global';

/**
 * Token bucket in Redis. The clock comes from Redis TIME, so every worker process
 * shares one bucket regardless of host clock skew or process count. Capacity defaults
 * to 1 (strict pacing): a full-size bucket would let 2x the limit through in the first
 * second, which is exactly what this requirement is about.
 */
const SCRIPT = `
local rate = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end
tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate / 1000)
local allowed = 0
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  wait = math.ceil((1 - tokens) * 1000 / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], 10000)
return { allowed, wait }
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GlobalRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly rate = config.rateLimitPerSecond,
    private readonly burst = config.rateLimitBurst,
  ) {
    this.redis.defineCommand('buhcTakeToken', { numberOfKeys: 1, lua: SCRIPT });
  }

  /** Resolves only once this process holds a token from the global budget. */
  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new Error('cancelled');
      const [allowed, wait] = (await (this.redis as never as {
        buhcTakeToken(key: string, rate: string, capacity: string): Promise<[number, number]>;
      }).buhcTakeToken(KEY, String(this.rate), String(this.burst))) as [number, number];
      if (allowed === 1) return;
      await sleep(Math.max(5, wait));
    }
  }
}
