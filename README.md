# Bulk URL Health Checker

Paste or upload a list of URLs. A Fastify API persists them, BullMQ workers check them in the
background under a system-wide rate limit, and the Next.js UI updates over SSE as results land.

---

## Run command

docker compose up --build


That is the whole system: Postgres, Redis, the API, a worker, and the web UI.

| Service | URL |
| --- | --- |
| Web UI | http://localhost:3000 |
| API | http://localhost:4000 |

Schema migration runs automatically on API/worker startup, so there is no separate migrate step.

**More workers** (the guarantees below still hold):

```bash
docker compose up --build --scale worker=3
```

**A second API instance** on port 4001, to show live updates are not tied to one process:

```bash
docker compose --profile multi-api up --build
```

**Local (no Docker)** 

```bash
cp .env.example .env
npm install
npm run dev
```

---

## Architecture

```
                 ┌──────────────┐
  browser ──────►│  Next.js web │  server components fetch the initial state
      ▲          └──────┬───────┘  client components subscribe to SSE
      │ SSE             │ HTTP
      │          ┌──────▼───────┐        ┌────────────┐
      └──────────│  Fastify API │───────►│ PostgreSQL │◄──────┐  source of truth
                 └──┬────────┬──┘        └────────────┘       │
                    │        │                                │
              enqueue│        │publish/subscribe               │
                    │        │                                │
                 ┌──▼────────▼──┐                     ┌────────┴─────┐
                 │    Redis     │◄────────────────────│ BullMQ worker│  separate process
                 │ queue·pubsub │                     └──────────────┘
                 │ cache·tokens │
                 └──────────────┘
```

Three processes, three responsibilities:

- **`apps/api`** — HTTP only. Writes batches to Postgres, enqueues jobs, serves reads, holds SSE
  connections. It never performs a URL check.
- **`apps/worker`** — BullMQ consumer. Performs checks, writes results, publishes events. It never
  serves HTTP.
- **`apps/web`** — Next.js App Router. Renders state on the server, subscribes to updates on the client.

Shared code lives in two packages so nothing is duplicated or drifts:

- **`packages/shared`** — isomorphic. Zod schemas, request/response types, SSE event union, status
  enums. Imported by client *and* server, so the boundary has one definition.
- **`packages/core`** — server-only. Postgres pool + queries, Redis, the queue, the rate limiter,
  cache and event helpers. Shared by API and worker so both agree on what the data means.

### Why each piece is here, and what breaks without it

| Piece | Why | Without it |
| --- | --- | --- |
| **PostgreSQL** | Source of truth for batch and URL state. Every status transition is a conditional `UPDATE`. | State would live in Redis, where an eviction or flush loses committed user work. Reads could not be transactional. |
| **Redis** | Queue backing store, cross-process pub/sub, the rate-limit token bucket, and the batch-list cache. | Nothing shared between processes. Rate limit and concurrency become per-process, so they break the moment you scale. |
| **BullMQ** | Retries with exponential backoff, atomic job claiming, stalled-job recovery, global concurrency, deterministic job IDs. | Hand-rolled queue: lost jobs on worker crash, no backoff, duplicate delivery. |
| **Fastify** | The API process. Lightweight, and `reply.hijack()` gives clean raw access for SSE. | — |
| **Next.js** | Server components render committed DB state for cold loads; client components own only the live-update layer. | Empty shell + client fetch waterfall on every load. |

### Where the source of truth lives

**Postgres.** Redis holds only derived or transient data: jobs to run, events in flight, cached
reads, rate-limit tokens. Every one of those can be flushed and the system still reports correct
batch state — you would only lose queued work, not the record of what was asked for and what was found.

Concretely, `batches` and `urls` are written **before** a single job is enqueued. The worker never
invents state; it applies conditional updates:

```sql
UPDATE urls SET status='running', attempts=attempts+1
 WHERE id=$1 AND run_count=$2 AND status IN ('queued','running')
   AND EXISTS (SELECT 1 FROM batches b WHERE b.id=urls.batch_id AND b.status IN ('queued','running'))
```

If that returns no row — the batch was cancelled, or the job is a stale duplicate — the worker does
nothing. Batch counters are never denormalised; they are a `FILTER` aggregate over `urls`, so they
cannot drift from the rows they describe.

---

## The three background-processing guarantees

All three are enforced in **Redis**, not in process memory, which is what makes them survive more
than one worker.

### Global rate limit — 10 req/s across the entire system

A token bucket in a Lua script (`packages/core/src/rate-limit.ts`). The clock comes from Redis
`TIME`, so worker host clock skew is irrelevant, and the whole read-modify-write is atomic.

Capacity defaults to **1**, not 10. A full-capacity bucket starts with 10 tokens and refills 10 more
within the first second, letting 20 requests through in the opening window — measured, and exactly
the thing this requirement is about. Capacity 1 paces to one request per 100 ms with no burst.
`RATE_LIMIT_BURST` can raise it if bursting is ever wanted.

BullMQ's own `limiter: { max, duration }` sits in front of it. That is a fixed-window limiter on
*job starts*; the token bucket is the hard gate on the *actual HTTP request*, including retries
inside a job. The bucket is the guarantee; the BullMQ limiter just stops jobs churning against it.

Verify it, across as many processes as you like:

```bash
docker compose exec worker node apps/worker/dist/verify-rate-limit.js
```

Measured with `--scale worker=3` and 16 concurrent clients:

```
system-wide grants: 66 over 6.57s
average: 10.04/s (limit 10)
worst rolling 1s window: 10
PASS
```

### Concurrency — 5 checks in flight

`queue.setGlobalConcurrency(5)` caps in-flight jobs in Redis, so N workers still total 5 — not 5
each. Per-worker `concurrency` is also set, which only matters when a single worker is running.

Measured against an instrumented target with two worker processes and 30 slow URLs: `maxInFlight: 5`.
It is also visible in the UI mid-batch: exactly five rows sit in `running` at any moment.

### Retries — up to 3, exponential backoff

`attempts = 1 + MAX_RETRIES` (4 total: the first try plus 3 retries), `backoff: exponential, 1000ms`.
Measured gaps between attempts: **1.10s → 2.13s → 4.05s**.

What is retried is a deliberate choice:

- **Network error / timeout / 5xx** → transient, retried.
- **4xx** → a definitive answer from the server. Recorded as a successful *check* with that status
  code. Retrying would burn the budget re-asking a question that was already answered.
- **DNS `ENOTFOUND`, invalid URL, unsupported protocol** → permanent. Failed immediately, no retries
  spent. (Measured: 1 attempt, not 4.)

The attempt counter lives in Postgres (`urls.attempts`), not in BullMQ's job metadata, so the
decision to give up is made against the source of truth. The worker's `failed` event is a safety net:
if BullMQ ever gives up before our counter does, the row is still finalised rather than left `running`.

---

### Worker death mid-check

A worker SIGKILLed with checks in flight recovers without a sweeper, because two mechanisms line up:

1. BullMQ's lock on the job expires and the job is re-delivered as **stalled**.
2. `claimUrl` matches `status IN ('queued','running')`, so the redelivered job re-claims a row that
   is still marked `running` from the dead worker — rather than refusing it as already taken.

Verified: 10 URLs, 5 in flight, `docker kill -s KILL` the worker. The batch reached `completed` with
all 10 successful and `attempts = 2` on the five that were interrupted — they were re-run exactly
once. This is why `claimUrl` accepts `running` and not just `queued`; narrowing that guard to
`queued` would look tighter and would strand every interrupted row forever.

---

## Idempotency

Four layers, because "the user double-clicked" and "the queue delivered twice" are different problems.

1. **Batch creation** — `Idempotency-Key` header, stored with a primary-key constraint. Replaying the
   key returns the original batch with `200` instead of creating a second one. The UI generates one
   `crypto.randomUUID()` per submit, so a double-click cannot produce two batches. The unique-violation
   race is caught and resolved to the same batch.
2. **Job identity** — `jobId = ${urlId}-${runCount}`. BullMQ drops an add for a job ID it already
   holds, so re-enqueueing the same work is a no-op. "Retry failed" bumps `run_count`, which mints a
   genuinely new ID rather than colliding with the completed run.
3. **Writes are conditional** — claim requires `status IN ('queued','running')` and a matching
   `run_count`; the terminal write requires `status='running'`. A duplicate or late-arriving job
   cannot overwrite a cancelled batch or clobber a newer run.
4. **Batch completion** — `UPDATE ... WHERE status IN ('queued','running') AND NOT EXISTS (pending)`.
   Every worker races to complete the batch on its last URL; exactly one wins, and running it a
   hundred times is the same as running it once.

Input is also normalised (scheme added, parsed, trimmed) and de-duplicated before insert, backed by a
`UNIQUE (batch_id, url)` constraint, so one URL is never checked twice within a batch.

---

## Live updates: why SSE

**SSE over Redis pub/sub.** The worker publishes to a Redis channel; every API instance subscribes
once and fans events out to whichever sockets it happens to be holding.

Why SSE and not the alternatives:

- **vs. polling** — polling either wastes requests or lags. This data is push-shaped: the server
  knows exactly when a result lands.
- **vs. WebSockets** — the traffic is strictly one-way, server to client. WebSockets add a second
  protocol, a second failure mode, and hand-rolled reconnect logic for a channel that never carries
  client messages. Mutations are ordinary `POST`s.
- **SSE gets reconnection for free.** `EventSource` reconnects on its own, and honours the server's
  `retry:` hint. There is no client-side reconnect code in this repo, which is the point.

Four requirements, and how each is met:

- **Updates without user action** — worker writes to Postgres → publishes to Redis → every API
  instance pushes to its clients.
- **Refresh-safe** — the page is a server component. A reload re-fetches committed state from
  Postgres before any JavaScript runs.
- **Correct with multiple API instances** — no API instance holds state. It subscribes to Redis and
  pushes what arrives. Verified: a batch created on `:4000` and processed by workers streams correctly
  to a client connected to `:4001`.
- **Recovers from a dropped connection** — **every connect, including every reconnect, replays a full
  `snapshot` frame before any deltas.** The client replaces its state with the snapshot, so a
  connection dropped for one event or a thousand converges to correct state with no gap-detection,
  no event log, and no replay buffer. Deltas also carry `updatedAt` and are dropped if older than the
  row the client already has, so out-of-order frames can't move a row backwards.

Heartbeat comments every 15s keep proxies from reaping idle connections.

---

## Caching

`GET /api/batches` is served from Redis with a **30-second TTL**. Cold ~29 ms, warm ~2 ms.

The list is paginated, so **each page is cached under its own key** and invalidation is a **version
bump**, not a `DEL`:

```
key      buhc:cache:batch-list:v{N}:{limit}:{cursor}
INCR     buhc:cache:batch-list:version      <- invalidates every page at once
```

Two reasons it is a counter rather than a delete:

1. **One INCR invalidates every page**, with no `SCAN` over key patterns.
2. **It closes the cache-aside race.** With a plain `DEL`, a reader that queried Postgres *before* an
   invalidation can write its now-stale result *after* it, resurrecting stale data for the full 30s —
   exactly the user-visible staleness the brief rules out. Here that reader writes under the version
   it read, so its value lands on a key nobody will look up again. Superseded keys are never read and
   expire on their own TTL.

Any event that changes what the list shows — batch created, status transition, a URL finishing and
moving the counters — bumps the version as part of publishing that event
(`packages/core/src/events.ts`). Commit to Postgres first, then invalidate, then publish.

During an active batch the cache is therefore invalidated often, which is correct: the cache exists to
absorb repeated reads of *settled* data, not to serve a number the user has already watched change.
The list page also holds its own SSE subscription, so counters move live regardless of cache state.

---

## UI: pagination and theming

**Keyset pagination, not `OFFSET`.** The cursor is `(created_at, id)` of the last row on the page:

```sql
WHERE (b.created_at, b.id) < ($cursor_created_at, $cursor_id)
ORDER BY b.created_at DESC, b.id DESC
LIMIT $limit + 1          -- the extra row is how we know a next page exists, without COUNT(*)
```

`OFFSET` would be wrong here specifically because batches are inserted *while the user scrolls* — an
offset-paged list silently skips or repeats rows as the head shifts. A cursor is anchored to a row, so
new batches arriving at the top never disturb a page boundary. `batches_keyset_idx (created_at DESC,
id DESC)` matches the `ORDER BY` exactly, so paging is an index scan at any depth. The cursor is
opaque to the client: it is echoed back, never parsed.

**Infinite scroll meets a live stream**, which is the interesting part. Three rules keep them
consistent:

- The SSE `batch-list` snapshot is only the *first* page, so on reconnect the client **merges** it
  rather than replacing state — pages the user already scrolled past survive a dropped connection.
- A `batch` event for an unknown batch older than everything loaded is **ignored**; it belongs to a
  page that has not been fetched, and admitting it would drop it in out of order. It arrives correctly
  when the user scrolls that far.
- Page merges dedupe by id, since a batch can arrive both by page fetch and by live event.

The single-batch table reveals rows incrementally too (`URL_PAGE_SIZE`), with a status filter. All
rows stay in memory — the live merge needs them — so this bounds only what the DOM holds, which is
the part that actually costs on a 500-URL batch.

**Theming** is light/dark/system. An inline script in `<head>` sets `data-theme` on `<html>` *before
first paint*, so there is no dark-mode flash; `<html suppressHydrationWarning>` covers the attribute
the server could not know. The palette is CSS custom properties, with dark defined twice — once under
`prefers-color-scheme` (so it is still right with JS disabled) and once under `[data-theme='dark']` (so
an explicit choice beats the OS in both directions). The toggle renders no active state until mounted,
so server and first client render agree.

Scroll and theme are both `IntersectionObserver`/CSS-variable based — no polling, no layout thrash,
and `prefers-reduced-motion` disables the animations.

---

## Type safety across the boundary

`packages/shared` is imported by both sides and is the only definition of the contract:

- Request bodies are **Zod schemas**; the API parses with them and a `ZodError` maps to a 400.
- `BatchSummary`, `BatchDetail`, `UrlCheck` are the exact shapes the API returns and the UI consumes.
- `StreamEvent` is a **discriminated union** of every SSE frame, so `switch (event.type)` is
  exhaustively checked in the client.
- Status values are `as const` tuples with derived types — a new status is a compile error everywhere
  it is not handled.

Server-only types (`pg` rows, BullMQ job data) stay in `packages/core` and never reach the browser
bundle.

---

## Next.js: where data is fetched, and why

- **`/` (batch list)** — server component, `dynamic = 'force-dynamic'`. Fetches on the server so the
  first paint has real data. `cache: 'no-store'` on the fetch is deliberate: the 30-second cache lives
  in Redis behind the API, and adding Next's own cache on top would create a second layer this app
  cannot invalidate.
- **`/batches/[id]`** — server component, `await params` (Next 15). Fetches the batch server-side and
  calls `notFound()` on a 404. **Opening a batch URL cold in a new tab renders the correct state —
  running or finished — before any JavaScript executes.** Verified by curling the page HTML: page
  titles, error strings and statuses are all in the server-rendered markup.
- **Client components** own exactly one thing: the live layer. `SubmitForm`, `BatchListLive` and
  `BatchDetailLive` are `'use client'` because they need `EventSource`, form state, and event
  handlers. Each receives server-fetched data as `initial` props and takes over from there.

The split is the point: the server owns correctness on load, the client owns freshness after load.

---

## Controls

**Cancel** handles both job states, because they fail differently:

- *Queued* jobs — removed from BullMQ by their deterministic job IDs.
- *In-flight* jobs — the API publishes to a Redis cancel channel; each worker aborts the
  `AbortController` for that batch, killing the HTTP request mid-wire.

Postgres is updated first, in a transaction, so the persisted state is correct even if a worker
misses the message: the aborted job's terminal write is rejected by the `status='running'` guard.
Measured: at cancel the target had received 20 requests; six seconds later, still 20.

**Retry failed only** re-queues rows in `failed` or `cancelled` state, bumps `run_count`, and clears
their previous result. Successful rows are not touched — verified by their `updatedAt` and `runCount`
staying unchanged while the target logged requests for the failed URL only.

> Assumption: a *cancelled* URL is included in "retry failed", since it never got an answer.

---

## API

| Method | Route | Notes |
| --- | --- | --- |
| `POST` | `/api/batches` | `{ urls: string[], name?: string }`, optional `Idempotency-Key`. Returns `batchId`, `batchUrl`, `streamUrl`, full batch. |
| `GET` | `/api/batches?cursor=&limit=` | Keyset-paginated. Returns `{ batches, nextCursor }`. 30s Redis cache, per page. |
| `GET` | `/api/batches/:id` | Full detail. |
| `GET` | `/api/batches/:id/stream` | SSE: `snapshot`, then `url` / `batch` deltas. |
| `GET` | `/api/batches/stream` | SSE for the list view: `batch-list` (first page) then `batch` deltas. |
| `POST` | `/api/batches/:id/cancel` | |
| `POST` | `/api/batches/:id/retry-failed` | |

---

## Horizontal scaling of the API

Adding API instances requires no coordination, because an API instance holds nothing that another
instance needs.

- **Reads and writes** go to Postgres. Correctness comes from conditional updates and transactions,
  not from a single writer.
- **SSE connections are instance-local, and that is fine.** Every instance subscribes to the same
  Redis channel and pushes to its own sockets. A client on instance A sees events caused by a worker
  that instance B never heard of. No sticky sessions required — a reconnect can land anywhere,
  because every connect starts with a full snapshot from Postgres.
- **The cache is shared**, in Redis, keyed identically. Instance A invalidating is instance B
  invalidating. A per-instance in-memory cache would have been the wrong call here: one instance would
  serve state another had already superseded.
- **The rate limit and concurrency caps are unaffected**, since they live in Redis rather than in any
  process.

Run `docker compose --profile multi-api up` to bring up a second API on `:4001` and watch a batch
created on `:4000` stream to a client on `:4001`.

The one thing that does not scale by adding API instances is throughput of the checks themselves —
that is deliberately capped at 10 req/s globally. Adding workers adds resilience and failover, not speed.

---

## Trade-offs, and what I would do differently

**Made under time pressure:**

- **Raw SQL over an ORM.** Every query is conditional-update-shaped (`WHERE status IN (...) AND
  run_count = $2`), which is where ORMs get in the way. The cost is hand-written row-to-type mappers.
  With more time I would add Drizzle for the schema and migration story while keeping the state
  transitions as raw SQL.
- **Migrations run on startup via `CREATE TABLE IF NOT EXISTS`.** Keeps the one-command promise
  honest. It does not handle a schema *change*. A real deployment needs versioned migrations as a
  separate step in the release, not a side effect of booting.
- **CSV is parsed in the browser** and submitted as JSON, so there is one create endpoint rather than
  two. A 500-URL cap makes this safe. The parser handles quoted cells, CRLF, a BOM and multi-column
  files, but it is not a full RFC-4180 implementation — no embedded newlines inside quoted cells.
  Large files would need a real multipart upload.
- **No tests in the repo.** I verified the guarantees empirically against an instrumented target
  server (rate, in-flight count, backoff gaps, cancel, retry scope, cache eviction, cross-instance
  SSE) and shipped `verify-rate-limit.js` so the headline claim is reproducible. Those checks belong
  in a suite; that was the trade I made.
- **The rate limit is global, not per-host.** Correct as specified, but it means one slow domain
  throttles everything. Per-host buckets on top of the global one would be the real-world design.
- **Response time is measured to response headers**, not to the end of the body — the standard health
  metric, but worth stating since the body is also read for the title.
- **UI is deliberately plain.** Out of scope.

**With more time:**

1. **Dead-letter handling.** Jobs that exhaust their attempts are marked `failed` and left; there is
   no dead-letter queue to inspect or drain. A `running` row whose worker died *is* recovered
   (see below), but a poison URL that fails every time just sits as `failed` with no triage path.
2. **`Last-Event-ID` on the SSE stream.** Snapshot-on-reconnect is correct but re-sends the whole
   batch. For a 500-URL batch on a flaky connection that is wasteful; a resume cursor would send only
   the delta.
3. **Backpressure on the title parse.** 128 KB is capped, but a slow-drip response still holds a
   concurrency slot for the full timeout.
4. **Structured retry classification.** The transient/permanent split is a small hand-written list;
   it should be a table driven by observed error codes.
5. **Per-batch queues or priorities**, so one 500-URL batch cannot starve a 3-URL batch submitted
   behind it — currently strictly FIFO.
6. **Observability.** Queue depth, check latency percentiles, and rate-limiter wait time are the three
   numbers that would tell you the system is unhealthy, and none are exposed today.

---

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://postgres:postgres@postgres:5432/buhc` | |
| `REDIS_URL` | `redis://redis:6379` | |
| `RATE_LIMIT_PER_SECOND` | `10` | Global, system-wide |
| `RATE_LIMIT_BURST` | `1` | Token bucket capacity; 1 = strict pacing, no burst |
| `CONCURRENCY` | `5` | Global in-flight checks |
| `MAX_RETRIES` | `3` | Retries after the first attempt |
| `REQUEST_TIMEOUT_MS` | `10000` | Per check |
| `BATCH_LIST_CACHE_TTL` | `30` | Seconds |
| `API_INTERNAL_URL` | `http://api:4000` | Server-side URL used by Next |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | Browser-side URL; baked in at build time |

## Assumptions

- "Retries: up to 3" means the first attempt plus 3 retries — 4 attempts total (`MAX_RETRIES=3`).
- A `4xx` is a completed check, not a failure: the server answered. Only network errors and `5xx`
  count as failures for "retry failed only".
- Cancelled URLs are eligible for "retry failed", since they never received an answer.
- Duplicate URLs within one batch are collapsed to a single check.
- A CSV may have more than one column. A `url`/`link`/`address` header selects the column; with no
  header, the first cell in each row that looks like a URL is taken. Other columns are ignored rather
  than submitted and silently rejected server-side.
- No auth, so all batches are visible to everyone — out of scope per the brief.
- `NEXT_PUBLIC_API_URL` defaults to `localhost`, which assumes the browser runs on the Docker host.
