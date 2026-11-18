import {launch} from './launch.mjs';
import {safeFailureCode} from './safety.mjs';
try {await launch('real',process.argv.slice(2));}catch(error){const code=safeFailureCode(error);console.error(`Real demo not started. Explicit authorization flag and operator-supplied Aliyun environment are required; no env file was loaded.${code?` [code=${code}]`:''}`);process.exitCode=1;}
