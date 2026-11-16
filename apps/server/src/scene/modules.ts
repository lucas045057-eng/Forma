import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { moduleConfigPath, parseSceneModuleConfig, type SceneModuleConfig } from '@spatial/shared/scene-module';
import { writeAtomic } from '../assets/atomic-file.ts';
import { WorkError, type WorkRepo } from '../work/repo.ts';
import { adjustedConfig, assertAnimationClip, listModuleConfigs, readModuleConfig } from '../work/asset-module.ts';
import { safeWorkPath } from './service.ts';

export interface ModuleHistoryEntry {
  id: string;
  kind: 'adjust' | 'replace-model' | 'undo';
  at: string;
  before: SceneModuleConfig;
  after: SceneModuleConfig;
  beforeHash: string;
  afterHash: string;
  workVersionBefore: string;
  workVersionAfter: string;
}

interface Pending {
  id: string;
  kind: ModuleHistoryEntry['kind'];
  at: string;
  before: SceneModuleConfig;
  after: SceneModuleConfig;
  workVersionBefore: string;
}

interface Journal {
  schemaVersion: 1;
  instanceId: string;
  segmentBase?: string;
  cursorVersion?: string;
  entries: ModuleHistoryEntry[];
  archive: ModuleHistoryEntry[];
  pending?: Pending;
  conflict?: string;
}

const MAX_ENTRIES = 50;
function hashConfig(config: SceneModuleConfig): string { return createHash('sha256').update(JSON.stringify(config)).digest('hex'); }
function cloneConfig(config: SceneModuleConfig): SceneModuleConfig { return structuredClone(config); }

/**
 * Instance-scoped transform/model history. The journal lives in the work data directory, never in
 * model-writable source. Every mutation is bound to the exact work version it was prepared for;
 * an interleaved main-scene write, candidate adoption or version revert invalidates the cursor.
 */
export class ModuleSceneService {
  private readonly workRoot: string;
  private readonly directory: string;
  private readonly repo: WorkRepo;
  private historyRoot = '';

  constructor(options: { workRoot: string; directory: string; repo: WorkRepo }) {
    this.workRoot = options.workRoot;
    this.directory = path.join(options.directory, 'module-history');
    this.repo = options.repo;
  }

  private async root(): Promise<string> {
    if (this.historyRoot) return this.historyRoot;
    const id = createHash('sha256').update(await realpath(this.workRoot)).digest('hex').slice(0, 24);
    this.historyRoot = path.join(this.directory, id);
    await mkdir(this.historyRoot, { recursive: true });
    return this.historyRoot;
  }

  private async file(instanceId: string): Promise<string> {
    if (!/^[a-f0-9]{32}$/.test(instanceId)) throw new WorkError('INVALID_MODULE', '实例编号无效');
    return path.join(await this.root(), `${instanceId}.json`);
  }

  private async load(instanceId: string): Promise<Journal> {
    const empty: Journal = { schemaVersion: 1, instanceId, entries: [], archive: [] };
    try {
      const parsed = JSON.parse(await readFile(await this.file(instanceId), 'utf8')) as Journal;
      if (parsed.schemaVersion !== 1 || parsed.instanceId !== instanceId || !Array.isArray(parsed.entries) || !Array.isArray(parsed.archive)) {
        throw new Error('invalid module journal');
      }
      return { ...parsed, entries: parsed.entries.slice(-MAX_ENTRIES), archive: parsed.archive.slice(-MAX_ENTRIES) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty;
      throw new WorkError('INVALID_MODULE_HISTORY', '独立3D实例历史无法读取，拒绝覆盖', 409);
    }
  }

  private async save(journal: Journal): Promise<void> {
    await writeAtomic(await this.file(journal.instanceId), JSON.stringify({ ...journal, entries: journal.entries.slice(-MAX_ENTRIES), archive: journal.archive.slice(-MAX_ENTRIES) }, null, 2) + '\n');
  }

  private async recoverOne(journal: Journal): Promise<Journal> {
    const pending = journal.pending;
    if (!pending) return journal;
    let current: SceneModuleConfig | undefined;
    try { current = await readModuleConfig(this.workRoot, journal.instanceId); } catch { current = undefined; }
    const currentHash = current ? hashConfig(current) : '';
    if (currentHash !== hashConfig(pending.before) && currentHash !== hashConfig(pending.after)) {
      journal.pending = undefined;
      journal.cursorVersion = undefined;
      journal.conflict = '中断恢复时发现配置已被其他改动覆盖；未回放旧快照';
      await this.save(journal);
      return journal;
    }
    if (currentHash === hashConfig(pending.before)) {
      await writeAtomic(await this.path(journal.instanceId), JSON.stringify(pending.after, null, 2) + '\n');
    }
    const version = await this.repo.snapshot();
    if (!journal.entries.some(entry => entry.id === pending.id)) {
      if (pending.kind === 'undo') {
        if (journal.entries.at(-1)?.id === pending.id) journal.entries.pop();
        else journal.entries.pop();
      } else {
        journal.entries.push({
          id: pending.id, kind: pending.kind, at: pending.at, before: pending.before, after: pending.after,
          beforeHash: hashConfig(pending.before), afterHash: hashConfig(pending.after),
          workVersionBefore: pending.workVersionBefore, workVersionAfter: version,
        });
      }
    }
    journal.cursorVersion = version;
    journal.pending = undefined;
    journal.conflict = undefined;
    await this.save(journal);
    return journal;
  }

  private async journalFor(instanceId: string): Promise<Journal> {
    const loaded = await this.load(instanceId);
    return loaded.pending ? this.recoverOne(loaded) : loaded;
  }

  async init(): Promise<void> {
    const root = await this.root();
    const names = await readdir(root).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]; throw error; });
    for (const name of names) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
      const instanceId = name.slice(0, 32);
      await this.repo.exclusive(async () => {
        const journal = await this.load(instanceId);
        if (journal.pending) await this.recoverOne(journal);
      });
    }
  }

  private async path(instanceId: string): Promise<string> {
    return safeWorkPath(this.workRoot, moduleConfigPath(instanceId));
  }

  async list(): Promise<Array<{ config: SceneModuleConfig; canUndo: boolean; stale: boolean; entries: number }>> {
    return this.repo.exclusive(async () => {
      const head = await this.repo.head();
      const configs = await listModuleConfigs(this.workRoot);
      const result = [];
      for (const config of configs) {
        const journal = await this.load(config.instanceId);
        result.push({
          config, canUndo: journal.cursorVersion === head && journal.entries.length > 0,
          stale: !!journal.cursorVersion && journal.cursorVersion !== head,
          entries: journal.entries.length,
        });
      }
      return result;
    });
  }

  async get(instanceId: string): Promise<{ config: SceneModuleConfig; canUndo: boolean; stale: boolean; history: ModuleHistoryEntry[]; conflict?: string }> {
    return this.repo.exclusive(async () => {
      const head = await this.repo.head();
      const config = await readModuleConfig(this.workRoot, instanceId);
      const journal = await this.load(instanceId);
      return {
        config, history: [...journal.archive.slice(-10), ...journal.entries].map(entry => structuredClone(entry)),
        canUndo: journal.cursorVersion === head && journal.entries.length > 0,
        stale: !!journal.cursorVersion && journal.cursorVersion !== head,
        ...(journal.conflict ? { conflict: journal.conflict } : {}),
      };
    });
  }

  async adjust(instanceId: string, patch: unknown, expectedWorkVersion: string): Promise<{ config: SceneModuleConfig; version: string }> {
    return this.repo.exclusive(async () => {
      await this.journalFor(instanceId);
      const head = await this.repo.head();
      if (expectedWorkVersion !== head) throw new WorkError('MODULE_HISTORY_STALE', '作品版本已变化，请重新载入实例后再调整', 409);
      const before = await readModuleConfig(this.workRoot, instanceId);
      const after = adjustedConfig(before, patch);
      await assertAnimationClip(this.workRoot, after.assetId, after.animation.clip);
      if (hashConfig(before) === hashConfig(after)) throw new WorkError('NO_CHANGES', '实例配置没有变化', 409);
      const journal = await this.journalFor(instanceId);
      if (journal.cursorVersion && journal.cursorVersion !== head) {
        journal.archive.push(...journal.entries);
        journal.entries = [];
        journal.segmentBase = head;
      }
      journal.segmentBase ??= head;
      const pending: Pending = {
        id: createHash('sha256').update(`${instanceId}:${head}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 32),
        kind: 'adjust', at: new Date().toISOString(), before: cloneConfig(before), after: cloneConfig(after), workVersionBefore: head,
      };
      journal.pending = pending;
      await this.save(journal);
      await writeAtomic(await this.path(instanceId), JSON.stringify(after, null, 2) + '\n');
      const version = await this.repo.snapshot();
      journal.entries.push({
        id: pending.id, kind: 'adjust', at: pending.at, before: pending.before, after: pending.after,
        beforeHash: hashConfig(pending.before), afterHash: hashConfig(pending.after),
        workVersionBefore: head, workVersionAfter: version,
      });
      journal.cursorVersion = version;
      journal.pending = undefined;
      journal.conflict = undefined;
      await this.save(journal);
      return { config: after, version };
    });
  }

  async replaceModel(instanceId: string, assetId: string, expectedWorkVersion: string): Promise<{ config: SceneModuleConfig; version: string }> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(assetId)) throw new WorkError('INVALID_ASSET', '资产编号无效');
    return this.repo.exclusive(async () => {
      await this.journalFor(instanceId);
      const head = await this.repo.head();
      if (expectedWorkVersion !== head) throw new WorkError('MODULE_HISTORY_STALE', '作品版本已变化，请重新载入实例后再替换模型', 409);
      const before = await readModuleConfig(this.workRoot, instanceId);
      const after = parseSceneModuleConfig({ ...before, assetId, model: `/assets/${assetId}.glb` });
      await assertAnimationClip(this.workRoot, assetId, after.animation.clip);
      if (hashConfig(before) === hashConfig(after)) throw new WorkError('NO_CHANGES', '实例已经使用该模型', 409);
      const journal = await this.journalFor(instanceId);
      if (journal.cursorVersion && journal.cursorVersion !== head) {
        journal.archive.push(...journal.entries);
        journal.entries = [];
        journal.segmentBase = head;
      }
      journal.segmentBase ??= head;
      const pending: Pending = {
        id: createHash('sha256').update(`${instanceId}:${head}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 32),
        kind: 'replace-model', at: new Date().toISOString(), before: cloneConfig(before), after: cloneConfig(after), workVersionBefore: head,
      };
      journal.pending = pending;
      await this.save(journal);
      await writeAtomic(await this.path(instanceId), JSON.stringify(after, null, 2) + '\n');
      const version = await this.repo.snapshot();
      journal.entries.push({
        id: pending.id, kind: 'replace-model', at: pending.at, before: pending.before, after: pending.after,
        beforeHash: hashConfig(pending.before), afterHash: hashConfig(pending.after),
        workVersionBefore: head, workVersionAfter: version,
      });
      journal.cursorVersion = version;
      journal.pending = undefined;
      journal.conflict = undefined;
      await this.save(journal);
      return { config: after, version };
    });
  }

  async undo(instanceId: string, expectedWorkVersion: string): Promise<{ config: SceneModuleConfig; version: string }> {
    return this.repo.exclusive(async () => {
      await this.journalFor(instanceId);
      const head = await this.repo.head();
      if (expectedWorkVersion !== head) throw new WorkError('MODULE_HISTORY_STALE', '作品版本已变化，请重新载入实例后再撤回', 409);
      const journal = await this.journalFor(instanceId);
      if (journal.cursorVersion !== head) throw new WorkError('MODULE_HISTORY_STALE', '实例历史游标已失效，请重新载入后再撤回', 409);
      const last = journal.entries.at(-1);
      if (!last) throw new WorkError('NO_MODULE_HISTORY', '该实例没有可撤回的调整', 409);
      const before = await readModuleConfig(this.workRoot, instanceId);
      if (hashConfig(before) !== last.afterHash) throw new WorkError('MODULE_HISTORY_STALE', '实例配置与历史不一致，拒绝覆盖', 409);
      const after = cloneConfig(last.before);
      const pending: Pending = {
        id: createHash('sha256').update(`${instanceId}:${head}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 32),
        kind: 'undo', at: new Date().toISOString(), before: cloneConfig(before), after: cloneConfig(after), workVersionBefore: head,
      };
      journal.pending = pending;
      await this.save(journal);
      await writeAtomic(await this.path(instanceId), JSON.stringify(after, null, 2) + '\n');
      const version = await this.repo.snapshot();
      journal.entries.pop();
      journal.cursorVersion = version;
      journal.pending = undefined;
      journal.conflict = undefined;
      await this.save(journal);
      return { config: after, version };
    });
  }
}
