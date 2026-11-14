/**
 * M3-B 检查 API 的测试助手（独立验收准备）。
 *
 * 这里只走产品 HTTP：POST /candidates/:id/checks、GET /checks/:id、POST /checks/:id/cancel、
 * GET /checks/:id/artifacts/:name。不注入 executor、不改预算、不伪造 passed。
 */
import { createHash } from 'node:crypto';

export const CHECK_ORDER = ['schema', 'build', 'smoke', 'occlusion'] as const;
export type CheckName = typeof CHECK_ORDER[number];

/** 采用门禁要求的六份证据；其余（runner.log/summary.json）按实际出现的 ref 校验。 */
export const REQUIRED_ARTIFACTS = ['schema.json', 'build.log', 'smoke.json', 'smoke.png', 'occlusion.json', 'occlusion.png'] as const;

export interface CheckResultLike {
  name: CheckName;
  status: 'passed' | 'failed' | 'not_run';
  message?: string;
  evidence?: string;
  durationMs?: number;
}

export interface ArtifactRefLike { name: string; mime: string; bytes: number; hash: string }

export interface CheckRunLike {
  id: string;
  candidateId: string;
  baseVersion: string;
  candidateCommit: string;
  contentDigest: string;
  mainVersion: string;
  policyVersion: string;
  status: 'queued' | 'running' | 'completed' | 'cancelled';
  outcome?: 'passed' | 'failed' | 'not_run' | 'blocked' | 'cancelled';
  toolIdentity?: string;
  artifacts?: ArtifactRefLike[];
  checks: CheckResultLike[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: { code: string; message: string };
}

export interface HttpResult<T> { status: number; body: T; text: string; headers: Record<string, string> }

export async function httpJson<T = any>(url: string, init?: RequestInit): Promise<HttpResult<T>> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* 保持原始文本 */ }
  return { status: response.status, body: body as T, text, headers: Object.fromEntries(response.headers.entries()) };
}

// 无请求体时必须真的不发 body：发空字符串会被产品当成非法请求体（INVALID_INPUT），
// 那是正确的合同行为，不是产品缺陷。
const jsonPost = (payload?: unknown): RequestInit => (payload === undefined
  ? { method: 'POST' }
  : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

export const startChecks = (base: string, candidateId: string, body?: { rerun?: boolean }) =>
  httpJson<CheckRunLike>(`${base}/candidates/${encodeURIComponent(candidateId)}/checks`, jsonPost(body));

export const getCheckRun = (base: string, runId: string) => httpJson<CheckRunLike>(`${base}/checks/${encodeURIComponent(runId)}`);

export const cancelCheckRun = (base: string, runId: string) =>
  httpJson<CheckRunLike>(`${base}/checks/${encodeURIComponent(runId)}/cancel`, jsonPost());

export const listCandidates = (base: string) => httpJson<any[]>(`${base}/candidates`);

export const getCandidate = (base: string, id: string) => httpJson<any>(`${base}/candidates/${encodeURIComponent(id)}`);

export const adoptCandidate = (base: string, id: string) =>
  httpJson(`${base}/candidates/${encodeURIComponent(id)}/adopt`, { method: 'POST' });

export const revertVersion = (base: string) => httpJson(`${base}/version/revert`, { method: 'POST' });

export const getVersion = (base: string) => httpJson<{ version: string }>(`${base}/version`);

export const history = (base: string, since = 0) =>
  httpJson<{ events: Array<Record<string, any>>; current: number; oldest: number; truncated: boolean }>(`${base}/events/history?since=${since}`);

export interface ArtifactResponse { status: number; headers: Record<string, string>; bytes: Buffer; text: string }

export async function readArtifact(base: string, runId: string, name: string): Promise<ArtifactResponse> {
  const response = await fetch(`${base}/checks/${encodeURIComponent(runId)}/artifacts/${name}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), bytes: buffer, text: buffer.toString('utf8') };
}

export const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

export const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export const TERMINAL_RUN_STATUS = ['completed', 'cancelled'] as const;

export const isTerminal = (run: Pick<CheckRunLike, 'status'>) =>
  (TERMINAL_RUN_STATUS as readonly string[]).includes(run.status);

export interface WaitOptions { timeoutMs?: number; intervalMs?: number; onPoll?: (run: CheckRunLike) => void }

/** 轮询 GET /checks/:id 直到终态；超时如实抛错，不做任何重试式掩盖。 */
export async function waitCheckRun(base: string, runId: string, options: WaitOptions = {}): Promise<CheckRunLike> {
  const timeoutMs = options.timeoutMs ?? 240_000;
  const intervalMs = options.intervalMs ?? 300;
  const started = Date.now();
  let last: CheckRunLike | null = null;
  while (Date.now() - started < timeoutMs) {
    const result = await getCheckRun(base, runId);
    if (result.status !== 200) throw new Error(`GET /checks/${runId} 返回 ${result.status}：${result.text.slice(0, 300)}`);
    last = result.body;
    options.onPoll?.(last);
    if (isTerminal(last)) return last;
    await sleep(intervalMs);
  }
  throw new Error(`等待检查终态超时（${timeoutMs}ms）：${JSON.stringify(last?.checks ?? null).slice(0, 400)}`);
}

/** 断言 run 是"四项真通过 + 六份证据齐全"。 */
export function assertPassedRun(run: CheckRunLike): void {
  if (run.status !== 'completed' || run.outcome !== 'passed') {
    throw new Error(`检查未通过：status=${run.status} outcome=${run.outcome} checks=${JSON.stringify(run.checks)}`);
  }
  if (run.checks.length !== 4) throw new Error(`检查项数量不是 4：${JSON.stringify(run.checks)}`);
  run.checks.forEach((check, index) => {
    if (check.name !== CHECK_ORDER[index]) throw new Error(`检查顺序不对：${JSON.stringify(run.checks)}`);
    if (check.status !== 'passed') throw new Error(`检查 ${check.name} 未通过：${JSON.stringify(check)}`);
    if (!check.evidence) throw new Error(`检查 ${check.name} 没有证据摘要：${JSON.stringify(check)}`);
  });
  const names = (run.artifacts ?? []).map((ref) => ref.name);
  for (const required of REQUIRED_ARTIFACTS) {
    if (!names.includes(required)) throw new Error(`缺少证据 ${required}：${JSON.stringify(names)}`);
  }
}

/**
 * 旧 M2 / M3-A 用例迁移入口：先显式跑真实检查并等到本次 run 终态，通过后才允许继续原来的采用断言。
 * 已存在同身份完成通过的 run 时直接复用（产品语义），否则发起新的检查并等待。
 */
export async function ensureChecksPassed(base: string, candidateId: string, options: { timeoutMs?: number } = {}): Promise<CheckRunLike> {
  const candidate = await getCandidate(base, candidateId);
  if (candidate.status !== 200) throw new Error(`候选 ${candidateId} 不存在：${candidate.status} ${candidate.text.slice(0, 200)}`);
  const latestId: string | undefined = candidate.body?.latestCheckRunId;
  if (latestId) {
    const existing = await getCheckRun(base, latestId);
    if (existing.status === 200 && existing.body.status === 'completed' && existing.body.outcome === 'passed') {
      assertPassedRun(existing.body);
      return existing.body;
    }
  }
  const started = await startChecks(base, candidateId);
  if (started.status !== 202) throw new Error(`发起检查失败：${started.status} ${started.text.slice(0, 400)}`);
  const run = isTerminal(started.body) ? started.body : await waitCheckRun(base, started.body.id, { timeoutMs: options.timeoutMs });
  if (run.candidateId !== candidateId) throw new Error(`检查 run 不属于候选：${run.candidateId} != ${candidateId}`);
  assertPassedRun(run);
  return run;
}
