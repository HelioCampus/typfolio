/** The runtime input of ./main.typ. Applications own this type; Typfolio does not validate against it. */
export interface OutcomesInput {
  title: string;
  generatedAt: string;
  outcomes: {
    name: string;
    summary: string;
    /** The asset path `render()` returned for this outcome's chart. */
    chart: string;
    chartAlt: string;
  }[];
}
