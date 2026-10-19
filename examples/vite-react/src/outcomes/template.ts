import { defineTemplate } from '@typfolio/core';
import { header } from '../common/header.ts';
import source from './main.typ?raw';
import { outcomesInput } from './outcomes.schema.ts';

/**
 * The outcomes report: its own file and input, and the shared header with its data. A request for
 * it is `{ input, partials: { header } }`, typed and checked by these schemas.
 */
export const outcomesTemplate = defineTemplate({
  entrypoint: 'outcomes/main.typ',
  files: { 'outcomes/main.typ': source },
  input: outcomesInput,
  partials: { header },
});
