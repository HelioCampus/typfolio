import { useEffect, useState } from 'react';
import type { StructurePanelValidator } from '../panel.js';
import { pdfValidationFlavourIds, pdfValidationFlavours, type PdfValidationFlavour, type PdfValidationReport } from '../validation.js';

/** What to validate against: one flavour, or whatever the file declares. */
type Choice = PdfValidationFlavour | 'declared';

type Outcome =
  | { reports: PdfValidationReport[] }
  /** Asked for what the file declares, and it declares nothing. */
  | { undeclared: true }
  | { error: unknown };

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const name = (id: PdfValidationFlavour) => pdfValidationFlavours[id] ?? id;

/** What veraPDF logged while reading the file; a pass with messages means it validated what it could read. */
function Logs({ report }: { report: PdfValidationReport }) {
  const logs = report.logs ?? [];
  if (logs.length === 0) return null;
  return (
    <details className="tf-logs" open={report.compliant}>
      <summary>veraPDF logged {plural(logs.length, 'message')} while reading the file{report.compliant ? ': it validated what it could read' : ''}</summary>
      <ul>
        {logs.map((log, position) => <li key={position}><span className="tf-problem-page">{log.level}{log.occurrences > 1 ? ` (${log.occurrences}×)` : ''}:</span> {log.message}</li>)}
      </ul>
    </details>
  );
}

function Report({ report }: { report: PdfValidationReport }) {
  if (report.compliant) {
    return (
      <>
        <p className="tf-banner" data-tone="ok">
          Passes veraPDF’s {name(report.flavour)} rules ({plural(report.totalAssertions, 'check')}). That is a machine check: it does not show that the document is accessible.
        </p>
        <Logs report={report} />
      </>
    );
  }
  const failedChecks = report.failedRules.reduce((sum, rule) => sum + rule.failedChecks, 0);
  return (
    <div className="tf-problems tf-failed-rules">
      <h2>Fails {plural(report.failedRules.length, 'rule')} of {name(report.flavour)}: {failedChecks} of {plural(report.totalAssertions, 'check')}</h2>
      <ul>
        {report.failedRules.map(rule => (
          <li key={`${rule.specification} ${rule.clause} ${rule.test}`}>
            <details className="tf-rule">
              <summary className="tf-problem">
                <span className="tf-problem-page">{rule.specification}, {rule.clause}, test {rule.test}{rule.failedChecks > 1 ? ` (${rule.failedChecks}×)` : ''}:</span>{' '}
                {rule.message}
                {(rule.tags ?? []).map(tag => <span key={tag} className="tf-rule-tag">{tag}</span>)}
              </summary>
              <ol className="tf-rule-checks">
                {(rule.checks ?? [{ context: rule.context, error: '' }]).map((check, position) => (
                  <li key={position}>
                    {check.error ? <span>{check.error}</span> : null}
                    <span className="tf-rule-context" title="Where the check failed, in veraPDF’s model of the file">{check.context}</span>
                  </li>
                ))}
                {rule.checks && rule.failedChecks > rule.checks.length ? <li className="tf-rule-more">… and {rule.failedChecks - rule.checks.length} more</li> : null}
              </ol>
            </details>
          </li>
        ))}
      </ul>
      <Logs report={report} />
    </div>
  );
}

/**
 * veraPDF's findings, the view beside the tags and the page: what to validate against, a button, and the verdict
 * with each failed rule and its checks. With a validator that can read what a file declares, every PDF is validated
 * against that without being asked, and a PDF that declares nothing says so. Otherwise nothing is validated until
 * the button is used. Either way each new PDF is then validated the same way, so the verdict follows the template
 * being edited, and the last verdict stays on show until the new one is in.
 */
export function Validation({ validator, bytes, active = true }: { validator: StructurePanelValidator; bytes?: Uint8Array; active?: boolean }) {
  const detects = typeof validator.detectFlavours === 'function';
  const [choice, setChoice] = useState<Choice>(detects ? 'declared' : 'ua1');
  // What to validate against, on every PDF; `run` counts the presses of the button, so the same choice runs again.
  // A validator that can read what a file declares starts without being asked: there is no choice to wait for.
  const [asked, setAsked] = useState<{ choice: Choice; run: number } | undefined>(detects ? { choice: 'declared', run: 0 } : undefined);
  const [outcome, setOutcome] = useState<Outcome>();
  const [running, setRunning] = useState(false);
  useEffect(() => {
    // Not while the panel is closed: the PDF on show when it opens is validated then.
    if (asked === undefined || bytes === undefined || !active) return;
    let current = true;
    setRunning(true);
    (async () => {
      let next: Outcome;
      try {
        // Copies: a validator in a worker may transfer what it is given.
        const flavours = asked.choice === 'declared' ? await validator.detectFlavours!(bytes.slice()) : [asked.choice];
        if (flavours.length === 0) next = { undeclared: true };
        else {
          const reports: PdfValidationReport[] = [];
          for (const flavour of flavours) reports.push(await validator.validate(bytes.slice(), { flavour }));
          next = { reports };
        }
      } catch (error) {
        next = { error };
      }
      if (!current) return;
      setOutcome(next);
      setRunning(false);
    })();
    return () => { current = false; };
  }, [validator, bytes, asked, active]);

  return (
    <section className="tf-validation" aria-label="veraPDF validation">
      <div className="tf-validation-bar">
        <label className="tf-choice">
          <span className="tf-title">veraPDF</span>
          {/* The box draws the select's arrow itself: the native one differs from one browser to the next. */}
          <span className="tf-choice-box">
            <select className="tf-flavour" aria-label="What to validate against" value={choice} onChange={event => setChoice(event.target.value as Choice)}>
              {detects ? <option value="declared">What the file declares</option> : null}
              {pdfValidationFlavourIds.map(id => <option key={id} value={id}>{name(id)}</option>)}
            </select>
          </span>
        </label>
        <button type="button" className="tf-side tf-validate" disabled={bytes === undefined || running} onClick={() => setAsked(previous => ({ choice, run: (previous?.run ?? 0) + 1 }))}>
          Validate
        </button>
        {running ? <span className="tf-reading" role="status">Validating…</span> : null}
        {asked === undefined ? <span className="tf-validation-hint">{bytes === undefined ? 'No PDF yet.' : 'Checks the file against the standard’s machine-checkable rules, with veraPDF.'}</span> : null}
      </div>
      <div className="tf-validation-results" role="status">
        {!outcome ? null : 'error' in outcome ? (
          <p className="tf-banner" data-tone="error" role="alert">veraPDF could not validate the PDF: {describe(outcome.error)}</p>
        ) : 'undeclared' in outcome ? (
          <p className="tf-banner" data-tone="quiet">The PDF declares no standard in its metadata, so there is nothing to validate it against. Pick one above to validate against it anyway.</p>
        ) : (
          <>
            {outcome.reports.length > 1 ? <p className="tf-banner" data-tone="quiet">The PDF declares {outcome.reports.map(report => name(report.flavour)).join(' and ')}.</p> : null}
            {outcome.reports.map(report => <Report key={report.flavour} report={report} />)}
          </>
        )}
      </div>
    </section>
  );
}
