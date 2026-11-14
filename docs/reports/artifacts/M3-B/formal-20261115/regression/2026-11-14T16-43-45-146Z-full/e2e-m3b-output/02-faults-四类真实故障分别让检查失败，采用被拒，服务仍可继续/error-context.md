# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 02-faults.spec.ts >> 四类真实故障分别让检查失败，采用被拒，服务仍可继续
- Location: tests\e2e\m3b\02-faults.spec.ts:74:1

# Error details

```
Error: 任务没有产出候选：{"id":"f3d316dd9e5d423b9af87b8d3137c254","instruction":"把场景配置写坏","selection":{"src":"src/App.tsx:30:11","baseVersion":"9fef7424df3e9d4d5ec2672fd914354245351d9b","cid":"Node","text":"","bbox":[0,0,10,10],"styles":{"display":"inline-block","position":"static","color":"rgb(0, 0, 0)","backgroundColor":"rgba(0, 0, 0, 0)","fontSize":"16px","fontFamily":"Arial","fontWeight":"400","lineHeight":"16px","padding":"0px","margin":"0px","borderRadius":"0px","width":"10px","height":"10px"},"instances":1,"ancestors":[]},"status":"failed","events":[{"type":"task.updated","ts":"2026-11-14T16:57:33.906Z","sequen
```

# Test source

```ts
  186 |   const dirRemoved = !existsSync(fixture.root);
  187 |   if (!dirRemoved) problems.push(`临时目录未删干净：${fixture.root}`);
  188 |   return { root: fixture.root, pid, startTime, graceful, ports, stillListening, dirRemoved, problems };
  189 | }
  190 | 
  191 | /** 所有夹具逐个收尾并归档证据；返回失败项供用例显式断言（不静默吞错）。 */
  192 | export async function disposeAllFixtures(fixtures: Fixture[], artifactName: string): Promise<{ records: DisposalRecord[]; failures: string[] }> {
  193 |   const records: DisposalRecord[] = [];
  194 |   const failures: string[] = [];
  195 |   while (fixtures.length) {
  196 |     const fixture = fixtures.pop()!;
  197 |     try {
  198 |       const record = await disposeFixture(fixture);
  199 |       records.push(record);
  200 |       failures.push(...record.problems.map((problem) => `${record.root}: ${problem}`));
  201 |     } catch (error) {
  202 |       failures.push(`${fixture.root}: 收尾抛错 ${String(error).slice(0, 300)}`);
  203 |     }
  204 |   }
  205 |   writeArtifact(artifactName, { at: new Date().toISOString(), records, failures });
  206 |   return { records, failures };
  207 | }
  208 | 
  209 | /* ------------------------------------------------------------------ 后端 API */
  210 | 
  211 | export const http = httpJson;
  212 | 
  213 | export const resetMock = () => httpJson(`${MOCK_BASE}/__reset`, { method: 'POST' });
  214 | export const setScript = (steps: unknown[], delayMs = 0) =>
  215 |   httpJson(`${MOCK_BASE}/__script`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps, delayMs }) });
  216 | export const mockStats = () => httpJson<{ calls: number }>(`${MOCK_BASE}/__stats`);
  217 | 
  218 | export const getVersion = (base: string) => httpJson<{ version: string }>(`${base}/version`);
  219 | export const listTasks = (base: string) => httpJson<any[]>(`${base}/tasks`);
  220 | export const getTask = (base: string, id: string) => httpJson<any>(`${base}/tasks/${encodeURIComponent(id)}`);
  221 | export const listApprovals = (base: string) => httpJson<any[]>(`${base}/approvals`);
  222 | export const answerApproval = (base: string, id: string, option: 0 | 1) =>
  223 |   httpJson(`${base}/approvals/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ option }) });
  224 | export const listCandidatesApi = (base: string) => httpJson<any[]>(`${base}/candidates`);
  225 | 
  226 | export async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 60_000, intervalMs = 200): Promise<number> {
  227 |   const started = Date.now();
  228 |   while (Date.now() - started < timeoutMs) {
  229 |     if (await predicate()) return Date.now() - started;
  230 |     await sleep(intervalMs);
  231 |   }
  232 |   throw new Error(`等待条件超时（${timeoutMs}ms）`);
  233 | }
  234 | 
  235 | const selectionStyles = {
  236 |   display: 'inline-block', position: 'static', color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)',
  237 |   fontSize: '16px', fontFamily: 'Arial', fontWeight: '400', lineHeight: '16px', padding: '0px', margin: '0px',
  238 |   borderRadius: '0px', width: '10px', height: '10px',
  239 | };
  240 | 
  241 | export function selection(baseVersion: string, src: string, options: { instances?: number; ancestors?: string[]; text?: string } = {}) {
  242 |   return {
  243 |     src, baseVersion, cid: 'Node', text: options.text ?? '', bbox: [0, 0, 10, 10], styles: selectionStyles,
  244 |     instances: options.instances ?? 1, ancestors: options.ancestors ?? [],
  245 |   };
  246 | }
  247 | 
  248 | /** 等任务进终态；遇到请示按"批准"处理（M3-A 合同，不是本次被测对象）。 */
  249 | export async function waitTask(base: string, id: string, timeoutMs = 120_000) {
  250 |   let last: any = null;
  251 |   await waitFor(async () => {
  252 |     last = (await getTask(base, id)).body;
  253 |     if (last.status === 'awaiting_approval') {
  254 |       for (const card of (await listApprovals(base)).body.filter((item: any) => item.taskId === id && item.status === 'pending')) {
  255 |         const answered = await answerApproval(base, card.id, 0);
  256 |         if (answered.status !== 200) throw new Error(`自动批准失败：${answered.status} ${answered.text.slice(0, 200)}`);
  257 |       }
  258 |       return false;
  259 |     }
  260 |     return ['done', 'failed', 'cancelled'].includes(last.status);
  261 |   }, timeoutMs, 250);
  262 |   return last;
  263 | }
  264 | 
  265 | export interface CandidateContext { taskId: string; candidateId: string; task: any; candidate: any }
  266 | 
  267 | /** 用 mock 编码上游产出一个真实候选（真实 git 提交 + worktree，不伪造）。 */
  268 | export async function createCandidate(
  269 |   fixture: Fixture,
  270 |   steps: unknown[],
  271 |   options: { instruction?: string; src?: string; ancestors?: string[]; timeoutMs?: number } = {},
  272 | ): Promise<CandidateContext> {
  273 |   const base = (await getVersion(fixture.base)).body.version;
  274 |   await resetMock();
  275 |   await setScript(steps);
  276 |   const submitted = await httpJson<any>(`${fixture.base}/tasks`, {
  277 |     method: 'POST',
  278 |     headers: { 'Content-Type': 'application/json' },
  279 |     body: JSON.stringify({
  280 |       instruction: options.instruction ?? '局部文案修改',
  281 |       selection: selection(base, options.src ?? 'src/App.tsx:30:11', { ancestors: options.ancestors }),
  282 |     }),
  283 |   });
  284 |   if (submitted.status !== 202) throw new Error(`提交任务失败：${submitted.status} ${submitted.text.slice(0, 400)}`);
  285 |   const task = await waitTask(fixture.base, submitted.body.id, options.timeoutMs);
> 286 |   if (task.status !== 'done' || !task.candidateId) throw new Error(`任务没有产出候选：${JSON.stringify(task).slice(0, 600)}`);
      |                                                          ^ Error: 任务没有产出候选：{"id":"f3d316dd9e5d423b9af87b8d3137c254","instruction":"把场景配置写坏","selection":{"src":"src/App.tsx:30:11","baseVersion":"9fef7424df3e9d4d5ec2672fd914354245351d9b","cid":"Node","text":"","bbox":[0,0,10,10],"styles":{"display":"inline-block","position":"static","color":"rgb(0, 0, 0)","backgroundColor":"rgba(0, 0, 0, 0)","fontSize":"16px","fontFamily":"Arial","fontWeight":"400","lineHeight":"16px","padding":"0px","margin":"0px","borderRadius":"0px","width":"10px","height":"10px"},"instances":1,"ancestors":[]},"status":"failed","events":[{"type":"task.updated","ts":"2026-11-14T16:57:33.906Z","sequen
  287 |   const candidate = await getCandidate(fixture.base, task.candidateId);
  288 |   return { taskId: task.id, candidateId: task.candidateId, task, candidate: candidate.body };
  289 | }
  290 | 
  291 | export interface RunProbe { polls: number; samples: Array<{ at: number; status: string; outcome?: string; runningIndexes: number[] }> }
  292 | 
  293 | /**
  294 |  * 发起检查并在轮询中记录状态序列（用于串行/取消/重启用例），返回 run 与采样。
  295 |  * 注意：这里只发一次 POST，不重试、不补跑。
  296 |  */
  297 | export async function startAndWatch(fixture: Fixture, candidateId: string, options: { timeoutMs?: number; intervalMs?: number; rerun?: boolean } = {}) {
  298 |   const started = await startChecks(fixture.base, candidateId, options.rerun === undefined ? undefined : { rerun: options.rerun });
  299 |   if (started.status !== 202) throw new Error(`发起检查失败：${started.status} ${started.text.slice(0, 400)}`);
  300 |   const probe: RunProbe = { polls: 0, samples: [] };
  301 |   const run = await waitCheckRun(fixture.base, started.body.id, {
  302 |     timeoutMs: options.timeoutMs ?? 240_000,
  303 |     intervalMs: options.intervalMs ?? 250,
  304 |     onPoll: (current) => {
  305 |       probe.polls += 1;
  306 |       probe.samples.push({
  307 |         at: Date.now(), status: current.status, outcome: current.outcome,
  308 |         runningIndexes: current.checks.map((check, index) => (check.status === 'passed' ? -1 : index)).filter((index) => index >= 0),
  309 |       });
  310 |     },
  311 |   });
  312 |   return { started: started.body, run, probe };
  313 | }
  314 | 
  315 | export { getCheckRun, waitCheckRun, startChecks, getCandidate };
  316 | 
```