import type { FastifyInstance } from 'fastify';
import {
  cancelBatch,
  config,
  createBatch,
  enqueueChecks,
  getBatchDetail,
  getBatchIdForKey,
  getBatchSummary,
  invalidateBatchListCache,
  jobIdFor,
  listBatches,
  publishBatch,
  publishCancel,
  readBatchListCache,
  removeJobs,
  retryFailedUrls,
  writeBatchListCache,
} from '@buhc/core';
import {
  batchListQuerySchema,
  createBatchSchema,
  type ActionResponse,
  type BatchDetail,
  type BatchListPage,
  type CreateBatchResponse,
} from '@buhc/shared';
import { normalizeUrls } from '../urls';
import { openStream } from '../sse';

interface IdParams {
  id: string;
}

function detailResponse(batch: BatchDetail): CreateBatchResponse {
  return {
    batchId: batch.id,
    batchUrl: `/api/batches/${batch.id}`,
    streamUrl: `/api/batches/${batch.id}/stream`,
    batch,
  };
}

export async function batchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/batches', async (req): Promise<BatchListPage> => {
    const { cursor, limit } = batchListQuerySchema.parse(req.query);

    // Read the version alongside the page, so a write-back cannot resurrect a value
    // that an invalidation between the miss and the write has already superseded.
    const { page: cached, version } = await readBatchListCache(cursor, limit);
    if (cached) return cached;

    const page = await listBatches(limit, cursor);
    await writeBatchListCache(cursor, limit, version, page);
    return page;
  });

  app.post('/api/batches', async (req, reply) => {
    const body = createBatchSchema.parse(req.body);
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined)?.slice(0, 200);

    if (idempotencyKey) {
      const existingId = await getBatchIdForKey(idempotencyKey);
      if (existingId) {
        const existing = await getBatchDetail(existingId);
        if (existing) return reply.code(200).send(detailResponse(existing));
      }
    }

    const { urls, rejected } = normalizeUrls(body.urls);
    if (urls.length === 0) {
      return reply.code(400).send({ error: 'no valid URLs supplied', details: { rejected } });
    }

    const name = body.name?.trim() || `Batch of ${urls.length} URLs`;

    let batchId: string;
    try {
      const created = await createBatch(name, urls, idempotencyKey);
      batchId = created.batchId;
      // Persisted first, enqueued second: the DB is the source of truth for what must run.
      await enqueueChecks(batchId, created.urls);
    } catch (err) {
      if ((err as { code?: string }).code === '23505' && idempotencyKey) {
        const existingId = await getBatchIdForKey(idempotencyKey);
        const existing = existingId ? await getBatchDetail(existingId) : null;
        if (existing) return reply.code(200).send(detailResponse(existing));
      }
      throw err;
    }

    const batch = (await getBatchDetail(batchId))!;
    await invalidateBatchListCache();
    await publishBatch(batch);
    return reply.code(201).send(detailResponse(batch));
  });

  app.get('/api/batches/stream', async (req, reply) => {
    // The stream's snapshot is always the FIRST page: a reconnecting client rebuilds
    // from the head and re-scrolls, rather than trusting a cursor it may have outgrown.
    const { limit } = batchListQuerySchema.parse(req.query);
    const page = await listBatches(limit);
    openStream(reply, null, { type: 'batch-list', page });
  });

  app.get<{ Params: IdParams }>('/api/batches/:id', async (req, reply) => {
    const batch = await getBatchDetail(req.params.id);
    if (!batch) return reply.code(404).send({ error: 'batch not found' });
    return batch;
  });

  app.get<{ Params: IdParams }>('/api/batches/:id/stream', async (req, reply) => {
    const batch = await getBatchDetail(req.params.id);
    if (!batch) return reply.code(404).send({ error: 'batch not found' });
    openStream(reply, batch.id, { type: 'snapshot', batch });
  });

  app.post<{ Params: IdParams }>('/api/batches/:id/cancel', async (req, reply) => {
    const { id } = req.params;
    if (!(await getBatchSummary(id))) return reply.code(404).send({ error: 'batch not found' });

    const { cancelled, cancelledUrls } = await cancelBatch(id);
    if (cancelled) {
      await removeJobs(cancelledUrls.map((u) => jobIdFor(u.id, u.runCount)));
      await publishCancel(id);
    }

    const batch = (await getBatchDetail(id))!;
    await invalidateBatchListCache();
    await publishBatch(batch);
    return reply.send({ batch } satisfies ActionResponse);
  });

  app.post<{ Params: IdParams }>('/api/batches/:id/retry-failed', async (req, reply) => {
    const { id } = req.params;
    if (!(await getBatchSummary(id))) return reply.code(404).send({ error: 'batch not found' });

    const requeued = await retryFailedUrls(id);
    // run_count was bumped, so these are brand new job ids: no clash with the old run.
    await enqueueChecks(id, requeued);

    const batch = (await getBatchDetail(id))!;
    await invalidateBatchListCache();
    await publishBatch(batch);
    return reply.send({ batch } satisfies ActionResponse);
  });

  app.get('/health', async () => ({ ok: true, service: 'api', port: config.apiPort }));
}
