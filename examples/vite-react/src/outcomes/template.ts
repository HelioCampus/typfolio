import { defineTemplate } from '@typfolio/core';
import { header } from '../common/header.ts';
import source from './main.typ?raw';
import { outcomesSchema } from './outcomes.schema.ts';

/**
 * The outcomes report: its own file and data, and the shared header with its data. A document of it
 * is `outcomesTemplate(data, { header: headerData })`, typed and checked by these schemas.
 */
export const outcomesTemplate = defineTemplate({
  entrypoint: 'outcomes/main.typ',
  files: { 'outcomes/main.typ': source },
  schema: outcomesSchema,
  // Where main.typ reads its data: the schema file in an editor, the data when the app compiles.
  schemaPath: 'outcomes/outcomes.schema.json',
  partials: { header },
});
