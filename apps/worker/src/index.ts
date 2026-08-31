import { Worker, type Job } from 'bullmq';
import {
  CHANNEL_CANCEL,
  MAX_ATTEMPTS,
  QUEUE_NAME,
  applyGlobalConcurrency,
  claimUrl,
  completeBatchIfDone,
  config,
  createRedis,
  finishUrl,
  getBatchSummary,
  markBatchRunning,
  migrate,
  publishBatch,
  publishUrl,
  redis,
  GlobalRateLimiter,
  type CheckJobData,
  type UrlResult,
} from '@buhc/core';
import { describeError, isPermanentError, performCheck } from './check';

const limiter = new GlobalRateLimiter(redis());

/** In-flight checks per batch, so a cancel can abort work already on the wire. */
const inFlight = new Map<string, Set<AbortController>>();

function track(batchId: string, controller: AbortController): () => void {
  let set = inFlight.get(batchId);
  if (!set) {
    set = new Set();
    inFlight.set(batchId, set);
  }
  set.add(controller);
  return () => {
    set!.delete(controller);
    if (set!.size === 0) inFlight.delete(batchId);
  };
}

function listenForCancels(): void {
  const sub = createRedis();
  void sub.subscribe(CHANNEL_CANCEL);
  sub.on('message', (_channel, batchId) => {
    for (const controller of inFlight.get(batchId) ?? []) controller.abort();
  });
}

async function announceBatch(batchId: string): Promise<void> {
  const summary = await getBatchSummary(batchId);
  if (summary) await publishBatch(summary);
}

async function settle(job: Job<CheckJobData>, result: UrlResult): Promise<void> {
  const { urlId, batchId, runCount } = job.data;
  const updated = await finishUrl(urlId, runCount, result);
  if (!updated) return; // cancelled or superseded by a newer run
  await publishUrl(updated);
  await completeBatchIfDone(batchId);
  await announceBatch(batchId);
}

async function runCheck(job: Job<CheckJobData>): Promise<void> {
  const { urlId, batchId, url, runCount } = job.data;

  const claimed = await claimUrl(urlId, runCount);
  if (!claimed) return; // batch cancelled, or this job is a stale duplicate
  await publishUrl(claimed);
  if (await markBatchRunning(batchId)) await announceBatch(batchId);

  const controller = new AbortController();
  const untrack = track(batchId, controller);

  try {
    await limiter.acquire(controller.signal);
    const outcome = await performCheck(url, controller.signal);

    // 5xx is treated as transient and retried; 4xx is a definitive answer.
    if (outcome.httpStatus >= 500 && claimed.attempts < MAX_ATTEMPTS) {
      throw Object.assign(new Error(`upstream returned ${outcome.httpStatus}`), { outcome });
    }

    await settle(job, {
      status: outcome.httpStatus >= 500 ? 'failed' : 'success',
      httpStatus: outcome.httpStatus,
      responseTimeMs: outcome.responseTimeMs,
      title: outcome.title,
      finalUrl: outcome.finalUrl,
      error: outcome.httpStatus >= 500 ? `upstream returned ${outcome.httpStatus}` : null,
    });
  } catch (err) {
    if (controller.signal.aborted) return; // cancelled: the API already wrote the terminal state

    const outcome = (err as { outcome?: { httpStatus: number; responseTimeMs: number } }).outcome;
    const exhausted = claimed.attempts >= MAX_ATTEMPTS || isPermanentError(err);

    if (exhausted) {
      await settle(job, {
        status: 'failed',
        httpStatus: outcome?.httpStatus ?? null,
        responseTimeMs: outcome?.responseTimeMs ?? null,
        title: null,
        finalUrl: null,
        error: describeError(err),
      });
      return;
    }
    throw err; // hand back to BullMQ for exponential backoff
  } finally {
    untrack();
  }
}

async function main(): Promise<void> {
  await migrate();
  await applyGlobalConcurrency();
  listenForCancels();

  const worker = new Worker<CheckJobData>(QUEUE_NAME, runCheck, {
    connection: createRedis(),
    concurrency: config.concurrency,
    limiter: { max: config.rateLimitPerSecond, duration: 1000 },
  });

  // Safety net: if BullMQ gives up before our own counter does, the row must not stay 'running'.
  worker.on('failed', (job, err) => {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return;
    void settle(job, {
      status: 'failed',
      httpStatus: null,
      responseTimeMs: null,
      title: null,
      finalUrl: null,
      error: describeError(err),
    }).catch(() => undefined);
  });

  worker.on('error', (err) => console.error('[worker]', err.message));
  console.log(
    `[worker] ready — concurrency ${config.concurrency}, ${config.rateLimitPerSecond} req/s global, ${MAX_ATTEMPTS} attempts`,
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void worker.close().then(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
