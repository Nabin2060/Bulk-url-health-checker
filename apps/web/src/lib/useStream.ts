'use client';

import { useEffect, useRef, useState } from 'react';
import type { StreamEvent } from '@buhc/shared';
import { API_URL } from './client';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting';

/**
 * EventSource reconnects on its own, and the server replays a full snapshot on every
 * connect, so a dropped connection heals without any client-side bookkeeping.
 */
export function useStream(path: string, onEvent: (event: StreamEvent) => void): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    const source = new EventSource(`${API_URL}${path}`);
    source.onopen = () => setStatus('live');
    source.onerror = () => setStatus((prev) => (prev === 'live' ? 'reconnecting' : prev));
    source.onmessage = (message) => {
      try {
        handler.current(JSON.parse(message.data) as StreamEvent);
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => source.close();
  }, [path]);

  return status;
}
