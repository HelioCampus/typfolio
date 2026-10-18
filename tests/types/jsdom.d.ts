// jsdom ships no types and @types/jsdom is not a dependency. This declares the small part the tests use.
declare module 'jsdom' {
  export interface JSDOMOptions {
    url?: string;
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: Window & typeof globalThis;
  }
}
