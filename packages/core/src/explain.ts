import { errorLink, TypstPdfError, type Diagnostic } from './types.js';

// The compiler reports a file the request lacks as "file not found (searched at /the/path)", at the range of the
// import, include or read in the file that asked for it; a file inside a Typst package is the package's business.
function missingPath(diagnostic: Diagnostic): string | undefined {
  if (diagnostic.package || !diagnostic.path) return undefined;
  return /^file not found \(searched at (\/[^)]*)\)$/.exec(diagnostic.message)?.[1];
}

/** Turns each "file not found" diagnostic about a file the request lacks into `file-not-found`. */
export function explainCompileError(error: unknown, files: ReadonlyMap<string, Uint8Array>): unknown {
  if (!(error instanceof TypstPdfError) || error.code !== 'COMPILATION') return error;
  let found = false;
  const diagnostics = error.diagnostics.map(diagnostic => {
    const file = missingPath(diagnostic);
    if (file === undefined || files.has(file)) return diagnostic;
    found = true;
    const message = `File not found: ${file} (read by ${diagnostic.path}). See ${errorLink('file-not-found')}`;
    return { ...diagnostic, code: 'file-not-found' as const, file, message };
  });
  return found ? new TypstPdfError('COMPILATION', diagnostics.map(d => d.message).join('\n'), diagnostics, { cause: error }) : error;
}
