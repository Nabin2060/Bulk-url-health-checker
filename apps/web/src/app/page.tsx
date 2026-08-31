import { SubmitForm } from '@/components/SubmitForm';
import { BatchListLive } from '@/components/BatchListLive';
import { fetchBatches } from '@/lib/api';

// Rendered per request on the server: a cold load always reflects committed DB state.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  // First page only — the client pulls the rest as the user scrolls.
  const page = await fetchBatches();
  return (
    <>
      <SubmitForm />
      <BatchListLive initial={page} />
    </>
  );
}
