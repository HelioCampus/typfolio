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

export function usePdfClient(): PdfClient {
  const client = useContext(PdfClientContext);
  if (client === undefined) throw new Error('usePdfClient must be used within a PdfProvider');
  return client;
}
