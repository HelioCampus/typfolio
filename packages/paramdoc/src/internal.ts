// The runtime as the experiment and its proof use it: the `Runtime` class with its slot trace, `compare` against
// a reference layout (Typst's, or the Rust runtime's), the document's types and the geometry helpers. Not part of
// the public API; it changes with the document format.
export * from './runtime.js';
