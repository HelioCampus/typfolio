import { useState } from 'react';
import { createCompiler, templateFromFiles } from '@typfolio/core';
import { usePdf, type PdfStatus } from '@typfolio/react';
import type { RuntimeProfile } from '../App.tsx';
import { ClientPage } from '../ClientPage.tsx';
import { ChartGoalColor, LevelsChart, type Level } from '../LevelsChart.tsx';
import { Topbar } from '../Topbar.tsx';
import { fontUrl, wasmUrl } from '../assets.ts';
import type { OutcomesInput } from '../outcomes/input.ts';

const profile: RuntimeProfile = {
  eyebrow: 'Charts for the PDF',
  clientBadge: 'Core client',
  executionBadge: 'Main thread',
  heroCopy: '',
  boundaryTitle: '',
  boundaryCopy: '',
  compilingCopy: '',
  runtimeLineOne: '',
  runtimeLineTwo: '',
  runtimeLineThree: '',
  runtimeEmphasis: '',
  runtimeNote: '',
};

const template = templateFromFiles(
  import.meta.glob<string>('../outcomes/**/*.typ', { query: '?raw', import: 'default', eager: true }),
);

interface Outcome {
  readonly name: string;
  readonly goal: number;
  readonly levels: readonly Level[];
}

const levelNames = ['Exemplary', 'Proficient', 'Developing', 'Beginning'];
const outcomes: readonly Outcome[] = [
  'Written communication', 'Quantitative reasoning', 'Critical thinking',
  'Information literacy', 'Ethical reasoning', 'Teamwork',
].map((name, index) => ({
  name,
  goal: 18,
  levels: levelNames.map((level, rank) => ({ name: level, students: ((index + 2) * (rank + 3) * 7) % 17 + 2 })),
}));

// The PDF's image box: 480 × 160 px, whatever size the page shows the chart at.
const pdfChart = { width: 480, height: 160 } as const;

// Chart text is measured and drawn in the PDF's font.
const charts = {
  fonts: [{ family: 'Libertinus Serif', source: fontUrl }],
  fontFamily: 'Libertinus Serif',
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function proficient(outcome: Outcome): number {
  return outcome.levels.slice(0, 2).reduce((sum, level) => sum + level.students, 0);
}

function statusLabel(status: PdfStatus): string {
  switch (status) {
    case 'idle': return 'Ready';
    case 'drawing': return 'Drawing charts';
    case 'compiling': return 'Compiling';
    case 'success': return 'Complete';
    case 'error': return 'Failed';
  }
}

function formatBytes(value: number): string {
  return new Intl.NumberFormat('en', { maximumFractionDigits: 1, style: 'unit', unit: 'kilobyte', unitDisplay: 'short' })
    .format(value / 1_000);
}

function ChartsApp() {
  const [requested, setRequested] = useState(false);
  const pdf = usePdf<OutcomesInput>({
    template,
    // Built once (no deps): each render() draws a chart for the PDF and returns its path.
    input: ({ render }) => ({
      title: 'Outcome results',
      generatedAt: new Intl.DateTimeFormat('en', { dateStyle: 'long' }).format(new Date()),
      outcomes: outcomes.map(outcome => ({
        name: outcome.name,
        summary: `${proficient(outcome)} students reached Proficient or above; the goal is ${outcome.goal}.`,
        chart: render(<LevelsChart levels={outcome.levels} goal={outcome.goal} {...pdfChart} />),
        chartAlt: `Students per level for ${outcome.name}: ` +
          outcome.levels.map(level => `${level.name} ${level.students}`).join(', ') + '.',
      })),
    }),
    pdf: { standards: ['ua-1'] },
    charts,
    enabled: requested,
  });

  return (
    <div className="app-shell">
      <Topbar clientBadge={profile.clientBadge} executionBadge={profile.executionBadge} />
      <pdf.AssetRenderer />
      <main>
        <section className="hero">
          <div>
            <p className="eyebrow">{profile.eyebrow}</p>
            <h1>Draw once more,<br />at the PDF's size.</h1>
          </div>
          <p className="hero-copy">
            The page shows each chart at the width it has. For the PDF, usePdf draws every chart again in a hidden
            renderer at the template's image size, in the PDF's font, puts the paths in the input, and compiles.
          </p>
        </section>

        <section className="workspace" aria-label="Chart export workspace">
          <div className="panel editor-panel">
            <div className="panel-heading">
              <div>
                <p className="section-number">01</p>
                <h2>Outcomes on the page</h2>
              </div>
              <span className="file-label">{outcomes.length} charts</span>
            </div>
            <div className="chart-grid">
              {outcomes.map(outcome => (
                <figure key={outcome.name} className="chart-card">
                  <figcaption>{outcome.name}</figcaption>
                  <LevelsChart levels={outcome.levels} goal={outcome.goal} width={260} height={120} />
                </figure>
              ))}
            </div>
            <div className="actions">
              <button
                className="button button--primary"
                disabled={pdf.isFetching}
                onClick={() => (requested ? pdf.rebuild() : setRequested(true))}
                type="button"
              >
                {pdf.isFetching ? <span className="button-spinner" /> : null}
                {pdf.isFetching ? statusLabel(pdf.status) : 'Generate PDF'}
              </button>
            </div>
          </div>

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
                    <span>Charts</span>
                    <strong>{outcomes.length}</strong>
                  </div>
                  <div>
                    <span>File size</span>
                    <strong>{formatBytes(pdf.result.bytes.length)}</strong>
                  </div>
                  <div>
                    <span>Diagnostics</span>
                    <strong>{pdf.diagnostics.length}</strong>
                  </div>
                </div>
                <iframe className="pdf-preview" src={pdf.url} title="Generated PDF preview" />
                <button className="button button--download" onClick={() => pdf.download('outcome-results')} type="button">
                  Download PDF <span aria-hidden="true">↓</span>
                </button>
              </div>
            ) : pdf.isError ? (
              <div className="empty-state empty-state--error">
                <span className="empty-icon">!</span>
                <h3>Export failed</h3>
                <p>{describeError(pdf.error)}</p>
              </div>
            ) : (
              <div className="empty-state">
                <h3>{pdf.isFetching ? 'Drawing and typesetting' : 'Your preview will appear here'}</h3>
                <p>Generate the PDF to draw the charts at the template's size.</p>
              </div>
            )}
          </section>
        </section>
      </main>
    </div>
  );
}

function createDirectClient() {
  return createCompiler({ wasm: wasmUrl, fonts: [fontUrl] });
}

export default function ChartsPage() {
  return (
    <ClientPage
      createClient={createDirectClient}
      loadingCopy="Loading the Typst WASM engine and report font on the main thread…"
      profile={profile}
    >
      {/* App context the charts read; the PDF's copies see it too, through <pdf.AssetRenderer />. */}
      <ChartGoalColor.Provider value="#c0392b">
        <ChartsApp />
      </ChartGoalColor.Provider>
    </ClientPage>
  );
}
