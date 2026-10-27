import { Shell } from '../Shell.tsx';
import { BatchWorkbench } from '../batch/App.tsx';

export default function PerformancePage() {
  return (
    <Shell
      section="performance"
      wide
      eyebrow="Performance · worker batch"
      title="1000 PDFs in the browser, on workers"
      lede="One Typst template and a different JSON input per document, compiled to tagged PDF in Web Workers. Nothing is sent to a server: the data below is synthetic and generated on this page. The engine switch runs the same batch through the experimental paramdoc runtime, which ships no compiler."
    >
      <BatchWorkbench />
    </Shell>
  );
}
