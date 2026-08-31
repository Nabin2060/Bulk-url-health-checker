import { MAX_URLS_PER_BATCH } from '@buhc/shared';

/** Normalises, validates and de-duplicates raw input so the same URL is never checked twice in a batch. */
export function normalizeUrls(raw: string[]): { urls: string[]; rejected: string[] } {
  const urls: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const trimmed = item.trim().replace(/^["']|["']$/g, '');
    if (!trimmed) continue;
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      rejected.push(trimmed);
      continue;
    }
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    const hasHost = parsed.hostname.includes('.') || parsed.hostname === 'localhost';
    if (!isHttp || !hasHost) {
      rejected.push(trimmed);
      continue;
    }

    const normalized = parsed.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
    if (urls.length >= MAX_URLS_PER_BATCH) break;
  }

  return { urls, rejected };
}
