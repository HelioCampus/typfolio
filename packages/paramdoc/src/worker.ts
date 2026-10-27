// The module worker `createWorkerClient` starts by default: `new Worker(new URL('./worker.js', import.meta.url),
// { type: 'module' })`. Bundlers that follow that pattern (Vite does) ship it as its own file.
import { installParamdocWorker } from './worker-runtime.js';

installParamdocWorker(self);
