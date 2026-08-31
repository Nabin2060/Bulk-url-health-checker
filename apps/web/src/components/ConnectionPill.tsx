'use client';

import type { StreamStatus } from '@/lib/useStream';

const LABELS: Record<StreamStatus, string> = {
  connecting: 'connecting…',
  live: 'live',
  reconnecting: 'reconnecting…',
};

export function ConnectionPill({ status }: { status: StreamStatus }) {
  return <span className={`pill conn-${status}`}>{LABELS[status]}</span>;
}
