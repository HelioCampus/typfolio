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
  return mountStructureDevtools({ pdfjs, validator: await validator() });
}

// The veraPDF view of the panel, when the validator has been built here (`npm run build:verapdf`; it is not built in
// CI and not published yet). A glob, not an import: a file that is not there is an empty match, not a build error.
const binaries = import.meta.glob<string>('../../../packages/verapdf-wasm/generated/verapdf.wasm', { query: '?url', import: 'default' });

async function validator() {
  const binary = Object.values(binaries)[0];
  if (!binary) return undefined;
  try {
    const [{ createPdfValidator }, url] = await Promise.all([import('@typfolio/dev-tools/validate'), binary()]);
    return await createPdfValidator({ wasm: await (await fetch(url)).arrayBuffer() });
  } catch (error) {
    console.warn('The veraPDF view is left out: the validator could not be started.', error);
    return undefined;
  }
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
