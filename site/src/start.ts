import { createStart } from '@tanstack/react-start';

// New routes are client-only unless explicitly opted into build-time prerendering.
export const startInstance = createStart(() => ({ defaultSsr: false }));
