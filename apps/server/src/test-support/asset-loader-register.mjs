import {registerHooks} from 'node:module';
import {resolve} from './asset-model-loader.mjs';

// Test-only synchronous preload. Production process-isolated keeps execArgv empty.
registerHooks({resolve});
