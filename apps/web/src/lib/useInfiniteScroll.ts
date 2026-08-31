'use client';

import { useEffect, useRef } from 'react';

/**
 * Attaches an IntersectionObserver to a sentinel element. Preferred over a scroll
 * listener: no per-frame work, and `rootMargin` prefetches the next page just before
 * the user reaches the bottom, so scrolling never visibly stalls.
 */
export function useInfiniteScroll<T extends HTMLElement>(
  onLoadMore: () => void,
  enabled: boolean,
) {
  const ref = useRef<T | null>(null);
  const handler = useRef(onLoadMore);
  handler.current = onLoadMore;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) handler.current();
      },
      { rootMargin: '300px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled]);

  return ref;
}
