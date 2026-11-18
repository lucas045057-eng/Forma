import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task, WorkStarter, WorkSummary, WorksState } from '@spatial/shared';
import type { CodingAgentOptions } from '../agent/client.ts';
import { writeAtomic } from '../assets/atomic-file.ts';
import type { AssetService } from '../assets/service.ts';
import type { StudioEvent } from '../events.ts';
import { ModuleSceneService } from '../scene/modules.ts';
import { SceneService } from '../scene/service.ts';
import { allocatePreviewPort, previewViteEntry } from './preview.ts';
import { WorkError } from './repo.ts';
import { WorkService, type WorkServiceOptions } from './service.ts';
import { scaffoldWorkDirectory } from './starter-templates.ts';

interface StoredWorkRecord {
  id: string;
  name: string;
  starter: WorkStarter;
  createdAt: string;
  updatedAt: string;
  initialPrompt?: string;
}

interface StoredWorksIndex {
  schemaVersion: 1;
  activeId: string;
  works: StoredWorkRecord[];
}

export interface WorkInstance {
  id: string;
  workRoot: string;
  workDataDirectory: string;
  historyDirectory: string;
  scene: SceneService;
  work: WorkService;
  modules: ModuleSceneService;
}

interface RunningMainPreview {
  workId: string;
  port: number;
  child: ChildProcess;
  exited: Promise<void>;
}

function probe(port: number, url: string): Promise<number> {
  return new Promise(resolve => {
    const req = httpRequest({ host: '127.0.0.1', port, path: url, method: 'GET', timeout: 5000 }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
  });
}

export interface WorkspaceManagerOptions {
  defaultWorkRoot: string;
  workDataDirectory: string;
  defaultHistoryDirectory: string;
  agent: CodingAgentOptions;
  checks?: WorkServiceOptions['checks'];
  previewStartTimeoutMs?: number;
  emit: (event: { type: string } & Record<string, unknown>) => StudioEvent;
}

export class WorkspaceManager {
  private readonly options: WorkspaceManagerOptions;
  private readonly indexFile: string;
  private readonly instances = new Map<string, WorkInstance>();
  private index: StoredWorksIndex = { schemaVersion: 1, activeId: 'default', works: [] };
  private mainPreview?: RunningMainPreview;
  private dynamicPreviewEnabled = false;
  private defaultMainPort?: number;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;

  constructor(options: WorkspaceManagerOptions) {
    this.options = options;
    this.indexFile = path.join(options.workDataDirectory, 'works-index.json');
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  enableDynamicMainPreview(defaultMainPort: number): void {
    this.defaultMainPort = defaultMainPort;
    this.dynamicPreviewEnabled = true;
  }

  activeMainPort(): number | undefined {
    if (this.index.activeId === 'default') return this.defaultMainPort;
    if (this.mainPreview?.workId === this.index.activeId) return this.mainPreview.port;
    return this.defaultMainPort;
  }

  private emitScoped(workId: string, event: { type: string } & Record<string, unknown>): StudioEvent {
    if (this.index.activeId === workId) {
      return this.options.emit(event);
    }
    return { ...event, seq: 0, ts: new Date().toISOString() } as StudioEvent;
  }

  private pathsFor(id: string) {
    if (id === 'default') {
      return {
        workRoot: this.options.defaultWorkRoot,
        workDataDirectory: this.options.workDataDirectory,
        historyDirectory: this.options.defaultHistoryDirectory,
        lockHeld: true,
      };
    }
    const base = path.join(this.options.workDataDirectory, 'works', id);
    return {
      workRoot: path.join(base, 'work'),
      workDataDirectory: path.join(base, 'work-data'),
      historyDirectory: path.join(base, 'scene-history'),
      lockHeld: false,
    };
  }

  private async saveIndex(): Promise<void> {
    await writeAtomic(this.indexFile, JSON.stringify(this.index, null, 2) + '\n');
  }

  private async instantiate(id: string): Promise<WorkInstance> {
    const existing = this.instances.get(id);
    if (existing) return existing;
    const paths = this.pathsFor(id);
    await mkdir(paths.workDataDirectory, { recursive: true });
    await mkdir(paths.historyDirectory, { recursive: true });
    const scene = new SceneService({
      workRoot: paths.workRoot,
      historyDirectory: paths.historyDirectory,
      emit: event => this.emitScoped(id, event as unknown as { type: string } & Record<string, unknown>),
    });
    const work = new WorkService({
      workRoot: paths.workRoot,
      directory: paths.workDataDirectory,
      lockHeld: paths.lockHeld,
      previewStartTimeoutMs: this.options.previewStartTimeoutMs,
      checks: this.options.checks,
      agent: this.options.agent,
      emit: event => this.emitScoped(id, event),
    });
    await work.init();
    const modules = new ModuleSceneService({
      workRoot: paths.workRoot,
      directory: paths.workDataDirectory,
      repo: work.repo,
    });
    await modules.init();
    const instance: WorkInstance = {
      id,
      workRoot: paths.workRoot,
      workDataDirectory: paths.workDataDirectory,
      historyDirectory: paths.historyDirectory,
      scene,
      work,
      modules,
    };
    this.instances.set(id, instance);
    return instance;
  }

  async init(): Promise<void> {
    const now = new Date().toISOString();
    try {
      const saved = JSON.parse(await readFile(this.indexFile, 'utf8')) as StoredWorksIndex;
      if (saved?.schemaVersion === 1 && Array.isArray(saved.works) && saved.works.some(item => item.id === 'default')) {
        this.index = saved;
      }
    } catch {
      // initialize fresh index below
    }
    if (!this.index.works.some(item => item.id === 'default')) {
      this.index.works.unshift({
        id: 'default',
        name: '木间香薰',
        starter: 'product-page',
        createdAt: now,
        updatedAt: now,
      });
      this.index.activeId = 'default';
      await this.saveIndex();
    }
    if (!this.index.works.some(item => item.id === this.index.activeId)) {
      this.index.activeId = 'default';
      await this.saveIndex();
    }
    await this.instantiate('default');
    if (this.index.activeId !== 'default') {
      await this.instantiate(this.index.activeId);
    }
  }

  async ensureActiveMainPreview(): Promise<void> {
    if (!this.dynamicPreviewEnabled) return;
    const activeId = this.index.activeId;
    if (activeId === 'default') {
      await this.stopMainPreview();
      return;
    }
    if (this.mainPreview?.workId === activeId && this.mainPreview.child.exitCode === null) return;
    await this.stopMainPreview();
    const instance = await this.instantiate(activeId);
    let vite: string;
    try {
      vite = await previewViteEntry(instance.workRoot);
    } catch {
      vite = await previewViteEntry(this.options.defaultWorkRoot);
    }
    const port = await allocatePreviewPort();
    const cacheDir = path.join(instance.workDataDirectory, 'main-preview-cache');
    const env: NodeJS.ProcessEnv = {
      CI: 'true',
      PREVIEW_BASE: '/preview/main/',
      PREVIEW_PORT: String(port),
      PREVIEW_CACHE_DIR: cacheDir,
      PREVIEW_ORIGIN_PORT: process.env.PREVIEW_ORIGIN_PORT ?? '5175',
    };
    for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'ComSpec']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const worker = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './preview-worker.ts' : './preview-worker.js', import.meta.url));
    const child = spawn(process.execPath, [worker, vite], {
      cwd: instance.workRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    let output = '';
    const collect = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-4000); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    let failed = false;
    const exited = new Promise<void>(resolve => {
      const finish = () => {
        failed = true;
        if (this.mainPreview?.child === child) this.mainPreview = undefined;
        resolve();
      };
      child.once('error', finish);
      child.once('close', finish);
    });
    this.mainPreview = { workId: activeId, port, child, exited };
    const deadline = Date.now() + (this.options.previewStartTimeoutMs ?? 90_000);
    try {
      for (;;) {
        if (this.closing || failed || child.exitCode !== null) {
          throw new WorkError('PREVIEW_START_FAILED', `作品主预览启动失败：${output.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(-400)}`, 502);
        }
        if (await probe(port, '/preview/main/') === 200) break;
        if (Date.now() > deadline) throw new WorkError('PREVIEW_START_TIMEOUT', '作品主预览启动超时', 504);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      await probe(port, '/preview/main/src/main.tsx');
    } catch (error) {
      await this.stopMainPreview();
      throw error;
    }
  }

  private async stopMainPreview(): Promise<void> {
    const running = this.mainPreview;
    if (!running) return;
    this.mainPreview = undefined;
    running.child.kill();
    const timer = setTimeout(() => running.child.kill('SIGKILL'), 5000);
    await running.exited;
    clearTimeout(timer);
  }

  current(): WorkInstance {
    const active = this.instances.get(this.index.activeId) ?? this.instances.get('default');
    if (!active) throw new WorkError('WORK_NOT_INITIALIZED', '当前作品尚未初始化', 503);
    return active;
  }

  list(): WorksState {
    return {
      activeId: this.index.activeId,
      works: this.index.works.map(item => ({
        ...item,
        active: item.id === this.index.activeId,
      })),
    };
  }

  getSummary(id = this.index.activeId): WorkSummary {
    const found = this.index.works.find(item => item.id === id);
    if (!found) throw new WorkError('WORK_NOT_FOUND', '作品不存在', 404);
    return { ...found, active: found.id === this.index.activeId };
  }

  async create(input: {
    name?: string;
    starter?: WorkStarter;
    prompt?: string;
    assetId?: string;
    assets?: AssetService;
  }): Promise<{ activeId: string; work: WorkSummary; version: string; task?: Task }> {
    return this.serial(async () => {
      if (this.closing) throw new WorkError('SERVICE_CLOSING', '服务正在关闭', 503);
      if (this.index.works.length >= 24) throw new WorkError('WORK_LIMIT', '本地最多保留 24 个作品，请先整理现有作品', 409);
      const starter: WorkStarter = input.starter === 'product-page' ? 'product-page' : 'blank';
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (prompt.length > 4000) throw new WorkError('INVALID_INPUT', '生成描述不能超过 4000 字', 400);
      const inferredName = prompt ? prompt.slice(0, 18).replace(/[，。！？,.!?\s]+$/g, '') : starter === 'blank' ? '未命名空间作品' : '木间香薰副本';
      const rawName = (typeof input.name === 'string' ? input.name.trim() : '') || inferredName;
      if (rawName.length < 1 || rawName.length > 60) throw new WorkError('INVALID_INPUT', '作品名称长度需在 1 到 60 字之间', 400);

      const id = `work-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
      const now = new Date().toISOString();
      const paths = this.pathsFor(id);

      await scaffoldWorkDirectory({
        targetWorkRoot: paths.workRoot,
        starter,
        name: rawName,
        dependencySourceRoots: [this.options.defaultWorkRoot],
      });

      const record: StoredWorkRecord = {
        id,
        name: rawName,
        starter,
        createdAt: now,
        updatedAt: now,
        ...(prompt ? { initialPrompt: prompt } : {}),
      };
      this.index.works.push(record);
      const previousId = this.index.activeId;
      this.index.activeId = id;
      await this.saveIndex();

      let instance: WorkInstance;
      try {
        instance = await this.instantiate(id);
        if (input.assetId && input.assets) {
          await instance.work.repo.exclusive(() => instance.scene.adopt(input.assets!, input.assetId!, true));
        }
        await this.ensureActiveMainPreview();
      } catch (error) {
        this.index.activeId = previousId;
        this.index.works = this.index.works.filter(item => item.id !== id);
        await this.saveIndex().catch(() => {});
        throw error;
      }

      const { version } = await instance.work.version();
      const summary = this.getSummary(id);
      this.options.emit({ type: 'work.changed', activeId: id, previousId, work: summary, version });

      let task: Task | undefined;
      if (prompt) {
        task = await instance.work.submit(prompt, undefined, { bootstrap: true });
      }
      return { activeId: id, work: summary, version, ...(task ? { task } : {}) };
    });
  }

  async select(id: string): Promise<{ activeId: string; work: WorkSummary; version: string }> {
    return this.serial(async () => {
      if (this.closing) throw new WorkError('SERVICE_CLOSING', '服务正在关闭', 503);
      const found = this.index.works.find(item => item.id === id);
      if (!found) throw new WorkError('WORK_NOT_FOUND', '作品不存在', 404);
      const previousId = this.index.activeId;
      const instance = await this.instantiate(id);
      this.index.activeId = id;
      found.updatedAt = new Date().toISOString();
      await this.saveIndex();
      await this.ensureActiveMainPreview();
      const { version } = await instance.work.version();
      const summary = this.getSummary(id);
      if (previousId !== id) {
        this.options.emit({ type: 'work.changed', activeId: id, previousId, work: summary, version });
      }
      return { activeId: id, work: summary, version };
    });
  }

  async rename(id: string, name: string): Promise<WorkSummary> {
    return this.serial(async () => {
      const found = this.index.works.find(item => item.id === id);
      if (!found) throw new WorkError('WORK_NOT_FOUND', '作品不存在', 404);
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 60) throw new WorkError('INVALID_INPUT', '作品名称长度需在 1 到 60 字之间', 400);
      found.name = trimmed;
      found.updatedAt = new Date().toISOString();
      await this.saveIndex();
      const summary = this.getSummary(id);
      this.options.emit({ type: 'work.updated', work: summary });
      return summary;
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.stopMainPreview().catch(() => {});
    let firstError: unknown;
    for (const instance of [...this.instances.values()].reverse()) {
      try { await instance.work.close(); } catch (err) { firstError ??= err; }
      try { await instance.scene.idle(); } catch (err) { firstError ??= err; }
    }
    this.instances.clear();
    if (firstError) throw firstError;
  }
}
