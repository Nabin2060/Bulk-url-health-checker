import IORedis, { Redis } from 'ioredis';
import { config } from './config';

/** BullMQ requires maxRetriesPerRequest: null on its connections. */
export function createRedis(): Redis {
  return new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
}

let shared: Redis | null = null;

/** Command connection shared by app code (never used for blocking/subscribe). */
export function redis(): Redis {
  if (!shared) shared = createRedis();
  return shared;
}

export const CHANNEL_EVENTS = 'buhc:events';
export const CHANNEL_CANCEL = 'buhc:cancel';
export const CACHE_KEY_BATCH_LIST = 'buhc:cache:batch-list';
export const CACHE_KEY_BATCH_LIST_VERSION = 'buhc:cache:batch-list:version';
