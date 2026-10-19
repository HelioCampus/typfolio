import { defineInput } from '@typfolio/core';
import { z } from 'zod';
import { imagePath } from '../common/schema.ts';

/** The runtime input of ./main.typ. */
export const outcomesSchema = z.object({
  title: z.string().min(1).meta({ examples: ['Outcome results'] }),
  generatedAt: z.string().meta({ examples: ['18 October 2026'] }),
  outcomes: z.array(z.object({
    name: z.string().meta({ examples: ['Written communication'] }),
    summary: z.string().meta({ examples: ['21 of 30 students reached Proficient or above.'] }),
    chart: imagePath('image/svg+xml').describe('Path render() returned, such as /charts/0.svg.'),
    chartAlt: z.string().meta({ examples: ['Bar chart of students per level.'] }),
  })),
});

export type OutcomesInput = z.input<typeof outcomesSchema>;

/** Where main.typ reads it: the schema file in an editor, the data when the app compiles. */
export const outcomesInput = defineInput(outcomesSchema, 'outcomes/outcomes.schema.json');
