import { lazy, Suspense, useCallback, useState } from 'react';
import { MODE_LABELS, ModeSwitch, type PreviewMode } from './chrome.tsx';
import { PdfFrame } from '../PdfFrame.tsx';
import { ProofBar } from './proof.tsx';

// pdf.js only loads when the Viewer is first shown.
const StaticViewer = lazy(() => import('./StaticViewer.tsx'));

interface StaticPreviewProps {
  /** Result of a single capture / flipbook, compiled on the main thread. */
  readonly bytes: Uint8Array | undefined;
  /** Object URL of `bytes` (from `usePdfObjectUrl`), for the native viewer. */
  readonly url: string | undefined;
  readonly pending: boolean;
  readonly error: unknown;
  readonly aspect: number;
  readonly maxWidth: number;
  readonly documentName: string;
  readonly downloadName: string;
  readonly pages?: number | undefined;
}

/**
 * The non-live result view: Native (Chrome's viewer, the original behaviour) or
 * Viewer (pdf.js pages stacked with our own chrome). Both show the same bytes.
 */
export function StaticPreview(props: StaticPreviewProps) {
  const [mode, setMode] = useState<PreviewMode>('native');
  const [counted, setCounted] = useState<{ bytes: Uint8Array; pages: number }>();
  const { bytes } = props;
  const onPages = useCallback((pages: number) => {
    if (bytes !== undefined) setCounted({ bytes, pages });
  }, [bytes]);
  const getFrame = useCallback(
    () => (bytes === undefined ? undefined : { bytes, pages: counted?.bytes === bytes ? counted.pages : props.pages ?? 1 }),
    [bytes, counted, props.pages],
  );

  return (
    <>
      <ModeSwitch modes={['viewer', 'native']} onChange={setMode} value={mode} />
      {mode === 'viewer' && bytes !== undefined ? (
        <Suspense fallback={<div className="pdf-empty"><span className="spinner" aria-hidden="true" /></div>}>
          <StaticViewer aspect={props.aspect} bytes={bytes} maxWidth={props.maxWidth} name={props.documentName} onPages={onPages} />
        </Suspense>
      ) : (
        <>
          <PdfFrame
            aspect={props.aspect}
            error={props.error}
            fileName={props.downloadName}
            maxWidth={props.maxWidth}
            pending={props.pending}
            url={props.url}
          />
          {mode === 'native' ? <p className="native-caption">{MODE_LABELS.native.hint}.</p> : null}
        </>
      )}
      <ProofBar fileName={props.downloadName} getFrame={getFrame} />
    </>
  );
}
