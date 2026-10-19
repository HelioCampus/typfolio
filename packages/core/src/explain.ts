import { errorLink, TypstPdfError, type Diagnostic } from './types.js';

const decoder = new TextDecoder();

function resolve(from: string, path: string): string {
  const parts = path.startsWith('/') ? [] : from.split('/').slice(1, -1);
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

// The file a missing-file diagnostic is about. Typst reports only "failed to load file (is a
// directory)", with the range of the path string in the file that reads it.
function missingPath(diagnostic: Diagnostic, files: ReadonlyMap<string, Uint8Array>): string | undefined {
  if (!/failed to load file/.test(diagnostic.message) || diagnostic.package || !diagnostic.path) return undefined;
  const source = files.get(diagnostic.path);
  const range = /^(\d+):(\d+)-(\d+):(\d+)$/.exec(diagnostic.range ?? '');
  if (!source || !range || range[1] !== range[3]) return undefined;
  const literal = decoder.decode(source).split('\n')[Number(range[1])]?.slice(Number(range[2]), Number(range[4])).trim();
  const quoted = literal && /^"([^"\\]*)"$/.exec(literal);
  return quoted ? resolve(diagnostic.path, quoted[1]) : undefined;
}

/** Turns each "failed to load file" diagnostic about a file the request lacks into `file-not-found`. */
export function explainCompileError(error: unknown, files: ReadonlyMap<string, Uint8Array>): unknown {
  if (!(error instanceof TypstPdfError) || error.code !== 'COMPILATION') return error;
  let found = false;
  const diagnostics = error.diagnostics.map(diagnostic => {
    const file = missingPath(diagnostic, files);
    if (file === undefined || files.has(file)) return diagnostic;
    found = true;
    const message = `File not found: ${file} (read by ${diagnostic.path}). See ${errorLink('file-not-found')}`;
    return { ...diagnostic, code: 'file-not-found' as const, file, message };
  });
  return found ? new TypstPdfError('COMPILATION', diagnostics.map(d => d.message).join('\n'), diagnostics, { cause: error }) : error;
}
