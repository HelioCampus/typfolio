import type { PdfResult } from '@typfolio/core';
import { useEffect, useState } from 'react';

/**
 * Exposes a PDF result as a browser object URL and revokes the URL whenever
 * the result changes or the consumer unmounts.
 */
export function usePdfObjectUrl(result: PdfResult | undefined): string | undefined {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    if (result === undefined) {
      setUrl(undefined);
      return;
    }

    const bytes = Uint8Array.from(result.bytes);
    const nextUrl = URL.createObjectURL(new Blob([bytes.buffer], { type: 'application/pdf' }));
    setUrl(nextUrl);

    return () => URL.revokeObjectURL(nextUrl);
  }, [result]);

  return url;
}
