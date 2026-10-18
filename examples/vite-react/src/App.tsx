import { useState, type FormEvent } from 'react';
import { templateFromFiles, type PdfRequest } from '@typfolio/core';
import {
  usePdfCompilation,
  usePdfObjectUrl,
  type PdfCompilationStatus,
} from '@typfolio/react';
import type { ReportInput } from './report/input.ts';
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
}

// The glob stays literal here so Vite can analyse it; report.schema.json is for the editor and is not matched, so it is never sent at runtime.
const template = templateFromFiles(
  import.meta.glob<string>('./report/**/*.typ', { query: '?raw', import: 'default', eager: true }),
);

function makeRequest(title: string, summary: string, profile: RuntimeProfile): PdfRequest<ReportInput> {
  return {
    template,
    input: {
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
    },
    pdf: { standards: ['ua-1'] },
  };
}

function statusLabel(status: PdfCompilationStatus): string {
  switch (status) {
    case 'idle': return 'Ready';
    case 'compiling': return 'Compiling';
    case 'success': return 'Complete';
    case 'error': return 'Failed';
    case 'cancelled': return 'Cancelled';
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

export function App({ profile }: AppProps) {
  const pdf = usePdfCompilation();
  const [title, setTitle] = useState('Designing resilient document workflows');
  const [summary, setSummary] = useState(
    'A concise field note on keeping document generation portable: application data stays outside the renderer, compilation stays behind one client contract, and heavier execution remains an explicit choice.',
  );
  const [durationMs, setDurationMs] = useState<number>();
  const downloadUrl = usePdfObjectUrl(pdf.result);

  const compile = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const startedAt = performance.now();
    setDurationMs(undefined);
    try {
      await pdf.compile(makeRequest(title.trim(), summary.trim(), profile));
      setDurationMs(performance.now() - startedAt);
    } catch {
      // The hook exposes failures and cancellation through its state.
    }
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
              <span className="file-label">input.json</span>
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
                disabled={pdf.isCompiling || title.trim() === '' || summary.trim() === ''}
                type="submit"
              >
                {pdf.isCompiling ? <span className="button-spinner" /> : null}
                {pdf.isCompiling ? 'Building PDF' : 'Generate PDF'}
              </button>
              {pdf.isCompiling ? (
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

            {downloadUrl !== undefined && pdf.result !== undefined ? (
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
                <iframe className="pdf-preview" src={downloadUrl} title="Generated PDF preview" />
                <a className="button button--download" download="typfolio-report.pdf" href={downloadUrl}>
                  Download PDF <span aria-hidden="true">↓</span>
                </a>
              </div>
            ) : pdf.status === 'error' ? (
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
                <h3>{pdf.isCompiling ? 'Typesetting your document' : 'Your preview will appear here'}</h3>
                <p>
                  {pdf.isCompiling
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
