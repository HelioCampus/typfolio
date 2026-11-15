import { useEffect, useState } from 'react';
import type { StructurePanelValidator } from '../panel.js';
import { pdfValidationFlavourIds, pdfValidationFlavours, type PdfValidationFlavour, type PdfValidationReport } from '../validation.js';

type Outcome =
  | { flavour: PdfValidationFlavour; report: PdfValidationReport }
  | { flavour: PdfValidationFlavour; error: unknown };

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Validates the PDF on show with veraPDF, when asked: a flavour to pick, a button, and the verdict with each failed
 * rule. Once asked, every new PDF is validated against the same flavour, so the verdict follows the template being
 * edited; the last verdict stays on show until the new one is in.
 */
export function Validation({ validator, bytes }: { validator: StructurePanelValidator; bytes?: Uint8Array }) {
  const [flavour, setFlavour] = useState<PdfValidationFlavour>('ua1');
  // What the button asked for; undefined until it is used. `run` counts the presses, so the same flavour runs again.
  const [asked, setAsked] = useState<{ flavour: PdfValidationFlavour; run: number }>();
  const [outcome, setOutcome] = useState<Outcome>();
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (asked === undefined || bytes === undefined) return;
    let current = true;
    setRunning(true);
    (async () => {
      let next: Outcome;
      try {
        // A copy: a validator in a worker may transfer what it is given.
        next = { flavour: asked.flavour, report: await validator.validate(bytes.slice(), { flavour: asked.flavour }) };
      } catch (error) {
        next = { flavour: asked.flavour, error };
      }
      if (!current) return;
      setOutcome(next);
      setRunning(false);
    })();
    return () => { current = false; };
  }, [validator, bytes, asked]);

  const name = (id: PdfValidationFlavour) => pdfValidationFlavours[id] ?? id;
  const report = outcome && 'report' in outcome ? outcome.report : undefined;
  const failedChecks = report?.failedRules.reduce((sum, rule) => sum + rule.failedChecks, 0) ?? 0;
  return (
    <section className="tf-validation" aria-label="veraPDF validation">
      <div className="tf-validation-bar">
        <label>
          veraPDF{' '}
          <select className="tf-flavour" aria-label="What to validate against" value={flavour} onChange={event => setFlavour(event.target.value as PdfValidationFlavour)}>
            {pdfValidationFlavourIds.map(id => <option key={id} value={id}>{name(id)}</option>)}
          </select>
        </label>
        <button type="button" className="tf-side tf-validate" disabled={bytes === undefined || running} onClick={() => setAsked(previous => ({ flavour, run: (previous?.run ?? 0) + 1 }))}>
          Validate
        </button>
        {running ? <span className="tf-reading" role="status">Validating…</span> : null}
        {asked === undefined ? <span className="tf-validation-hint">{bytes === undefined ? 'No PDF yet.' : 'Checks the file against the standard’s machine-checkable rules.'}</span> : null}
      </div>
      {outcome && 'error' in outcome ? (
        <p className="tf-banner" data-tone="error" role="alert">veraPDF could not validate the PDF: {describe(outcome.error)}</p>
      ) : report?.compliant ? (
        <p className="tf-banner" data-tone="ok" role="status">
          Passes veraPDF’s {name(report.flavour)} rules ({plural(report.totalAssertions, 'check')}). That is a machine check: it does not show that the document is accessible.
        </p>
      ) : report ? (
        <div className="tf-problems tf-failed-rules">
          <h2 role="status">Fails {plural(report.failedRules.length, 'rule')} of {name(report.flavour)}: {failedChecks} of {plural(report.totalAssertions, 'check')}</h2>
          <ul>
            {report.failedRules.map(rule => (
              <li key={`${rule.specification} ${rule.clause} ${rule.test}`}>
                <p className="tf-problem">
                  <span className="tf-problem-page">{rule.specification}, {rule.clause}, test {rule.test}{rule.failedChecks > 1 ? ` (${rule.failedChecks}×)` : ''}:</span>{' '}
                  {rule.message}
                  {rule.context ? <span className="tf-rule-context" title="Where the first failed check was, in veraPDF’s model of the file">{rule.context}</span> : null}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
