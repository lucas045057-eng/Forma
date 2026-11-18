import {launch} from './launch.mjs';
import {safeFailureCode} from './safety.mjs';
try {await launch('mock',process.argv.slice(2));}catch(error){const code=safeFailureCode(error);console.error(`Mock demo not started. Clear runtime injections and inspect local dependencies; no env file was loaded.${code?` [code=${code}]`:''}`);process.exitCode=1;}
