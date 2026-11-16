// The shapes of a veraPDF validation, without any code that loads the validator: the panel uses them too, and its
// bundle must not reach `@typfolio/verapdf-wasm`.

/** veraPDF's ids of the flavours that can be validated against. */
export type PdfValidationFlavour = '1a' | '1b' | '2a' | '2b' | '2u' | '3a' | '3b' | '3u' | '4' | '4e' | '4f' | 'ua1' | 'ua2' | 'wt1a' | 'wt1r';

/** The flavours in the order to list them: the accessibility standards first. */
export const pdfValidationFlavourIds: readonly PdfValidationFlavour[] = ['ua1', 'ua2', '1a', '1b', '2a', '2b', '2u', '3a', '3b', '3u', '4', '4e', '4f', 'wt1a', 'wt1r'];

/** What each flavour is, for a choice shown to a person. */
export const pdfValidationFlavours: Readonly<Record<PdfValidationFlavour, string>> = {
  'ua1': 'PDF/UA-1', 'ua2': 'PDF/UA-2',
  '1a': 'PDF/A-1a', '1b': 'PDF/A-1b', '2a': 'PDF/A-2a', '2b': 'PDF/A-2b', '2u': 'PDF/A-2u', '3a': 'PDF/A-3a', '3b': 'PDF/A-3b', '3u': 'PDF/A-3u',
  '4': 'PDF/A-4', '4e': 'PDF/A-4e', '4f': 'PDF/A-4f',
  'wt1a': 'WTPDF 1.0 Accessibility', 'wt1r': 'WTPDF 1.0 Reuse',
};

/** One failed check: where it was, and what was wrong there. */
export interface PdfValidationCheck {
  /**
   * A path in veraPDF's model of the file, with PDF object numbers where it has them. A glyph is named by, among
   * other things, a number that changes from run to run, so two reports on the same file can differ there.
   */
  context: string;
  /** What was wrong at this place, with the values found; empty when veraPDF gives none. */
  error: string;
}

export interface PdfValidationRule {
  /** The specification the rule comes from, for example `ISO 14289-1:2014`. */
  specification: string;
  clause: string;
  /** The number of the test within the clause. */
  test: number;
  /** How many checks of this rule failed: exact, also when `checks` lists fewer. */
  failedChecks: number;
  /** veraPDF's description of the rule: what the standard requires. */
  message: string;
  /** Where the first failed check was: `checks[0].context`. */
  context: string;
  /** The kind of object in veraPDF's model that the rule is checked on, such as `SETable` or `PDFont`. */
  object: string;
  /** The expression over that object that has to hold, in veraPDF's profile language. */
  condition: string;
  /** veraPDF's topics for the rule, sorted: `structure`, `table`, `font`, `metadata`, `alt-text` and so on. */
  tags: string[];
  /** The failed checks, in the order veraPDF met them, up to `maxChecksPerRule` (20 unless you say). */
  checks: PdfValidationCheck[];
}

export interface PdfValidationReport {
  flavour: PdfValidationFlavour;
  compliant: boolean;
  /** How many checks veraPDF ran. */
  totalAssertions: number;
  /** The validation profile that was applied: its name, what it validates against, and how many rules it has. */
  profile: { name: string; description: string; rules: number };
  /** One entry per rule with at least one failed check, ordered by specification, clause and test. */
  failedRules: PdfValidationRule[];
}
