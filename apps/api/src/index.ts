import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { applyGlobalConcurrency, config, migrate, pool } from '@buhc/core';
import { batchRoutes } from './routes/batches';
import { startEventSubscriber } from './sse';

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid request body', details: err.flatten() });
    }
    app.log.error(err);
    return reply.code(err.statusCode ?? 500).send({ error: err.message || 'internal error' });
  });

  await app.register(batchRoutes);

  await migrate();
  await applyGlobalConcurrency();
  startEventSubscriber();

  await app.listen({ port: config.apiPort, host: '0.0.0.0' });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void app.close().then(() => pool.end()).then(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
