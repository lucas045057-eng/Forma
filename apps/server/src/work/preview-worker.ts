import { pathToFileURL } from 'node:url';

// The IPC pipe is owned by the backend. OS closure on a parent crash terminates this preview too.
if (!process.send) throw new Error('Preview worker requires parent IPC');
process.on('disconnect', () => process.exit(0));
const vite = process.argv[2];
process.argv = [process.execPath, vite];
await import(pathToFileURL(vite).href);
