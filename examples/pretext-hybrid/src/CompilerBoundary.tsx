import { useEffect, useState, type ReactNode } from 'react';
import { createCompiler, type PdfCompiler } from '@typfolio/core';
import { PdfProvider } from '@typfolio/react';
import { fontUrls, loadFonts, wasmUrl, type FontUrls } from './assets.ts';

type BoundaryState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly client: PdfCompiler }
  | { readonly status: 'error'; readonly error: unknown };

interface CompilerBoundaryProps {
  readonly children: (fonts: FontUrls) => ReactNode;
  readonly label: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Registers the fonts with the browser, creates a direct main-thread compiler that fetches
 * the same font URLs, and injects it through the headless React provider. Children render
 * only when both exist.
 */
export function CompilerBoundary({ children, label }: CompilerBoundaryProps) {
  const [state, setState] = useState<BoundaryState>({ status: 'loading' });

  useEffect(() => {
    let compiler: PdfCompiler | undefined;
    let stopped = false;

    const dispose = (value: PdfCompiler): void => {
      void value.dispose().catch(error => console.error('Could not dispose the compiler', error));
    };

    void (async () => {
      await loadFonts();
      const created = await createCompiler({ wasm: wasmUrl, fonts: fontUrls });
      if (stopped) {
        dispose(created);
        return;
      }
      compiler = created;
      setState({ status: 'ready', client: created });
    })().catch(error => {
      if (!stopped) setState({ status: 'error', error });
    });

    return () => {
      stopped = true;
      if (compiler !== undefined) dispose(compiler);
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="boot" role="status">
        <span className="spinner" aria-hidden="true" />
        <p>{label}</p>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="boot boot--error" role="alert">
        <p><strong>Could not start.</strong> {describeError(state.error)}</p>
      </div>
    );
  }
  return <PdfProvider client={state.client}>{children(fontUrls)}</PdfProvider>;
}
