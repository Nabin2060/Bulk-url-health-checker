import { config } from '@buhc/core';

const MAX_BODY_BYTES = 128 * 1024;

export interface CheckOutcome {
  httpStatus: number;
  responseTimeMs: number;
  title: string | null;
  finalUrl: string;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match?.[1]) return null;
  const text = match[1]
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 300) : null;
}

/** Reads at most MAX_BODY_BYTES so one huge page cannot stall a worker slot. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

export async function performCheck(url: string, signal: AbortSignal): Promise<CheckOutcome> {
  const timeout = AbortSignal.timeout(config.requestTimeoutMs);
  const started = performance.now();

  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.any([signal, timeout]),
    headers: { 'user-agent': 'BulkURLHealthChecker/1.0', accept: 'text/html,*/*' },
  });
  const responseTimeMs = Math.round(performance.now() - started);

  const contentType = res.headers.get('content-type') ?? '';
  const title = contentType.includes('html') ? extractTitle(await readCapped(res)) : null;
  if (!contentType.includes('html')) await res.body?.cancel().catch(() => undefined);

  return { httpStatus: res.status, responseTimeMs, title, finalUrl: res.url || url };
}

/** Errors we will not waste retries on. */
export function isPermanentError(err: unknown): boolean {
  const code = (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
  return code === 'ENOTFOUND' || code === 'ERR_INVALID_URL' || code === 'ERR_UNSUPPORTED_PROTOCOL';
}

export function describeError(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code;
  const message = err instanceof Error ? err.message : String(err);
  return (code ? `${code}: ${cause?.message ?? message}` : message).slice(0, 500);
}
