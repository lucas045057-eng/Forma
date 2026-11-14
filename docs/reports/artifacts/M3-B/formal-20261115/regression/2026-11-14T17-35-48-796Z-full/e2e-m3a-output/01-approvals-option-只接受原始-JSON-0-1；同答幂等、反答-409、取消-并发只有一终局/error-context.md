# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 01-approvals.spec.ts >> option 只接受原始 JSON 0/1；同答幂等、反答 409、取消/并发只有一终局
- Location: tests\e2e\m3a\01-approvals.spec.ts:216:1

# Error details

```
Error: EPERM, Permission denied: \\?\C:\Users\Admin\AppData\Local\Temp\m3a-e2e-5E02Ss\data '\\?\C:\Users\Admin\AppData\Local\Temp\m3a-e2e-5E02Ss\data'
```

# Test source

```ts
  1   | import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
  2   | import path from 'node:path';
  3   | import type { Child } from '../m0a/harness';
  4   | import { freePort, startChild } from '../m0a/harness';
  5   | import { BACKEND_LAUNCHER, GUARD_SCRIPT_ARG, SERVER_DIR, WORK_ROOT } from '../m2a/env';
  6   | import { createWorkRoot } from '../real-model/helpers';
  7   | 
  8   | export const MOCK_BASE = 'http://127.0.0.1:4011';
  9   | export const MOCK_KEY = 'mock-only';
  10  | export const MOCK_MODEL = 'mock-coder';
  11  | export const DEAD_LUX3D = 'http://127.0.0.1:4019';
  12  | 
  13  | export interface Fixture {
  14  |   root: string;
  15  |   workRoot: string;
  16  |   dataDir: string;
  17  |   base: string;
  18  |   previewOrigin: string;
  19  |   backend: Child;
  20  |   stop(): Promise<void>;
  21  | }
  22  | 
  23  | export async function startMockAgent(): Promise<Child> {
  24  |   return startChild({
  25  |     command: process.execPath, args: [path.join(SERVER_DIR, '..', '..', 'tests', 'e2e', 'm2a', 'agent-mock.mjs')],
  26  |     cwd: SERVER_DIR, env: { MOCK_PORT: '4011', MOCK_KEY }, readyUrl: `${MOCK_BASE}/__stats`, label: 'm3a-agent-mock',
  27  |   });
  28  | }
  29  | 
  30  | export async function startBackendFixture(options: {
  31  |   root: string; previewFail?: 'all' | 'once'; customizer?: (workRoot: string) => void; reuse?: { dataDir: string; workRoot: string };
  32  | }): Promise<Fixture> {
  33  |   const workRoot = options.reuse?.workRoot ?? path.join(options.root, 'work');
  34  |   const dataDir = options.reuse?.dataDir ?? path.join(options.root, 'data');
  35  |   if (!options.reuse) {
  36  |     createWorkRoot(workRoot);
  37  |     options.customizer?.(workRoot);
  38  |   }
  39  |   mkdirSync(dataDir, { recursive: true });
  40  |   const port = await freePort();
  41  |   const previewPort = await freePort();
  42  |   const backend = await startChild({
  43  |     command: process.execPath, args: [BACKEND_LAUNCHER], cwd: SERVER_DIR,
  44  |     env: {
  45  |       PORT: String(port), PREVIEW_ORIGIN_PORT: String(previewPort), MAIN_PREVIEW_PORT: '5274', STUDIO_ORIGIN: 'http://127.0.0.1:5173',
  46  |       WORK_ROOT: workRoot, WORK_DATA_DIR: dataDir,
  47  |       ASSETS_DIR: path.join(dataDir, '..', 'assets'), SCENE_HISTORY_DIR: path.join(dataDir, '..', 'history'),
  48  |       LUX3D_BASE: DEAD_LUX3D, LUX3D_API_KEY: 'unused',
  49  |       CODING_AGENT_BASE_URL: MOCK_BASE, CODING_AGENT_API_KEY: MOCK_KEY, CODING_AGENT_MODEL: MOCK_MODEL,
  50  |       AGENT_TIMEOUT_MS: '30000', AGENT_MAX_ROUNDS: '16',
  51  |       ...(options.previewFail === 'all' ? { M3A_PREVIEW_FAIL: '1' } : {}),
  52  |       ...(options.previewFail === 'once' ? { M3A_PREVIEW_FAIL_ONCE: '1' } : {}),
  53  |       PI_NET_GUARD_LOG: path.join(dataDir, 'guard.log'), NODE_OPTIONS: `--require ${GUARD_SCRIPT_ARG}`,
  54  |     },
  55  |     readyUrl: `http://127.0.0.1:${port}/health`, label: options.previewFail ? 'm3a-backend-fault' : 'm3a-backend', timeoutMs: 60_000,
  56  |   });
  57  |   return {
  58  |     root: options.root, workRoot, dataDir, base: `http://127.0.0.1:${port}`, previewOrigin: `http://127.0.0.1:${previewPort}`, backend,
  59  |     async stop() {
  60  |       await backend.gracefulClose(20_000).catch(async () => { await backend.stop(); });
  61  |     },
  62  |   };
  63  | }
  64  | 
  65  | export function removeFixture(root: string) {
> 66  |   rmSync(path.join(root, 'data'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      |   ^ Error: EPERM, Permission denied: \\?\C:\Users\Admin\AppData\Local\Temp\m3a-e2e-5E02Ss\data '\\?\C:\Users\Admin\AppData\Local\Temp\m3a-e2e-5E02Ss\data'
  67  |   rmSync(path.join(root, 'work'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  68  |   rmSync(root, { recursive: true, force: true });
  69  | }
  70  | 
  71  | export async function http<T = any>(url: string, init?: RequestInit): Promise<{ status: number; body: T; text: string }> {
  72  |   const response = await fetch(url, init);
  73  |   const text = await response.text();
  74  |   let body: any = text;
  75  |   try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  76  |   return { status: response.status, body, text };
  77  | }
  78  | export const jsonRequest = (method: string, payload?: unknown): RequestInit => ({ method, ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) });
  79  | export const getVersion = (base: string) => http<{ version: string }>(`${base}/version`);
  80  | export const listApprovals = (base: string) => http<any[]>(`${base}/approvals`);
  81  | export const getApproval = (base: string, id: string) => http<any>(`${base}/approvals/${id}`);
  82  | export const answerApproval = (base: string, id: string, option: number) => http<any>(`${base}/approvals/${id}`, jsonRequest('POST', { option }));
  83  | export const listCandidates = (base: string) => http<any[]>(`${base}/candidates`);
  84  | export const getCandidate = (base: string, id: string) => http<any>(`${base}/candidates/${id}`);
  85  | export const adoptCandidate = (base: string, id: string) => http(`${base}/candidates/${id}/adopt`, { method: 'POST' });
  86  | export const discardCandidate = (base: string, id: string) => http(`${base}/candidates/${id}/discard`, { method: 'POST' });
  87  | export const getTask = (base: string, id: string) => http<any>(`${base}/tasks/${id}`);
  88  | export const listTasks = (base: string) => http<any[]>(`${base}/tasks`);
  89  | export const cancelTask = (base: string, id: string) => http(`${base}/tasks/${id}/cancel`, { method: 'POST' });
  90  | export const history = (base: string) => http<any>(`${base}/events/history?since=0`);
  91  | export const resetMock = () => http(`${MOCK_BASE}/__reset`, { method: 'POST' });
  92  | export const setScript = (steps: unknown[], delayMs = 0) => http(`${MOCK_BASE}/__script`, jsonRequest('POST', { steps, delayMs }));
  93  | export const mockStats = () => http<any>(`${MOCK_BASE}/__stats`);
  94  | 
  95  | export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  96  | export async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 30_000, intervalMs = 150): Promise<number> {
  97  |   const started = Date.now();
  98  |   while (Date.now() - started < timeoutMs) {
  99  |     if (await predicate()) return Date.now() - started;
  100 |     await sleep(intervalMs);
  101 |   }
  102 |   throw new Error(`等待条件超时（${timeoutMs}ms）`);
  103 | }
  104 | 
  105 | export async function waitTask(base: string, id: string, timeoutMs = 60_000) {
  106 |   let task: any;
  107 |   await waitFor(async () => {
  108 |     task = (await getTask(base, id)).body;
  109 |     return !['queued', 'running'].includes(task.status);
  110 |   }, timeoutMs, 100);
  111 |   return task;
  112 | }
  113 | export async function waitDone(base: string, id: string, timeoutMs = 60_000) {
  114 |   let task: any;
  115 |   await waitFor(async () => {
  116 |     task = (await getTask(base, id)).body;
  117 |     if (task.status === 'awaiting_approval') {
  118 |       for (const card of (await listApprovals(base)).body.filter((item: any) => item.taskId === id && item.status === 'pending')) {
  119 |         const answer = await answerApproval(base, card.id, 0);
  120 |         if (answer.status !== 200) throw new Error(`自动批准失败：${answer.text}`);
  121 |       }
  122 |       return false;
  123 |     }
  124 |     return task.status === 'done';
  125 |   }, timeoutMs, 150);
  126 |   return task;
  127 | }
  128 | 
  129 | const selectionStyles = {
  130 |   display: 'inline-block', position: 'static', color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)',
  131 |   fontSize: '16px', fontFamily: 'Arial', fontWeight: '400', lineHeight: '16px', padding: '0px', margin: '0px',
  132 |   borderRadius: '0px', width: '10px', height: '10px',
  133 | };
  134 | export function selection(baseVersion: string, src: string, options: { instances?: number; ancestors?: string[] } = {}) {
  135 |   return { src, baseVersion, cid: 'Node', text: '', bbox: [0, 0, 10, 10], styles: selectionStyles,
  136 |     instances: options.instances ?? 1, ancestors: options.ancestors ?? [] };
  137 | }
  138 | 
  139 | export async function submit(base: string, instruction: string, sel?: ReturnType<typeof selection>) {
  140 |   const response = await http<any>(`${base}/tasks`, jsonRequest('POST', sel ? { instruction, selection: sel } : { instruction }));
  141 |   if (response.status !== 202) throw new Error(`提交失败：${response.status} ${response.text}`);
  142 |   return response.body as { id: string; status: string };
  143 | }
  144 | 
  145 | export function readWorkFile(workRoot: string, file: string) {
  146 |   return readFileSync(path.join(workRoot, file), 'utf8');
  147 | }
  148 | export function writeWorkFile(workRoot: string, file: string, content: string) {
  149 |   writeFileSync(path.join(workRoot, file), content);
  150 | }
  151 | 
  152 | /** 读取批准前 staging 是否存在（仅测试 Fixture 使用）。 */
  153 | export function stagingExists(fixture: Fixture, taskId: string) {
  154 |   return readFileSync(path.join(fixture.dataDir, 'tasks.json'), 'utf8').includes('"approvals"') && path.join(fixture.dataDir, 'candidates', taskId);
  155 | }
  156 | 
```