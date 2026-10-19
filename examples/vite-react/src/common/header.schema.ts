import { defineInput } from '@typfolio/core';
import { z } from 'zod';
import { imagePath } from './schema.ts';

/** The data of the shared header: the request's `partials.header`. */
export const headerSchema = z.object({
  institution: z.string().min(1).meta({ examples: ['Example University'] }),
  logo: imagePath('image/svg+xml').describe('Path attach() returned for the logo.'),
});

export type HeaderInput = z.input<typeof headerSchema>;

/** Where header.typ reads it: the schema file in an editor, the data when the app compiles. */
export const headerInput = defineInput(headerSchema, 'common/header.schema.json');
