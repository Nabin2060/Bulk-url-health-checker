import { SubmitForm } from '@/components/SubmitForm';
import { BatchListLive } from '@/components/BatchListLive';
import { fetchBatches } from '@/lib/api';

// Rendered per request on the server: a cold load always reflects committed DB state.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const batches = await fetchBatches();
  return (
    <>
      <SubmitForm />
      <BatchListLive initial={batches} />
    </>
  );
}
