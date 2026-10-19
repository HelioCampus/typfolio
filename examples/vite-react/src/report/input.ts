/**
 * The data of ./main.typ. Applications own this type: the report template has no schema, so it types
 * the call but Typfolio does not check the data against it. Keep ./report.schema.json in step.
 */
export interface ReportInput {
  title: string;
  summary: string;
  generatedAt: string;
  runtimeLineOne: string;
  runtimeLineTwo: string;
  runtimeLineThree: string;
  runtimeEmphasis: string;
  runtimeNote: string;
}
