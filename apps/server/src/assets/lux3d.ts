export class AssetError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'AssetError'; this.code = code; }
}
export type GenerationInput = { prompt?: string; img?: string; version: 'G1' | 'G1-Turbo' };
export interface RemoteTask { status: number; outputs?: { content: string }[] }

export class Lux3DClient {
  readonly base: string;
  private readonly key: string;
  constructor(options: { base?: string; key?: string }) {
    this.base = (options.base ?? 'https://api.aholo3d.cn').replace(/\/$/, '');
    const url = new URL(this.base);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid LUX3D_BASE');
    this.key = options.key ?? '';
  }
  private async request<T>(route: string, body?: unknown): Promise<T> {
    if (!this.key) throw new AssetError('MISSING_KEY', '后端尚未配置 LUX3D_API_KEY');
    let response: Response;
    try {
      response = await fetch(`${this.base}/lux3d/v1/${route}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: this.key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
    } catch { throw new AssetError('UPSTREAM_UNAVAILABLE', 'Lux3D 请求未确认，请查询已有任务，不要自动重复生成'); }
    if (!response.ok) throw new AssetError('UPSTREAM_HTTP', `Lux3D 返回 HTTP ${response.status}`);
    let envelope: { c?: unknown; d?: T };
    try { envelope = await response.json() as typeof envelope; }
    catch { throw new AssetError('UPSTREAM_FORMAT', 'Lux3D 返回无法解析的数据'); }
    if (String(envelope.c) !== '0' || envelope.d === undefined) {
      throw new AssetError('UPSTREAM_REJECTED', 'Lux3D 未接受请求，请核对参数、额度及并发任务');
    }
    return envelope.d;
  }
  private async create(route: string, body: unknown): Promise<string> {
    const id = String(await this.request<unknown>(route, body));
    if (!/^\d{1,20}$/.test(id)) throw new AssetError('UPSTREAM_FORMAT', 'Lux3D 未返回有效任务编号');
    return id;
  }
  createTextTo3d(input: GenerationInput) {
    return this.create('generate/text-to-3d/task/create', { prompt: input.prompt, version: input.version, outputFormat: ['glb'], enablePbr: true });
  }
  createImgTo3d(input: GenerationInput) {
    return this.create('generate/img-to-3d/task/create', { img: input.img, version: input.version, outputFormat: ['glb'], enablePbr: true });
  }
  createPartSplit(input: { glbUrl: string }) {
    return this.create('part-split/task/create', input);
  }
  async getTask(taskId: string): Promise<RemoteTask> {
    if (!/^\d{1,20}$/.test(taskId)) throw new AssetError('INVALID_TASK', '任务编号必须为数字');
    const task = await this.request<RemoteTask>(`generate/task/get?taskid=${taskId}`);
    if (!task || typeof task.status !== 'number') throw new AssetError('UPSTREAM_FORMAT', 'Lux3D 任务状态格式错误');
    return task;
  }
  listTasks() { return this.request<unknown>('generate/task/list'); }
}
