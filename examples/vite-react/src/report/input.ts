/** The runtime input of ./main.typ. Applications own this type; Typfolio does not validate against it. */
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
