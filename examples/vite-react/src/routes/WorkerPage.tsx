import { createWorkerClient } from '@typfolio/workers';
import type { RuntimeProfile } from '../App.tsx';
import { ClientPage } from '../ClientPage.tsx';
import { loadFontBytes, wasmUrl } from '../assets.ts';

const profile: RuntimeProfile = {
  eyebrow: 'Worker compiler',
  clientBadge: 'Worker client',
  executionBadge: 'Lazy WASM',
  heroCopy: 'This route injects @typfolio/workers into the same React components. The pool and its WASM compiler start lazily when the first document is requested.',
  boundaryTitle: 'Heavy-work path',
  boundaryCopy: 'Effect-backed scheduling stays inside the optional workers package, while React consumes the same PdfClient contract.',
  compilingCopy: 'Typst is assembling a tagged PDF in a dedicated browser worker.',
  runtimeLineOne: 'Lazy @typfolio/workers compiler pool',
  runtimeLineTwo: 'React state from @typfolio/react',
  runtimeLineThree: 'Hard cancellation by terminating the active worker',
  runtimeEmphasis: 'Responsive by design.',
  runtimeNote: 'The worker and WASM initialize on the first compile and remain warm for later requests.',
};

async function createWorkersClient() {
  return createWorkerClient({
    compiler: {
      wasm: wasmUrl,
      fonts: [await loadFontBytes()],
    },
    timeoutMs: 30_000,
  });
}

export default function WorkerPage() {
  return (
    <ClientPage
      createClient={createWorkersClient}
      loadingCopy="Loading the report font; the worker and WASM stay lazy until Generate PDF is selected…"
      profile={profile}
    />
  );
}
