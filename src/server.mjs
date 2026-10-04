// Compatibility entry point; the HTTP/process boundary is type checked.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCLI } from './server.ts';
export { startServer } from './server.ts';
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runCLI();
