import { Pool } from 'pg';
import { config } from './config';

export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

export async function query<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params as never[]);
  return res.rows as T[];
}

export async function withTransaction<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'queued',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS urls (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id         uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  url              text NOT NULL,
  position         integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'queued',
  http_status      integer,
  response_time_ms integer,
  title            text,
  final_url        text,
  error            text,
  attempts         integer NOT NULL DEFAULT 0,
  run_count        integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, url)
);

-- Startup migration is idempotent, so it also has to cover tables created by an earlier version.
ALTER TABLE urls ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS urls_batch_id_idx ON urls (batch_id);
CREATE INDEX IF NOT EXISTS urls_batch_status_idx ON urls (batch_id, status);
CREATE INDEX IF NOT EXISTS batches_created_at_idx ON batches (created_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        text PRIMARY KEY,
  batch_id   uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

export async function migrate(): Promise<void> {
  await pool.query(SCHEMA);
}
