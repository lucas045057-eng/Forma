import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { linkWorkDependencies, scaffoldWorkDirectory } from '../../apps/server/src/work/starter-templates.ts';
import { systemEnvironment } from '../demo/safety.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Set(process.argv.slice(2));
const ephemeral = args.has('--ephemeral');

// Chromium Fetch-restricted ports to avoid when allocating ephemeral ports
const CHROMIUM_UNSAFE_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);

function loadDotEnvSafe(envFilePath) {
  if (!existsSync(envFilePath)) return {};
  // Strip leading UTF-8 BOM (\uFEFF) so line-1 keys are never corrupted
  const raw = readFileSync(envFilePath, 'utf8').replace(/^\uFEFF/, '');
  const parsed = parseEnv(raw);
  const cleaned = {};
  for (const [k, v] of Object.entries(parsed)) {
    const cleanKey = k.replace(/^\uFEFF/, '').trim();
    if (cleanKey && typeof v === 'string' && v.trim()) {
      cleaned[cleanKey] = v.trim();
    }
  }
  return cleaned;
}

async function allocateFreePort(preferredPort = 0, used = new Set()) {
  const tryBind = port =>
    new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => {
        const assigned = srv.address().port;
        srv.close(() => resolve(assigned));
      });
    });

  if (preferredPort > 0 && !CHROMIUM_UNSAFE_PORTS.has(preferredPort) && !used.has(preferredPort)) {
    try {
      const bound = await tryBind(preferredPort);
      used.add(bound);
      return bound;
    } catch {
      // fall through to ephemeral port
    }
  }

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const assigned = await tryBind(0);
    if (!CHROMIUM_UNSAFE_PORTS.has(assigned) && !used.has(assigned)) {
      used.add(assigned);
      return assigned;
    }
  }
  throw new Error('Unable to allocate free safe loopback port');
}

async function ensureFormaWorkspace(workspaceRoot) {
  await mkdir(workspaceRoot, { recursive: true });
  const defaultWorkDir = path.join(workspaceRoot, 'work');
  const pkgJson = path.join(defaultWorkDir, 'package.json');
  if (!existsSync(pkgJson)) {
    await scaffoldWorkDirectory({
      targetWorkRoot: defaultWorkDir,
      starter: 'product-page',
      name: '木间香薰',
      dependencySourceRoots: [path.join(repository, 'templates/product-page')],
    });
  } else {
    const nodeModulesPath = path.join(defaultWorkDir, 'node_modules');
    try {
      await lstat(nodeModulesPath);
    } catch {
      await linkWorkDependencies(defaultWorkDir, [path.join(repository, 'templates/product-page')]);
    }
  }
}

const dotEnv = loadDotEnvSafe(path.join(repository, 'apps/server/.env'));
const baseSysEnv = systemEnvironment(process.env);
const backendEnv = { ...baseSysEnv };

const PROVIDER_ENV_KEYS = [
  'CODING_AGENT_BASE_URL',
  'CODING_AGENT_API_KEY',
  'CODING_AGENT_MODEL',
  'DASHSCOPE_API_KEY',
  'SPEECH_BASE_URL',
  'SPEECH_MODEL',
  'LUX3D_BASE',
  'LUX3D_WORKBENCH_BASE',
  'LUX3D_API_KEY',
  'LUX3D_UPLOAD_HOSTS',
  'ALLOWED_HOSTS',
  'AGORA_APP_ID',
  'AGORA_APP_CERTIFICATE',
  'AGORA_CUSTOMER_ID',
  'AGORA_CUSTOMER_SECRET',
  'VOICE_COPILOT_VENDOR',
  'VOICE_COPILOT_MODEL',
  'VOICE_COPILOT_VOICE',
  'VOICE_COPILOT_URL',
  'VOICE_COPILOT_MLLM_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
];

for (const key of PROVIDER_ENV_KEYS) {
  const val = process.env[key] ?? dotEnv[key];
  if (val) backendEnv[key] = val;
}
backendEnv.SPEECH_MODEL = backendEnv.SPEECH_MODEL ?? 'qwen3-asr-flash';

const workspaceRoot = ephemeral
  ? path.join(repository, '.data/forma-runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  : path.resolve(process.env.FORMA_DATA_DIR || path.join(repository, '.data/forma'));

await ensureFormaWorkspace(workspaceRoot);

const usedPorts = new Set();
const preferredStudio = Number(process.env.FORMA_PORT || 5173);
const studioPort = await allocateFreePort(preferredStudio, usedPorts);
const apiPort = await allocateFreePort(0, usedPorts);
const mainPort = await allocateFreePort(0, usedPorts);
const previewPort = await allocateFreePort(0, usedPorts);

const hasRealCoding = Boolean(backendEnv.CODING_AGENT_BASE_URL && backendEnv.CODING_AGENT_API_KEY && backendEnv.CODING_AGENT_MODEL);
const hasRealSpeech = Boolean(backendEnv.SPEECH_BASE_URL && backendEnv.DASHSCOPE_API_KEY);
const hasRealLux = Boolean(backendEnv.LUX3D_API_KEY);

const sharedPortsEnv = {
  FORMA_REPO_ROOT: repository,
  FORMA_WORKSPACE_ROOT: workspaceRoot,
  FORMA_STUDIO_PORT: String(studioPort),
  FORMA_API_PORT: String(apiPort),
  FORMA_MAIN_PORT: String(mainPort),
  FORMA_PREVIEW_PORT: String(previewPort),
  NODE_ENV: 'development',
};

const children = [];
let shutting = false;

async function shutdownAll() {
  if (shutting) return;
  shutting = true;
  for (const child of [...children].reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (child.connected) child.send({ type: 'shutdown' });
      } catch {
        // ignore IPC error
      }
      await new Promise(resolve => {
        const killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
          resolve();
        }, 8_000);
        child.once('close', () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }
  }
}

function spawnRole(scriptName, env) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(repository, 'scripts/forma', scriptName), [], {
      cwd: repository,
      env,
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    child.stdout?.on('data', chunk => process.stdout.write(chunk));
    child.stderr?.on('data', chunk => process.stderr.write(chunk));

    const timer = setTimeout(() => reject(new Error(`${scriptName} startup timed out`)), 60_000);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (!shutting) {
        reject(new Error(`${scriptName} exited unexpectedly (code=${code})`));
      }
    });
    child.on('message', msg => {
      if (msg?.type === 'ready') {
        clearTimeout(timer);
        resolve(child);
      }
    });
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    void shutdownAll().finally(() => process.exit(0));
  });
}

if (process.env.FORMA_DESKTOP_STDIN_SHUTDOWN === '1' && process.stdin) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (String(chunk).toLowerCase().includes('shutdown')) {
      void shutdownAll().finally(() => process.exit(0));
    }
  });
  process.stdin.once('end', () => {
    void shutdownAll().finally(() => process.exit(0));
  });
  process.stdin.resume();
}

try {
  await spawnRole('backend-entry.mjs', { ...backendEnv, ...sharedPortsEnv });
  // Frontend child gets ZERO provider API keys!
  await spawnRole('frontends-entry.mjs', {
    ...baseSysEnv,
    ...sharedPortsEnv,
    FORMA_UI_MODE: hasRealCoding || hasRealSpeech || hasRealLux ? 'real' : 'standalone',
  });

  const safeHost = raw => {
    try { return raw ? new URL(raw).hostname : 'unconfigured'; } catch { return 'invalid-url'; }
  };

  console.log(`Forma Studio=http://127.0.0.1:${studioPort}; workspace=${workspaceRoot}`);
  console.log(
    `Connected models: coding=${hasRealCoding ? `${backendEnv.CODING_AGENT_MODEL}@${safeHost(backendEnv.CODING_AGENT_BASE_URL)}` : 'unconfigured'}; ` +
    `speech=${hasRealSpeech ? `${backendEnv.SPEECH_MODEL}@${safeHost(backendEnv.SPEECH_BASE_URL)}` : 'unconfigured'}; ` +
    `lux3d=${hasRealLux ? safeHost(backendEnv.LUX3D_BASE || 'https://api.aholo.cn') : 'unconfigured'}`,
  );

  await Promise.all(children.map(c => new Promise(resolve => c.once('close', resolve))));
} catch (error) {
  console.error('[Forma Launcher Error]', error instanceof Error ? error.message : 'Startup failed');
  await shutdownAll();
  process.exitCode = 1;
}
