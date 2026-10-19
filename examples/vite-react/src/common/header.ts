import { definePartial } from '@typfolio/core';
import source from './header.typ?raw';
import { headerSchema } from './header.schema.ts';

/** The shared header: Typst code with runtime data of its own. A template lists it in `partials`. */
export const header = definePartial({
  files: { 'common/header.typ': source },
  schema: headerSchema,
  // Where header.typ reads its data: the schema file in an editor, the data when the app compiles.
  schemaPath: 'common/header.schema.json',
});
