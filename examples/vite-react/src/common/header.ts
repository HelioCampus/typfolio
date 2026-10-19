import { definePartial } from '@typfolio/core';
import source from './header.typ?raw';
import { headerInput } from './header.schema.ts';

/** The shared header: Typst code with runtime data of its own. A template lists it in `partials`. */
export const header = definePartial({
  files: { 'common/header.typ': source },
  input: headerInput,
});
