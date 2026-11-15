import {test} from 'node:test';
import './frontend-watch-gate.test.mjs';
import {confirmFrontendClose} from './test-support/frontend-close-confirm.mjs';

for(const kind of ['no-request','consumed','status-only']){
 test(`production frontend natural shutdown: ${kind}`,{concurrency:false,timeout:300000},async()=>{
  await confirmFrontendClose(kind);
 });
}
