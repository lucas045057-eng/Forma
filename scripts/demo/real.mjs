import {launch} from './launch.mjs';
try {await launch('real',process.argv.slice(2));}catch{console.error('Real demo not started. Explicit authorization flag and operator-supplied Aliyun environment are required; no env file was loaded.');process.exitCode=1;}
