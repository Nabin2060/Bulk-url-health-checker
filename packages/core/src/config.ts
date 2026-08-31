function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/buhc',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  apiPort: num('API_PORT', 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  publicApiUrl: process.env.PUBLIC_API_URL ?? `http://localhost:${num('API_PORT', 4000)}`,

  rateLimitPerSecond: num('RATE_LIMIT_PER_SECOND', 10),
  rateLimitBurst: num('RATE_LIMIT_BURST', 1),
  concurrency: num('CONCURRENCY', 5),
  maxRetries: num('MAX_RETRIES', 3),
  requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 10_000),

  batchListCacheTtlSeconds: num('BATCH_LIST_CACHE_TTL', 30),
} as const;

/** BullMQ `attempts` = first try + MAX_RETRIES retries. */
export const MAX_ATTEMPTS = config.maxRetries + 1;
