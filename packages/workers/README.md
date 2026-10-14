# @typfolio/workers

Framework-independent module-worker execution for `@typfolio/core`. The package provides a lazy bounded pool, FIFO scheduling, a finite queue, per-job `AbortSignal` cancellation, timeouts, worker replacement, incremental batches, and deterministic disposal.

```ts
import { createWorkerClient } from '@typfolio/workers';
import wasmUrl from '@typfolio/wasm/compiler.wasm?url';

const font = new Uint8Array(await (await fetch('/fonts/report.otf')).arrayBuffer());
const client = createWorkerClient({
  compiler: { wasm: wasmUrl, fonts: [font] },
  workerCount: 2,
  queueLimit: 16,
  timeoutMs: 30_000,
});

try {
  const result = await client.compile(request, { signal });
  // result.bytes is transferred from the worker without copying it again.
} finally {
  await client.dispose();
}
```

Stream a large batch in completion order without retaining every PDF:

```ts
import { compileBatch } from '@typfolio/workers';

for await (const outcome of compileBatch(client, jobs, { signal })) {
  if (outcome.status === 'success') {
    await upload(outcome.id, outcome.result.bytes);
  }
}
```

Use `collectBatch(client, jobs)` when the caller needs all outcomes in input order.

The built-in factory creates a module worker from the packaged runtime. `workerFactory` is available for tests or hosts with custom worker construction. The client owns every worker returned by that factory and terminates it during hard cancellation, transport recovery, or disposal.

## Semantics

- Calls are snapshotted synchronously and compiled FIFO, with one active compile per worker.
- Cancelling a waiting job removes only that job. Cancelling or timing out the active synchronous WASM call terminates its worker; the next queued job receives a fresh worker/compiler.
- A Typst compilation error rejects that job but keeps the worker healthy. A malformed message or worker crash rejects the active job and replaces the worker lazily.
- `queueLimit` counts waiting jobs, not the active compile. Timeouts include queue time.
- `dispose()` is idempotent, rejects all unsettled work with `DISPOSED`, and terminates the owned worker.
- Errors crossing the realm boundary become `TypfolioWorkerError` with stable `code`, `message`, and `diagnostics` fields.

Worker transport accepts a WASM URL string, `ArrayBuffer`, `Uint8Array`, or compiled `WebAssembly.Module`. `Request` and `Response` are intentionally excluded because they are not consistently structured-cloneable across browsers. Inputs and assets are cloned, never transferred, so caller-owned buffers remain usable.

The package uses Effect internally for interruptible jobs, timeout/abort races, scoped client disposal, and bounded completion-order batch streams. The public contract deliberately remains framework-neutral: consumers use Promises, `AbortSignal`, async iterables, and `TypfolioWorkerError`, without needing Effect in application code. The worker wire protocol and explicit `Worker.terminate()` slot recovery remain Typfolio-owned because hard cancellation must stop synchronous WASM.
