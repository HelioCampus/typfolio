import type { PdfClient } from '@typfolio/core';
import {
  createContext,
  createElement,
  useContext,
  type ReactElement,
  type ReactNode,
} from 'react';

const PdfClientContext = createContext<PdfClient | undefined>(undefined);

export interface PdfProviderProps {
  readonly client: PdfClient;
  readonly children?: ReactNode;
}

/** Provides a caller-owned client. The provider never disposes it. */
export function PdfProvider({ client, children }: PdfProviderProps): ReactElement {
  return createElement(PdfClientContext.Provider, { value: client }, children);
}

/** The given client, else the one from the nearest `PdfProvider`. */
export function usePdfClient(client?: PdfClient): PdfClient {
  const provided = useContext(PdfClientContext);
  const resolved = client ?? provided;
  if (resolved === undefined) throw new Error('usePdfClient: pass a client, or use it within a PdfProvider');
  return resolved;
}
