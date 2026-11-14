// Claude Code review probe (read-only w.r.t. product code): does the production browser
// check (checks/browser.ts + static-origin.ts at the frozen m3b HEAD) block or record a
// WebRTC/STUN UDP send? Fake loopback UDP listener only; no external network.
import dgram from 'node:dgram';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const worktree = 'E:/空间化AI工作台/.worktrees/m3b';
const root = 'E:/空间化AI工作台/.data/claude-m3b-review/rtc';
const { checkBrowser, stopBrowser } = await import(pathToFileURL(path.join(worktree, 'apps/server/src/checks/browser.ts')).href);

const udp = dgram.createSocket('udp4');
const received = [];
udp.on('message', (msg, rinfo) => received.push({ bytes: msg.length, from: rinfo.address, stunMagic: msg.subarray(4, 8).toString('hex') }));
await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
const port = udp.address().port;

await rm(path.join(root, 'dist'), { recursive: true, force: true });
await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist/index.html'), `<!doctype html><html><body><div id="root"><main>
<button data-testid="buy-button" onclick="const o=document.querySelector('[data-testid=action-status]');o.dataset.purchases=String(Number(o.dataset.purchases)+1);o.textContent='ok'">Buy</button>
<div data-testid="product-scene" data-state="ready" style="width:10px;height:10px"></div>
<output data-testid="action-status" data-purchases="0"></output>
</main></div>
<script>
const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${port}'}]});
pc.createDataChannel('x');
pc.createOffer().then(offer=>pc.setLocalDescription(offer));
</script></body></html>`);

const runId = 'c0ffee00c0ffee00c0ffee00c0ffee00';
const evidence = {};
const ctx = {
  runId, buildRoot: root, candidateRoot: root, snapshot: { entries: [], digest: '0'.repeat(64), totalBytes: 0 },
  signal: new AbortController().signal, buildTimeoutMs: 120000, browserTimeoutMs: 30000, artifactsDir: root,
  writeArtifact: async (name, content) => {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (name.endsWith('.json')) evidence[name] = JSON.parse(buffer.toString('utf8'));
    return { name, mime: '', bytes: buffer.length, hash: createHash('sha256').update(buffer).digest('hex') };
  },
};
let result;
try {
  result = await checkBrowser('smoke', ctx);
  await new Promise(resolve => setTimeout(resolve, 1500)); // allow ICE gathering to send
} finally {
  await stopBrowser(runId);
  udp.close();
  await rm(path.join(root, 'dist'), { recursive: true, force: true });
}
console.log(JSON.stringify({
  smokeStatus: result.status, smokeMessage: result.message ?? null,
  blockedRequests: evidence['smoke.json']?.blockedRequests, pageErrors: evidence['smoke.json']?.pageErrors,
  browserVersion: evidence['smoke.json']?.browserVersion,
  udpPacketsReceivedByFakeStun: received.length, firstPacket: received[0] ?? null,
}, null, 2));
