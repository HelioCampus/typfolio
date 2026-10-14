import { createCompiler } from '@typfolio/core';
import type { RuntimeProfile } from '../App.tsx';
import { ClientPage } from '../ClientPage.tsx';
import { loadFontBytes, wasmUrl } from '../assets.ts';

const profile: RuntimeProfile = {
  eyebrow: 'Direct compiler',
  clientBadge: 'Core client',
  executionBadge: 'Main thread',
  heroCopy: 'This route injects a direct @typfolio/core compiler. It is the smallest setup for occasional documents where main-thread compilation is acceptable.',
  boundaryTitle: 'Lightweight path',
  boundaryCopy: 'This route does not download worker orchestration or the Effect runtime.',
  compilingCopy: 'Typst is assembling a tagged PDF directly in this browser tab.',
  runtimeLineOne: 'Direct @typfolio/core compiler on the main thread',
  runtimeLineTwo: 'React state from @typfolio/react',
  runtimeLineThree: 'No worker orchestration or Effect runtime',
  runtimeEmphasis: 'Small by default.',
  runtimeNote: 'Applications can opt into workers only on pages that need heavier execution.',
};

async function createDirectClient() {
  return createCompiler({
    wasm: wasmUrl,
    fonts: [await loadFontBytes()],
  });
}

export default function DirectPage() {
  return (
    <ClientPage
      createClient={createDirectClient}
      loadingCopy="Loading the Typst WASM engine and report font on the main thread…"
      profile={profile}
    />
  );
}
