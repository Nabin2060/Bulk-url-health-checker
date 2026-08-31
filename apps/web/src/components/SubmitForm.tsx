'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MAX_URLS_PER_BATCH } from '@buhc/shared';
import { createBatch } from '@/lib/client';
import { parseUrlList } from '@/lib/csv';

export function SubmitForm() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function onFile(file: File) {
    setText(parseUrlList(await file.text()).join('\n'));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const urls = parseUrlList(text);
    if (urls.length === 0) {
      setError('Paste at least one URL.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Key is generated once per submit: a double-click cannot create two batches.
      const res = await createBatch(urls.slice(0, MAX_URLS_PER_BATCH), name || undefined, crypto.randomUUID());
      router.push(`/batches/${res.batchId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'submit failed');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card">
      <h2>New batch</h2>
      <input
        className="input"
        placeholder="Batch name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <textarea
        className="input textarea"
        placeholder={'https://example.com\nhttps://news.ycombinator.com'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
      />
      <div className="row">
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv,text/plain"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onFile(file);
            e.target.value = '';
          }}
        />
        <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
          Upload CSV
        </button>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Submitting…' : 'Check URLs'}
        </button>
        <span className="muted">max {MAX_URLS_PER_BATCH} per batch</span>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
