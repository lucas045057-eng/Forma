import {launch} from './launch.mjs';
try {await launch('mock',process.argv.slice(2));}catch{console.error('Mock demo not started. Clear runtime injections and inspect local dependencies; no env file was loaded.');process.exitCode=1;}
