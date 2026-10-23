import { useEffect, useState, type ReactNode } from 'react';
import { createCompiler, type PdfClient, type PdfCompiler } from '@typfolio/core';
import { fontUrls, loadFonts, loadWasm, type FontUrls } from './assets.ts';

type BoundaryState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly client: PdfCompiler }
  | { readonly status: 'error'; readonly error: unknown };

interface CompilerBoundaryProps {
  readonly children: (fonts: FontUrls, client: PdfClient) => ReactNode;
  readonly label: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Registers the fonts with the browser, creates a direct main-thread compiler that fetches
 * the same font URLs, and hands it to the children. Children render only when both exist.
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
      const [wasm] = await Promise.all([loadWasm(), loadFonts()]);
      if (stopped) return;
      const created = await createCompiler({ wasm, fonts: fontUrls });
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
  return children(fontUrls, state.client);
}
