import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link } from '@tanstack/react-router';
import './styles.css';

// The validator is not part of this bundle: it is served beside the site at /verapdf/ (tools/prepare-verapdf-demo.ts)
// and runs in a module worker started by URL. A build made without it has no /verapdf/manifest.json, and says so.
const flavours = {
  ua1: 'PDF/UA-1', ua2: 'PDF/UA-2',
  '1a': 'PDF/A-1a', '1b': 'PDF/A-1b', '2a': 'PDF/A-2a', '2b': 'PDF/A-2b', '2u': 'PDF/A-2u', '3a': 'PDF/A-3a', '3b': 'PDF/A-3b', '3u': 'PDF/A-3u',
  '4': 'PDF/A-4', '4e': 'PDF/A-4e', '4f': 'PDF/A-4f',
  wt1a: 'WTPDF 1.0 Accessibility', wt1r: 'WTPDF 1.0 Reuse',
} as const;
type Flavour = keyof typeof flavours;
const order: Flavour[] = ['ua1', 'ua2', '1a', '1b', '2a', '2b', '2u', '3a', '3b', '3u', '4', '4e', '4f', 'wt1a', 'wt1r'];
type Choice = Flavour | 'declared';

interface Check { context: string; error: string }
interface Rule { specification: string; clause: string; test: number; failedChecks: number; message: string; object: string; condition: string; tags: string[]; checks: Check[] }
interface Report {
  flavour: Flavour;
  compliant: boolean;
  totalAssertions: number;
  profile: { name: string; description: string; rules: number };
  failedRules: Rule[];
  logs: { level: string; message: string; occurrences: number }[];
}
interface Manifest { verapdf: string; graalvm: string; wasmBytes: number; gzipBytes: number; wasmSha256: string }
interface Result { name: string; bytes: number; sha256: string; ms: number; reports?: Report[]; error?: string }

type Status =
  | { state: 'starting'; progress?: number }
  | { state: 'ready'; ms: number }
  | { state: 'unavailable' }
  | { state: 'failed'; message: string };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const kilobytes = (bytes: number) => `${(bytes / 1024).toFixed(bytes < 102400 ? 1 : 0)} kB`;

/** The manifest of the validator this site was built with, or undefined when it was built without one. */
async function readManifest(): Promise<Manifest | undefined> {
  try {
    const response = await fetch('/verapdf/manifest.json');
    // A static host's fallback page is not a manifest.
    if (!response.ok || !response.headers.get('content-type')?.includes('json')) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

/** A command or a snippet with a button that copies it. */
function Command({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState<boolean>();
  useEffect(() => {
    if (copied === undefined) return;
    const timer = setTimeout(() => setCopied(undefined), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <figure className="validate-command">
      <figcaption>{label}</figcaption>
      <pre><code>{text}</code></pre>
      <button type="button" className="button button--small" onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false))}>
        <span aria-live="polite">{copied === undefined ? 'Copy' : copied ? 'Copied' : 'Not copied'}</span>
      </button>
    </figure>
  );
}

function ReportView({ report }: { report: Report }) {
  const failedChecks = report.failedRules.reduce((sum, rule) => sum + rule.failedChecks, 0);
  return (
    <section className="validate-report" aria-label={`${flavours[report.flavour]} report`}>
      <p className="validate-summary">
        {report.compliant
          ? `${flavours[report.flavour]}: passes all ${plural(report.totalAssertions, 'check')}.`
          : `${flavours[report.flavour]}: fails ${report.failedRules.length} of ${plural(report.profile.rules, 'rule')}. ${plural(report.totalAssertions - failedChecks, 'check')} passed, ${failedChecks} failed.`}
      </p>
      {report.logs.length > 0 ? (
        <details className="validate-logs" open={report.compliant}>
          <summary>veraPDF logged {plural(report.logs.length, 'message')} while reading the file{report.compliant ? ': it validated what it could read' : ''}</summary>
          <ul>{report.logs.map((log, index) => <li key={index}>{log.level}{log.occurrences > 1 ? ` (${log.occurrences}×)` : ''}: {log.message}</li>)}</ul>
        </details>
      ) : null}
      {report.failedRules.length > 0 ? (
        <ul className="validate-rules">
          {report.failedRules.map(rule => (
            <li key={`${rule.specification} ${rule.clause} ${rule.test}`}>
              <details>
                <summary>
                  <span className="validate-clause">{rule.specification}, {rule.clause}, test {rule.test}</span>
                  {rule.failedChecks > 1 ? <span className="validate-count"> · {rule.failedChecks} failed checks</span> : null}
                  {rule.tags.map(tag => <span key={tag} className="validate-tag">{tag}</span>)}
                  <span className="validate-message">{rule.message}</span>
                </summary>
                <ol className="validate-checks">
                  {rule.checks.map((check, index) => (
                    <li key={index}>
                      {check.error}
                      <code title="Where the check failed, in veraPDF’s model of the file">{check.context}</code>
                    </li>
                  ))}
                  {rule.failedChecks > rule.checks.length ? <li className="validate-more">… and {rule.failedChecks - rule.checks.length} more</li> : null}
                </ol>
                <p className="validate-condition">Checked on {rule.object}: {rule.condition}</p>
              </details>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="validate-note">{report.profile.name}: {plural(report.profile.rules, 'rule')}. {report.profile.description}.</p>
    </section>
  );
}

export function ValidateWorkbench() {
  const [status, setStatus] = useState<Status>({ state: 'starting' });
  const [manifest, setManifest] = useState<Manifest>();
  const [choice, setChoice] = useState<Choice>('declared');
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);
  const [over, setOver] = useState(false);
  const worker = useRef<Worker | undefined>(undefined);
  const pending = useRef(new Map<number, (data: { reports?: Report[]; error?: string; ms: number }) => void>());
  const next = useRef(0);

  useEffect(() => {
    let current = true;
    (async () => {
      const found = await readManifest();
      if (!current) return;
      if (!found) return setStatus({ state: 'unavailable' });
      setManifest(found);
      const started = new Worker('/verapdf/worker.js', { type: 'module' });
      worker.current = started;
      started.onerror = event => setStatus({ state: 'failed', message: event.message || 'the worker could not be started' });
      started.onmessage = ({ data }) => {
        if (data.progress !== undefined) return setStatus(previous => previous.state === 'starting' ? { state: 'starting', progress: data.progress } : previous);
        if (data.ready) return setStatus({ state: 'ready', ms: data.ms });
        if (data.failed) return setStatus({ state: 'failed', message: data.failed });
        pending.current.get(data.id)?.(data);
        pending.current.delete(data.id);
      };
    })();
    return () => {
      current = false;
      worker.current?.terminate();
      worker.current = undefined;
    };
  }, []);

  // Each file against the choice, one after the other; a newer run takes the place of an older one.
  const run = useRef(0);
  useEffect(() => {
    if (status.state !== 'ready' || files.length === 0) return;
    const mine = ++run.current;
    setRunning(true);
    setResults([]);
    (async () => {
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        const answer = await new Promise<{ reports?: Report[]; error?: string; ms: number }>(resolve => {
          const id = next.current++;
          pending.current.set(id, resolve);
          worker.current?.postMessage({ id, pdf: bytes, flavour: choice });
        });
        if (mine !== run.current) return;
        setResults(previous => [...previous, { name: file.name, bytes: file.size, sha256, ...answer }]);
      }
      if (mine === run.current) setRunning(false);
    })();
  }, [status.state, files, choice]);

  const take = (list: FileList | null) => {
    const pdfs = [...list ?? []].filter(file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
    if (pdfs.length > 0) setFiles(pdfs);
  };
  const drop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setOver(false);
    take(event.dataTransfer.files);
  };
  const download = (result: Result) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ file: result.name, bytes: result.bytes, sha256: result.sha256, validator: manifest, reports: result.reports }, null, 2)], { type: 'application/json' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: `${result.name.replace(/\.pdf$/i, '')}.verapdf.json` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (status.state === 'unavailable') {
    return (
      <div className="card validate-card">
        <p className="validate-unavailable" role="status">
          This build of the site does not include the validator. It is built separately from the rest of Typfolio (<code>npm run build:verapdf</code>), and the site was built without it.
        </p>
      </div>
    );
  }
  return (
    <div className="validate">
      <div className="card validate-card">
        <div className="validate-controls">
          <label className="validate-choice">
            Validate against
            {/* The box draws the select's arrow itself: the native one differs from one browser to the next. */}
            <span className="validate-choice-box">
              <select value={choice} onChange={event => setChoice(event.target.value as Choice)} aria-label="What to validate against">
                <option value="declared">What the file declares</option>
                {order.map(id => <option key={id} value={id}>{flavours[id]}</option>)}
              </select>
            </span>
          </label>
          <span className="validate-status" role="status">
            {status.state === 'starting' ? `Loading the validator${status.progress === undefined || !manifest ? '…' : `: ${Math.round(status.progress * 100)}% of ${megabytes(manifest.gzipBytes)}`}`
              : status.state === 'failed' ? `The validator could not be started: ${status.message}`
              : running ? 'Validating…'
              : `Validator ready in ${(status.ms / 1000).toFixed(1)} s`}
          </span>
        </div>
        <label className="validate-drop" data-over={over} onDragOver={event => { event.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
          <input type="file" accept="application/pdf,.pdf" multiple onChange={event => take(event.target.files)} />
          <strong>Drop PDF files here</strong>, or click to choose them. They stay on this device.
        </label>
      </div>
      <div className="validate-results" aria-live="polite">
        {results.map((result, index) => (
          <article key={`${index} ${result.sha256}`} className="card validate-card validate-file">
            <header>
              <h2>{result.name}</h2>
              {result.error !== undefined ? <span className="validate-verdict" data-verdict="error">ERROR</span>
                : result.reports!.length === 0 ? <span className="validate-verdict" data-verdict="none">NOT VALIDATED</span>
                : result.reports!.map(report => <span key={report.flavour} className="validate-verdict" data-verdict={report.compliant ? 'pass' : 'fail'}>{report.compliant ? 'PASS' : 'FAIL'} {flavours[report.flavour]}</span>)}
              <span className="validate-meta">{choice === 'declared' && result.reports?.length ? 'declared by the file · ' : ''}{kilobytes(result.bytes)} · {Math.round(result.ms)} ms</span>
              {result.reports?.length ? <button type="button" className="button button--small" onClick={() => download(result)}>Download JSON</button> : null}
            </header>
            {result.error !== undefined ? <p className="validate-note">{result.error}</p>
              : result.reports!.length === 0 ? <p className="validate-note">The file declares no standard in its metadata, so there is nothing to validate it against. Pick a standard above to validate against it anyway.</p>
              : result.reports!.map(report => <ReportView key={report.flavour} report={report} />)}
            <p className="validate-note validate-checksum">SHA-256 {result.sha256}</p>
          </article>
        ))}
      </div>
      <section className="card validate-card validate-use" aria-labelledby="validate-use-title">
        <p className="kicker">Use it yourself</p>
        <h2 id="validate-use-title">The same validator, in your pipeline</h2>
        <p>
          It is an npm package, so it runs wherever Node does, with no Java to install: in a CI step, in a test, or in a script. It validates any PDF, not only ones Typfolio made.
        </p>
        <Command label="Install" text="npm install --save-dev @typfolio/dev-tools @typfolio/verapdf-wasm" />
        <Command label="In CI, or from a shell" text="npx typfolio-validate --flavour auto out/*.pdf" />
        <p className="validate-use-note">
          It exits with 0 when every file passes, 1 when one fails, and 2 for a file that declares no standard or cannot be read, so a failing PDF fails the build. <code>--format json</code> prints the reports for another tool to read.
        </p>
        <Command label="In a test" text={`import { validatePdf } from '@typfolio/dev-tools/validate';

const report = await validatePdf(pdfBytes, { flavour: 'ua1' });
assert.ok(report.compliant && report.logs.length === 0);`} />
        <p className="validate-use-note">
          While you write a template, the <Link to="/inspect">tags panel</Link> of the same package shows the verdict beside the tags, on every compile. Free to use, including in CI; before you ship the validator to others as part of a product, read its <a href="/verapdf/LICENSE.txt">licence</a>.
        </p>
      </section>
      {manifest ? (
        <p className="validate-about">
          veraPDF {manifest.verapdf}, built to WebAssembly with {manifest.graalvm} ({megabytes(manifest.wasmBytes)}, {megabytes(manifest.gzipBytes)} to download).
          {' '}veraPDF is used under the Mozilla Public License 2.0; the runtime inside the binary is under Oracle’s GraalVM Free Terms and Conditions.
          {' '}<a href="/verapdf/LICENSE.txt">Licence</a> · <a href="/verapdf/THIRD_PARTY_NOTICES.md">Third-party notices</a>
        </p>
      ) : null}
    </div>
  );
}
