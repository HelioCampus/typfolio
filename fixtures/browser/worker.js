// Test harness only; worker scheduling and transport belong to the later workers package.
import { runSmoke } from './smoke.js';
runSmoke().then(result => postMessage({ ok: true, result }), error => postMessage({ ok: false, error: String(error) }));
