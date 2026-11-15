import {test} from 'node:test';
import './retained-response.test.mjs';
import {confirmFrontendClose} from './test-support/frontend-close-confirm.mjs';

test('production frontend status-only shutdown with observed retained response release',{timeout:300000},async()=>{
 await confirmFrontendClose('status-only');
});
