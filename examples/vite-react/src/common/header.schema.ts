import { z } from 'zod';
import { imagePath } from './schema.ts';

/**
 * The data of the shared header: what a template that uses it takes under `header`, as in
 * `outcomesTemplate(data, { header })`. This module imports no Typst file, so a script or a test can
 * load it to write or compare `header.schema.json` (`inputSchemaFiles` in @typfolio/dev-tools).
 */
export const headerSchema = z.object({
  institution: z.string().min(1).meta({ examples: ['Example University'] }),
  logo: imagePath('image/svg+xml').describe('Path attach() returned for the logo.'),
});

export type HeaderInput = z.input<typeof headerSchema>;
