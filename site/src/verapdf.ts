// The site's veraPDF validator, for the pages that hand it to something else (the tags panel on /inspect). It runs
// in the module worker served at /verapdf/worker.js, which is not part of this bundle; a site built without the
// validator has no /verapdf/manifest.json, and then there is none.
import type { StructurePanelValidator } from '@typfolio/dev-tools/panel';

export interface SiteValidator extends Required<StructurePanelValidator> {
  dispose(): void;
}

/** Starts the validator, or resolves to undefined when this build of the site does not include it. */
export async function startValidator(): Promise<SiteValidator | undefined> {
  try {
    const response = await fetch('/verapdf/manifest.json');
    // A static host's fallback page is not a manifest.
    if (!response.ok || !response.headers.get('content-type')?.includes('json')) return undefined;
  } catch {
    return undefined;
  }
  const worker = new Worker('/verapdf/worker.js', { type: 'module' });
  const pending = new Map<number, { resolve(value: never): void; reject(error: Error): void }>();
  let next = 0;
  await new Promise<void>((resolve, reject) => {
    worker.onerror = event => reject(new Error(event.message || 'the validator could not be started'));
    worker.onmessage = ({ data }) => {
      if (data.ready) return resolve();
      if (data.failed) return reject(new Error(data.failed));
      if (data.id === undefined) return;
      const waiting = pending.get(data.id);
      pending.delete(data.id);
      if (data.error !== undefined) waiting?.reject(new Error(data.error));
      else waiting?.resolve((data.flavours ?? data.reports[0]) as never);
    };
  });
  const ask = <Result>(pdf: Uint8Array, flavour: string) => new Promise<Result>((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, pdf, flavour });
  });
  return {
    validate: (pdf, { flavour }) => ask(pdf, flavour),
    detectFlavours: pdf => ask(pdf, 'detect'),
    dispose: () => worker.terminate(),
  };
}
