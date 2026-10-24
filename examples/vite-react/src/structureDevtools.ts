import { useEffect } from 'react';
import type { MountedStructurePanel, StructureDevtoolsOptions } from '@typfolio/dev-tools/panel';

// The PDF tags panel, in development only: `import.meta.env.DEV` is false in a production build, so the imports below
// are dropped and neither the panel nor pdf.js ships.
let panel: Promise<MountedStructurePanel<StructureDevtoolsOptions>> | undefined;

async function mount() {
  const [{ mountStructureDevtools }, pdfjs, { default: workerSrc }] = await Promise.all([
    import('@typfolio/dev-tools/panel'),
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  return mountStructureDevtools({ pdfjs });
}

/** Shows the PDF in the panel while the component is mounted: pass `usePdf`'s `result?.bytes`. */
export function useStructureDevtools(bytes: Uint8Array | undefined): void {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    panel ??= mount();
    void panel.then(mounted => mounted.update({ bytes }));
    return () => void panel?.then(mounted => mounted.update({ bytes: undefined }));
  }, [bytes]);
}
