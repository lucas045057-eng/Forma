import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defaultSceneConfig } from '@spatial/shared/scene-config';
import { createApp } from '../app.ts';
import { CheckRunner } from '../checks/runner.ts';
import { computeSnapshot } from '../checks/snapshot.ts';
import { createRealExecutor } from '../checks/worker.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'forma-importer-test-'));
  roots.push(root);
  const workRoot = path.join(root, 'default-work');
  await mkdir(path.join(workRoot, 'src'), { recursive: true });
  await writeFile(path.join(workRoot, 'src/scene.config.json'), JSON.stringify(defaultSceneConfig, null, 2) + '\n');
  await writeFile(path.join(workRoot, 'src/App.tsx'), 'export default function App() { return <main>Default Work</main>; }\n');
  await writeFile(path.join(workRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, allowImportingTsExtensions: true } }, null, 2) + '\n');
  return {
    root,
    workRoot,
    assetsDir: path.join(root, 'assets'),
    workDataDir: path.join(root, 'work-data'),
    historyDir: path.join(root, 'history'),
  };
}

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

it('exposes safe read-only model connection status on GET /models/status without leaking secrets', async () => {
  const f = await fixture();
  const realSecret = 'sk-super-secret-never-expose-1234567890';
  const instance = await createApp({
    workRoot: f.workRoot,
    dataDirectory: f.assetsDir,
    workDataDirectory: f.workDataDir,
    historyDirectory: f.historyDir,
    base: 'https://api.aholo3d.cn',
    key: realSecret,
    codingAgentBaseUrl: 'https://xfastapi.ai/v1',
    codingAgentApiKey: realSecret,
    codingAgentModel: 'gpt-6.1-sol',
    speech: {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: realSecret,
      model: 'qwen3-asr-flash',
    },
  });
  try {
    const res = await instance.app.inject('/models/status');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(realSecret);
    expect(res.json()).toEqual({
      coding: {
        configured: true,
        mode: 'real',
        model: 'gpt-6.1-sol',
        providerHost: 'xfastapi.ai',
      },
      speech: {
        configured: true,
        mode: 'real',
        model: 'qwen3-asr-flash',
      },
      lux3d: {
        configured: true,
        mode: 'real',
        gateway: 'api.aholo3d.cn',
        legacyGateway: true,
      },
    });
  } finally {
    await instance.app.close();
  }
});

it('imports webpages via HTML, uploaded files (static & React), local directory, and URL while enforcing SSRF & symlink guards', async () => {
  const f = await fixture();

  // Prepare a local static webpage directory + a symlink directory to verify security rejection
  const siteDir = path.join(f.root, 'external-tea-site');
  await mkdir(path.join(siteDir, 'assets'), { recursive: true });
  await writeFile(
    path.join(siteDir, 'index.html'),
    `<!doctype html><html><head><title>本地松风书屋</title><link rel="stylesheet" href="theme.css"></head><body><section class="intro"><h1>松风书屋</h1><p>独立人文阅读空间</p><img src="assets/封面 图 (1).png" alt="书屋封面"></section></body></html>`,
  );
  await writeFile(path.join(siteDir, 'theme.css'), '.intro { padding: 32px; background: #f8f6f2; }\n');
  await writeFile(path.join(siteDir, 'assets/封面 图 (1).png'), TINY_PNG);
  await writeFile(path.join(siteDir, '.env'), 'SECRET_KEY=should_never_be_copied\n');

  const linkedDir = path.join(f.root, 'linked-site');
  await symlink(siteDir, linkedDir, 'junction');

  const instance = await createApp({
    workRoot: f.workRoot,
    dataDirectory: f.assetsDir,
    workDataDirectory: f.workDataDir,
    historyDirectory: f.historyDir,
    base: 'http://127.0.0.1:9',
    key: 'mock-only',
    codingAgentBaseUrl: 'http://127.0.0.1:9',
    codingAgentApiKey: 'mock-only',
    codingAgentModel: 'mock-model',
  });

  try {
    // 1. Create a free-web 2D work (without ProductHero)
    const freeCreated = await instance.app.inject({
      method: 'POST',
      url: '/works',
      payload: { starter: 'free-web', name: '极简个人作品集' },
    });
    expect(freeCreated.statusCode, freeCreated.body).toBe(201);
    expect(freeCreated.json().work).toMatchObject({ starter: 'free-web', name: '极简个人作品集' });
    const freeAppSource = await readFile(path.join(instance.workspace.current().workRoot, 'src/App.tsx'), 'utf8');
    expect(freeAppSource).toContain('data-spatial-page');
    expect(freeAppSource).not.toContain('ProductHero');

    // 2. Import via raw HTML
    const htmlImported = await instance.app.inject({
      method: 'POST',
      url: '/works/import',
      payload: {
        mode: 'html',
        html: '<!doctype html><html><head><title>曜石摄影展</title></head><body><article><h1>光与影的边界</h1><p>2026 年度纪实影像展</p></article></body></html>',
        css: 'article { max-width: 720px; margin: 40px auto; }',
      },
    });
    expect(htmlImported.statusCode, htmlImported.body).toBe(201);
    expect(htmlImported.json().work).toMatchObject({ starter: 'imported', name: '曜石摄影展' });

    // Run all 4 REAL checks (schema, build, smoke, occlusion) on this pure 2D button-less imported webpage!
    const htmlWorkRoot = instance.workspace.current().workRoot;
    const htmlVersion = htmlImported.json().version as string;
    const snap = await computeSnapshot(htmlWorkRoot, { toolIdentity: 'test-tools' });
    const checkDir = path.join(f.root, 'real-check-run');
    const runner = new CheckRunner({
      dataDirectory: checkDir,
      candidateId: 'imported01',
      candidatePath: htmlWorkRoot,
      candidateCommit: htmlVersion,
      baseVersion: htmlVersion,
      mainVersion: htmlVersion,
      contentDigest: snap.digest,
      toolIdentity: 'test-tools',
      executor: createRealExecutor(),
    });
    await runner.init();
    const started = await runner.startChecks('imported01');
    // Wait for completion
    let finalRun = runner.getRun(started.id);
    const deadline = Date.now() + 90_000;
    while ((finalRun.status === 'queued' || finalRun.status === 'running') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      finalRun = runner.getRun(started.id);
    }
    await runner.drain();
    expect(finalRun.outcome, JSON.stringify(finalRun.checks)).toBe('passed');
    expect(finalRun.checks.map(c => `${c.name}:${c.status}`)).toEqual([
      'schema:passed',
      'build:passed',
      'smoke:passed',
      'occlusion:passed',
    ]);

    // 3. Import via uploaded React folder (my-app/src/App.jsx without <main>)
    const reactImported = await instance.app.inject({
      method: 'POST',
      url: '/works/import',
      payload: {
        mode: 'files',
        name: 'React 计数器页',
        files: [
          {
            path: 'my-app/src/App.jsx',
            contentBase64: Buffer.from(
              'export default function ImportedCounter() { return <div className="box"><h2>计数器面板</h2><button type="button">+1</button></div>; }\n',
            ).toString('base64'),
          },
        ],
      },
    });
    expect(reactImported.statusCode, reactImported.body).toBe(201);
    const wrappedApp = await readFile(path.join(instance.workspace.current().workRoot, 'src/App.tsx'), 'utf8');
    expect(wrappedApp).toContain('data-spatial-page');
    expect(wrappedApp).toContain('ImportedRoot');

    // 4. Import via local directory (sanitizing non-ASCII image filenames & skipping .env)
    const dirImported = await instance.app.inject({
      method: 'POST',
      url: '/works/import',
      payload: { mode: 'directory', directoryPath: siteDir },
    });
    expect(dirImported.statusCode, dirImported.body).toBe(201);
    expect(dirImported.json().work.name).toBe('本地松风书屋');
    const dirWorkRoot = instance.workspace.current().workRoot;
    const dirAppTsx = await readFile(path.join(dirWorkRoot, 'src/App.tsx'), 'utf8');
    expect(dirAppTsx).toContain('${import.meta.env.BASE_URL}imported/');
    await expect(readFile(path.join(dirWorkRoot, '.env'))).rejects.toThrow();

    // Reject symlink/junction directory & internal workDataDir
    const symRejected = await instance.app.inject({
      method: 'POST',
      url: '/works/import',
      payload: { mode: 'directory', directoryPath: linkedDir },
    });
    expect(symRejected.statusCode).toBe(400);
    expect(symRejected.json().error.code).toBe('DIRECTORY_DENIED');

    const internalRejected = await instance.app.inject({
      method: 'POST',
      url: '/works/import',
      payload: { mode: 'directory', directoryPath: f.workDataDir },
    });
    expect(internalRejected.statusCode).toBe(400);
    expect(internalRejected.json().error.code).toBe('DIRECTORY_DENIED');

    // SSRF guard blocks loopback & metadata IPs by default
    const ssrfBlocked = await instance.app.inject({
      method: 'POST',
      url: '/works/import',
      payload: { mode: 'url', url: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(ssrfBlocked.statusCode).toBe(400);
    expect(ssrfBlocked.json().error.code).toBe('URL_HOST_DENIED');
  } finally {
    await instance.app.close();
  }
}, 120_000);

it('fetches HTML, linked stylesheets, and localized images when importing from URL via internal test seam', async () => {
  const f = await fixture();
  const remoteSite = createHttpServer((req, res) => {
    if (req.url === '/site.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('.banner { color: #1a2b3c; }');
      return;
    }
    if (req.url === '/logo.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(TINY_PNG);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>云端拉入展示页</title><link rel="stylesheet" href="/site.css"></head><body><div class="banner"><h1>云端网页已拉入</h1><img src="/logo.png" alt="Logo"></div></body></html>');
  });

  await new Promise<void>((resolve, reject) => {
    remoteSite.once('error', reject);
    remoteSite.listen(0, '127.0.0.1', resolve);
  });
  const port = (remoteSite.address() as AddressInfo).port;

  const instance = await createApp({
    workRoot: f.workRoot,
    dataDirectory: f.assetsDir,
    workDataDirectory: f.workDataDir,
    historyDirectory: f.historyDir,
    base: 'http://127.0.0.1:9',
    key: 'mock-only',
    codingAgentBaseUrl: 'http://127.0.0.1:9',
    codingAgentApiKey: 'mock-only',
    codingAgentModel: 'mock-model',
    importer: { allowLoopbackForTest: true },
  });

  try {
    const res = await instance.app.inject({
      method: 'POST',
      url: '/works/import',
      payload: { mode: 'url', url: `http://127.0.0.1:${port}/` },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().work).toMatchObject({ starter: 'imported', name: '云端拉入展示页' });
    const importedRoot = instance.workspace.current().workRoot;
    const styleCss = await readFile(path.join(importedRoot, 'src/style.css'), 'utf8');
    expect(styleCss).toContain('.banner { color: #1a2b3c; }');
    const appTsx = await readFile(path.join(importedRoot, 'src/App.tsx'), 'utf8');
    expect(appTsx).toContain('${import.meta.env.BASE_URL}imported/logo-');
  } finally {
    await instance.app.close();
    remoteSite.closeAllConnections();
    await new Promise<void>(resolve => remoteSite.close(() => resolve()));
  }
});
