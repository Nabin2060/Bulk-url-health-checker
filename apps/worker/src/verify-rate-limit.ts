/**
 * Proves the global limiter holds across processes. Every grant is recorded in Redis,
 * so each participant reports the same system-wide number, not just its own slice.
 *
 *   docker compose exec worker node apps/worker/dist/verify-rate-limit.js
 */
import { GlobalRateLimiter, config, createRedis } from '@buhc/core';

const KEY = 'buhc:verify:grants';
const LOCK = 'buhc:verify:lock';
const CLIENTS = Number(process.env.VERIFY_CLIENTS ?? 8);
const SECONDS = Number(process.env.VERIFY_SECONDS ?? 5);

async function main(): Promise<void> {
  const redis = createRedis();
  const limiter = new GlobalRateLimiter(redis);

  // First process into the run clears the shared log; the others join it.
  if (await redis.set(LOCK, '1', 'EX', 30, 'NX')) await redis.del(KEY);

  const deadline = Date.now() + SECONDS * 1000;
  await Promise.all(
    Array.from({ length: CLIENTS }, async () => {
      while (Date.now() < deadline) {
        await limiter.acquire();
        await redis.rpush(KEY, String(Date.now()));
      }
    }),
  );

  await new Promise((r) => setTimeout(r, 1000));
  const stamps = (await redis.lrange(KEY, 0, -1)).map(Number).sort((a, b) => a - b);
  const worst = stamps.reduce(
    (max, start) => Math.max(max, stamps.filter((t) => t >= start && t < start + 1000).length),
    0,
  );
  const elapsed = (stamps[stamps.length - 1]! - stamps[0]!) / 1000;

  console.log(`system-wide grants: ${stamps.length} over ${elapsed.toFixed(2)}s`);
  console.log(`average: ${(stamps.length / elapsed).toFixed(2)}/s (limit ${config.rateLimitPerSecond})`);
  console.log(`worst rolling 1s window: ${worst}`);
  console.log(worst <= config.rateLimitPerSecond ? 'PASS' : 'FAIL');
  await redis.quit();
}

void main();
