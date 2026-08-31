import type { FastifyReply } from 'fastify';
import type { StreamEvent } from '@buhc/shared';
import { CHANNEL_EVENTS, config, createRedis } from '@buhc/core';

interface Client {
  batchId: string | null;
  write: (event: StreamEvent) => void;
  close: () => void;
}

const clients = new Set<Client>();

/**
 * One Redis subscription per API instance fans every state change out to the
 * sockets that instance happens to be holding. Adding API instances changes nothing.
 */
export function startEventSubscriber(): void {
  const sub = createRedis();
  void sub.subscribe(CHANNEL_EVENTS);
  sub.on('message', (_channel, payload) => {
    let event: StreamEvent;
    try {
      event = JSON.parse(payload) as StreamEvent;
    } catch {
      return;
    }
    for (const client of clients) {
      if (client.batchId === null) {
        if (event.type === 'batch') client.write(event);
      } else if (
        (event.type === 'url' && event.url.batchId === client.batchId) ||
        (event.type === 'batch' && event.batch.id === client.batchId)
      ) {
        client.write(event);
      }
    }
  });
}

/** Opens the SSE response and sends `initial` immediately, so a reconnect self-heals. */
export function openStream(reply: FastifyReply, batchId: string | null, initial: StreamEvent): void {
  const raw = reply.raw;
  reply.hijack();

  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': config.corsOrigin,
  });
  raw.write('retry: 2000\n\n');

  const client: Client = {
    batchId,
    write: (event) => {
      if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    close: () => {
      if (!raw.writableEnded) raw.end();
    },
  };
  clients.add(client);
  client.write(initial);

  const heartbeat = setInterval(() => {
    if (!raw.writableEnded) raw.write(': ping\n\n');
  }, 15_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(client);
  };
  raw.on('close', cleanup);
  raw.on('error', cleanup);
}

export function connectedClients(): number {
  return clients.size;
}
