import { notFound } from 'next/navigation';
import { BatchDetailLive } from '@/components/BatchDetailLive';
import { fetchBatch } from '@/lib/api';

export const dynamic = 'force-dynamic';

// The batch is fetched on the server, so opening this URL cold renders the real
// state — running or finished — before any JavaScript executes.
export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batch = await fetchBatch(id);
  if (!batch) notFound();
  return <BatchDetailLive initial={batch} />;
}
