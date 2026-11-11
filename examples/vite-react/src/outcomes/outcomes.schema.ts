import { z } from 'zod';
import { imagePath } from '../common/schema.ts';

/**
 * The data of ./main.typ. This module imports no Typst file, so a script or a test can load it to
 * write or compare `outcomes.schema.json` (`inputSchemaFiles` in @typfolio/dev-tools).
 */
export const outcomesSchema = z.object({
  title: z.string().min(1).meta({ examples: ['Outcome results'] }),
  generatedAt: z.string().meta({ examples: ['18 October 2026'] }),
  levels: z.array(z.string()).describe('The level names, the columns of the results table.').meta({ examples: [['Exemplary', 'Proficient']] }),
  outcomes: z.array(z.object({
    name: z.string().meta({ examples: ['Written communication'] }),
    students: z.array(z.int().min(0)).describe('Students per level, in the order of levels.').meta({ examples: [[9, 12]] }),
    summary: z.string().meta({ examples: ['21 of 30 students reached Proficient or above.'] }),
    chart: imagePath('image/svg+xml').describe('Path render() returned, such as /charts/0.svg.'),
    chartAlt: z.string().meta({ examples: ['Bar chart of students per level.'] }),
  })),
});

export type OutcomesInput = z.input<typeof outcomesSchema>;
