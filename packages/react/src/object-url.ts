import type { PdfResult } from '@typfolio/core';
import { useEffect, useState } from 'react';

/**
 * Exposes a PDF result as a browser object URL and revokes the URL whenever
 * the result changes or the consumer unmounts.
 */
export function usePdfObjectUrl(result: PdfResult | undefined): string | undefined {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    // No result yet, or a platform without object URLs (jsdom, say): no URL.
    if (result === undefined || typeof URL.createObjectURL !== 'function') {
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
