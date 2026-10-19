import { useEffect, useState, type ReactNode } from 'react';
import type { PdfClient } from '@typfolio/core';
import { App, type RuntimeProfile } from './App.tsx';

interface DisposablePdfClient extends PdfClient {
  dispose(): Promise<void>;
}

interface ClientPageProps {
  /** A worker client is created synchronously; a direct compiler awaits WASM initialization. */
  readonly createClient: () => DisposablePdfClient | Promise<DisposablePdfClient>;
  readonly loadingCopy: string;
  readonly profile: RuntimeProfile;
  /** The page shown once the client is ready, given the client; defaults to the report workspace. */
  readonly children?: (client: PdfClient) => ReactNode;
}

type ClientState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly client: DisposablePdfClient }
  | { readonly status: 'error'; readonly error: unknown };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ClientPage({ createClient, loadingCopy, profile, children }: ClientPageProps) {
  const [state, setState] = useState<ClientState>({ status: 'loading' });

  useEffect(() => {
    let client: DisposablePdfClient | undefined;
    let stopped = false;

    const dispose = (value: DisposablePdfClient): void => {
      void value.dispose().catch(error => {
        console.error('Could not dispose the Typfolio client', error);
      });
    };
    const stop = (): void => {
      stopped = true;
      if (client !== undefined) dispose(client);
      client = undefined;
    };

    window.addEventListener('pagehide', stop, { once: true });
    void Promise.resolve().then(createClient).then(value => {
      if (stopped) {
        dispose(value);
        return;
      }
      client = value;
      setState({ status: 'ready', client: value });
    }, error => {
      if (!stopped) setState({ status: 'error', error });
    });

    return () => {
      window.removeEventListener('pagehide', stop);
      stop();
    };
  }, [createClient]);

  if (state.status === 'loading') {
    return (
      <div className="boot-shell" role="status">
        <div className="boot-mark">T</div>
        <div>
          <p className="eyebrow">{profile.eyebrow}</p>
          <h1>Preparing the client</h1>
          <p>{loadingCopy}</p>
        </div>
        <span className="spinner" aria-hidden="true" />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="boot-shell boot-shell--error" role="alert">
        <div className="boot-mark">!</div>
        <div>
          <p className="eyebrow">Client unavailable</p>
          <h1>Typfolio could not start</h1>
          <p>{describeError(state.error)}</p>
        </div>
      </div>
    );
  }

  return children ? children(state.client) : <App client={state.client} profile={profile} />;
}
