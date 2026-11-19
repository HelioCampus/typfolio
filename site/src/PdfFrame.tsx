interface PdfFrameProps {
  readonly url: string | undefined;
  readonly pending: boolean;
  readonly error: unknown;
  readonly aspect: number;
  readonly fileName: string;
  readonly maxWidth?: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Embeds the compiled PDF bytes through the object URL `usePdf` owns. */
export function PdfFrame({ url, pending, error, aspect, fileName, maxWidth = 468 }: PdfFrameProps) {
  return (
    <div className="pdf-frame" style={{ aspectRatio: String(aspect), maxWidth }}>
      {url !== undefined ? (
        <iframe src={`${url}#toolbar=0&navpanes=0&view=Fit`} title="Compiled PDF" />
      ) : error !== undefined ? (
        <div className="pdf-empty pdf-empty--error">
          <strong>Compilation failed</strong>
          <p>{describeError(error)}</p>
        </div>
      ) : (
        <div className="pdf-empty">
          {pending ? <span className="spinner" aria-hidden="true" /> : null}
          <p>{pending ? 'Typst is rendering the placed geometry…' : 'Capture the live frame to render it here.'}</p>
        </div>
      )}
      {url !== undefined ? (
        <a className="pdf-download" download={fileName} href={url}>Download PDF ↓</a>
      ) : null}
    </div>
  );
}
