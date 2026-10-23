import { useRef, useState, type FormEvent } from 'react';
import { defineTemplate, type PdfClient, type TemplateDefinition } from '@typfolio/core';
import { usePdf, type PdfStatus } from '@typfolio/react';
import type { ReportInput } from './report/input.ts';
import reportSource from './report/main.typ?raw';
import { Topbar } from './Topbar.tsx';

export interface RuntimeProfile {
  readonly eyebrow: string;
  readonly clientBadge: string;
  readonly executionBadge: string;
  readonly heroCopy: string;
  readonly boundaryTitle: string;
  readonly boundaryCopy: string;
  readonly compilingCopy: string;
  readonly runtimeLineOne: string;
  readonly runtimeLineTwo: string;
  readonly runtimeLineThree: string;
  readonly runtimeEmphasis: string;
  readonly runtimeNote: string;
}

interface AppProps {
  readonly profile: RuntimeProfile;
  readonly client: PdfClient;
}

// A template without a schema: its data is not checked, and ReportInput types the call. main.typ reads
// its data at report/report.schema.json: there the editor finds the hand-written JSON Schema, and the
// app's data is mounted when it compiles. The schema file is not one of the files, so it is never sent.
const report: TemplateDefinition<ReportInput> = defineTemplate({
  entrypoint: 'report/main.typ',
  files: { 'report/main.typ': reportSource },
  schemaPath: 'report/report.schema.json',
});

function makeInput(title: string, summary: string, profile: RuntimeProfile): ReportInput {
  return {
    title,
    summary,
    generatedAt: new Intl.DateTimeFormat('en', {
      dateStyle: 'long',
      timeStyle: 'short',
    }).format(new Date()),
    runtimeLineOne: profile.runtimeLineOne,
    runtimeLineTwo: profile.runtimeLineTwo,
    runtimeLineThree: profile.runtimeLineThree,
    runtimeEmphasis: profile.runtimeEmphasis,
    runtimeNote: profile.runtimeNote,
  };
}

const pdfOptions = { standards: ['ua-1' as const] };

function statusLabel(status: PdfStatus): string {
  switch (status) {
    case 'idle': return 'Ready';
    case 'drawing':
    case 'compiling': return 'Compiling';
    case 'success': return 'Complete';
    case 'error': return 'Failed';
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(value: number): string {
  return new Intl.NumberFormat('en', {
    maximumFractionDigits: 1,
    style: 'unit',
    unit: 'kilobyte',
    unitDisplay: 'short',
  }).format(value / 1_000);
}

export function App({ profile, client }: AppProps) {
  const [title, setTitle] = useState('Designing resilient document workflows');
  const [summary, setSummary] = useState(
    'A concise field note on keeping document generation portable: application data stays outside the renderer, compilation stays behind one client contract, and heavier execution remains an explicit choice.',
  );
  // The brief as last submitted: usePdf compiles it once there is one, and again whenever a new one
  // is submitted. The document is written inline: it is compared by its data, not by reference.
  const [submitted, setSubmitted] = useState<ReportInput>();
  const startedAt = useRef(0);
  const [durationMs, setDurationMs] = useState<number>();
  const pdf = usePdf(report(submitted as ReportInput), {
    client,
    // Keep the direct/worker timing comparison free of runtime schema validation.
    validate: false,
    // Disabled until the first submit: nothing is checked or compiled before there is a brief.
    enabled: submitted !== undefined,
    pdf: pdfOptions,
    onSuccess: () => setDurationMs(performance.now() - startedAt.current),
  });

  const compile = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    startedAt.current = performance.now();
    setDurationMs(undefined);
    const next = makeInput(title.trim(), summary.trim(), profile);
    // An unchanged brief is the same data, so compile it again explicitly.
    if (JSON.stringify(next) === JSON.stringify(submitted)) pdf.rebuild();
    else setSubmitted(next);
  };

  return (
    <div className="app-shell">
      <Topbar clientBadge={profile.clientBadge} executionBadge={profile.executionBadge} />

      <main>
        <section className="hero">
          <div>
            <p className="eyebrow">{profile.eyebrow}</p>
            <h1>Shape the content.<br />Ship the document.</h1>
          </div>
          <p className="hero-copy">{profile.heroCopy}</p>
        </section>

        <section className="workspace" aria-label="PDF generation workspace">
          <form className="panel editor-panel" onSubmit={compile}>
            <div className="panel-heading">
              <div>
                <p className="section-number">01</p>
                <h2>Document brief</h2>
              </div>
              <span className="file-label">ReportInput</span>
            </div>

            <label className="field">
              <span>Report title</span>
              <input
                required
                maxLength={120}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>

            <label className="field field--grow">
              <span>Executive summary</span>
              <textarea
                required
                maxLength={800}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
              <small>{summary.length} / 800 characters</small>
            </label>

            <div className="boundary-note">
              <span className="boundary-icon" aria-hidden="true">↗</span>
              <p><strong>{profile.boundaryTitle}</strong> {profile.boundaryCopy}</p>
            </div>

            <div className="actions">
              <button
                className="button button--primary"
                disabled={pdf.isFetching || title.trim() === '' || summary.trim() === ''}
                type="submit"
              >
                {pdf.isFetching ? <span className="button-spinner" /> : null}
                {pdf.isFetching ? 'Building PDF' : 'Generate PDF'}
              </button>
              {pdf.isFetching ? (
                <button className="button button--quiet" onClick={() => pdf.cancel()} type="button">
                  Cancel
                </button>
              ) : null}
            </div>
          </form>

          <section className="panel output-panel" aria-live="polite">
            <div className="panel-heading">
              <div>
                <p className="section-number">02</p>
                <h2>Generated output</h2>
              </div>
              <span className={`status status--${pdf.status}`}>
                <i /> {statusLabel(pdf.status)}
              </span>
            </div>

            {pdf.url !== undefined && pdf.result !== undefined ? (
              <div className="result">
                <div className="result-summary">
                  <div>
                    <span>File size</span>
                    <strong>{formatBytes(pdf.result.bytes.length)}</strong>
                  </div>
                  <div>
                    <span>Compile time</span>
                    <strong>{durationMs === undefined ? '—' : `${Math.round(durationMs)} ms`}</strong>
                  </div>
                  <div>
                    <span>Diagnostics</span>
                    <strong>{pdf.diagnostics.length}</strong>
                  </div>
                </div>
                <iframe className="pdf-preview" src={pdf.url} title="Generated PDF preview" />
                <a className="button button--download" download="typfolio-report.pdf" href={pdf.url}>
                  Download PDF <span aria-hidden="true">↓</span>
                </a>
              </div>
            ) : pdf.isError ? (
              <div className="empty-state empty-state--error">
                <span className="empty-icon">!</span>
                <h3>Compilation failed</h3>
                <p>{describeError(pdf.error)}</p>
              </div>
            ) : (
              <div className="empty-state">
                <div className="document-ghost" aria-hidden="true">
                  <span /><span /><span /><i />
                </div>
                <h3>{pdf.isFetching ? 'Typesetting your document' : 'Your preview will appear here'}</h3>
                <p>
                  {pdf.isFetching
                    ? profile.compilingCopy
                    : 'Edit the brief, generate a PDF, then inspect or download the exact returned bytes.'}
                </p>
              </div>
            )}
          </section>
        </section>
      </main>

      <footer>
        <span>Typfolio development preview</span>
        <span className="footer-rule" />
        <span>Vite · React Router · TypeScript · Typst</span>
      </footer>
    </div>
  );
}
