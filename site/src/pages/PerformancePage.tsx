import { useState } from 'react';
import { Shell } from '../Shell.tsx';
import { BatchWorkbench, engineFromUrl } from '../batch/App.tsx';
import type { Engine } from '../batch/batch.ts';

// The introduction says how the PDFs are made, so it follows the engine switch.
const ledes: Record<Engine, string> = {
  typst: 'One Typst template and a different JSON input per document, compiled to tagged PDF in Web Workers. Nothing is sent to a server: the data below is synthetic and generated on this page. The engine switch runs the same batch through the experimental paramdoc runtime, which ships no compiler.',
  paramdoc: 'One Typst template, typeset once by Typst at export time into a document with slots, and a different JSON input per document filled into those slots in Web Workers, with no compiler on the page. Each PDF is the tagged PDF/UA-1 that Typst would write for that data, glyph for glyph, or the input is refused. Nothing is sent to a server: the data below is synthetic and generated on this page. The engine switch runs the same batch through the Typst compiler.',
};

export default function PerformancePage() {
  const [engine, setEngine] = useState<Engine>(engineFromUrl);
  return (
    <Shell
      section="performance"
      wide
      eyebrow="Performance · worker batch"
      title="1000 PDFs in the browser, on workers"
      lede={ledes[engine]}
    >
      <BatchWorkbench engine={engine} onEngineChange={setEngine} />
    </Shell>
  );
}
