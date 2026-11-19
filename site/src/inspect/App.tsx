import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { defineTemplate, TypstPdfError, type PdfClient, type TemplateDefinition } from '@typfolio/core';
import type { MountedStructurePanel, StructurePanelOptions } from '@typfolio/dev-tools/panel';
import { startValidator, type SiteValidator } from '../verapdf.ts';
import template from './report/main.typ?raw';
import './styles.css';

interface InspectInput {
  title: string;
  summary: string;
  rows: { outcome: string; target: number; result: number }[];
  chartAlt: string;
  headings: boolean;
  tableHeader: boolean;
  figureAlt: boolean;
}

const report: TemplateDefinition<InspectInput> = defineTemplate({
  files: { 'main.typ': template },
  schemaPath: 'inspect.schema.json',
});

const rows = [
  { outcome: 'Written communication', target: 70, result: 82 },
  { outcome: 'Quantitative reasoning', target: 70, result: 64 },
  { outcome: 'Critical thinking', target: 70, result: 77 },
  { outcome: 'Information literacy', target: 70, result: 71 },
];
const content = {
  title: 'Learning outcomes, spring term',
  summary: 'Three of the four outcomes met their target this term. Quantitative reasoning fell short by six points, and is the subject of the plan that follows this report.',
  rows,
  chartAlt: `Bar chart of the result for each outcome: ${rows.map(row => `${row.outcome} ${row.result}`).join(', ')}.`,
};

type Standard = 'ua-1' | 'tagged';
const switches = [
  { key: 'headings', label: 'Headings are marked up as headings', off: 'Bold text that only looks like a heading. Nothing flags it: no rule says a one-page document needs headings. Look at the tags, where the titles are now plain paragraphs (P). This is what a person has to check.' },
  { key: 'tableHeader', label: 'The table has a header row', off: 'A table without header cells. A PDF/UA-1 compile and veraPDF both accept it; the warnings notice.' },
  { key: 'figureAlt', label: 'The chart has alternative text', off: 'A figure without alt text. A PDF/UA-1 compile refuses it; as a tagged PDF it compiles, and the warnings notice.' },
] as const;
type SwitchKey = (typeof switches)[number]['key'];

const describe = (error: unknown) => error instanceof TypstPdfError && error.diagnostics.length > 0
  ? error.diagnostics.map(diagnostic => diagnostic.message).join(' ')
  : error instanceof Error ? error.message : String(error);

export function InspectWorkbench({ client }: { client: PdfClient }) {
  const [structure, setStructure] = useState<Record<SwitchKey, boolean>>({ headings: true, tableHeader: true, figureAlt: true });
  const [standard, setStandard] = useState<Standard>('ua-1');
  const [bytes, setBytes] = useState<Uint8Array>();
  const [compile, setCompile] = useState<{ ms?: number; error?: string }>({});
  // undefined while it starts; null when this build of the site has no validator.
  const [validator, setValidator] = useState<SiteValidator | null>();
  const host = useRef<HTMLDivElement>(null);
  const panel = useRef<MountedStructurePanel<StructurePanelOptions> | undefined>(undefined);

  useEffect(() => {
    let current = true;
    let started: SiteValidator | undefined;
    startValidator().then(value => {
      started = value;
      if (current) setValidator(value ?? null);
      else value?.dispose();
    }, () => { if (current) setValidator(null); });
    return () => {
      current = false;
      started?.dispose();
    };
  }, []);

  // The document, compiled again whenever a switch or the standard changes. The compiler takes one job at a time, so
  // compiles wait for the one before; one that has been overtaken by a newer choice is skipped. A compile that is
  // refused leaves the last PDF on show and says why.
  const queue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let current = true;
    queue.current = queue.current.then(async () => {
      if (!current) return;
      const started = performance.now();
      try {
        const result = await client.compile(report({ ...content, ...structure }), { pdf: { standards: standard === 'ua-1' ? ['ua-1'] : [] } });
        if (!current) return;
        setBytes(result.bytes);
        setCompile({ ms: performance.now() - started });
      } catch (error) {
        if (current) setCompile({ error: describe(error) });
      }
    });
    return () => { current = false; };
  }, [client, structure, standard]);

  // The tags panel of @typfolio/dev-tools, in the page: the same one a template author mounts while developing.
  useEffect(() => {
    if (validator === undefined || !host.current) return;
    let current = true;
    const element = host.current;
    pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
    import('@typfolio/dev-tools/panel').then(({ mountStructurePanel }) => {
      if (!current) return;
      panel.current = mountStructurePanel(element, { pdfjs, theme: 'dark', validator: validator ?? undefined });
      setMounted(count => count + 1);
    });
    return () => {
      current = false;
      panel.current?.unmount();
      panel.current = undefined;
    };
  }, [validator]);
  const [mounted, setMounted] = useState(0);
  useEffect(() => { panel.current?.update({ bytes }); }, [bytes, mounted]);

  return (
    <div className="inspect">
      <div className="card inspect-controls">
        <fieldset>
          <legend>The document</legend>
          {switches.map(({ key, label, off }) => (
            <label key={key} className="inspect-switch">
              <input type="checkbox" checked={structure[key]} onChange={event => setStructure(previous => ({ ...previous, [key]: event.target.checked }))} />
              <span>
                <strong>{label}</strong>
                {structure[key] ? null : <small>{off}</small>}
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Compile as</legend>
          <div className="segmented" role="group" aria-label="What to compile as">
            <button type="button" className={standard === 'ua-1' ? 'on' : undefined} aria-pressed={standard === 'ua-1'} onClick={() => setStandard('ua-1')}>PDF/UA-1</button>
            <button type="button" className={standard === 'tagged' ? 'on' : undefined} aria-pressed={standard === 'tagged'} onClick={() => setStandard('tagged')}>Tagged PDF</button>
          </div>
          <p className="inspect-hint">
            {standard === 'ua-1'
              ? 'The file declares PDF/UA-1, and veraPDF validates it against that.'
              : 'Tagged, but declaring no standard: veraPDF has nothing to validate it against until you pick one in the panel.'}
          </p>
        </fieldset>
        {compile.error !== undefined ? (
          <p className="inspect-refused" role="alert"><strong>The compiler refused this document.</strong> {compile.error} The PDF beside this is the last one that compiled.</p>
        ) : (
          <p className="inspect-status" role="status">{compile.ms === undefined ? 'Compiling…' : `Compiled in ${Math.round(compile.ms)} ms, in this page.`}</p>
        )}
        {validator === null ? <p className="inspect-hint">This build of the site does not include the veraPDF validator, so the panel shows the tags and the warnings only.</p> : null}
      </div>
      <div className="inspect-panel" ref={host} aria-label="The document's tags, page and validation" />
    </div>
  );
}
