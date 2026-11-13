import path from 'node:path';

/** M2-A 测试的共享常量。 */

export const REPO_ROOT = process.cwd();
export const M2A_DATA = path.join(REPO_ROOT, '.data', 'pi-m2a');
export const WORK_DATA = path.join(M2A_DATA, 'work-data');
export const ASSETS = path.join(M2A_DATA, 'assets');
export const SCENE_HISTORY = path.join(M2A_DATA, 'scene-history');
export const GUARD_LOG = path.join(M2A_DATA, 'net-guard.log');
export const ARTIFACT_DIR = path.join(REPO_ROOT, 'docs', 'reports', 'artifacts', 'M2-A');

export const MOCK_PORT = 4011;
export const BACKEND_PORT = 3001;
export const STUDIO_PORT = 5173;
export const TEMPLATE_PORT = 5174;

/** 故意指向一个没人监听的 loopback 端口：证明 M2 全程不碰真实 Lux3D。 */
export const DEAD_LUX3D = 'http://127.0.0.1:4019';

export const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
export const BACKEND_BASE = `http://127.0.0.1:${BACKEND_PORT}`;
export const STUDIO_URL = `http://127.0.0.1:${STUDIO_PORT}/`;
export const PREVIEW_PATH = '/preview/main/';

/** 作品目录：M2 的 WORK_ROOT 就是真实模板目录（否则 /preview/main/ 不会反映采用结果）。测试结束必须还原。 */
export const WORK_ROOT = path.join(REPO_ROOT, 'templates', 'product-page');
export const TEMPLATE_APP = path.join(WORK_ROOT, 'src', 'App.tsx');

export const MOCK_KEY = 'mock-only';
export const MOCK_MODEL = 'mock-coder';

export const SERVER_DIR = path.join(REPO_ROOT, 'apps', 'server');
export const STUDIO_DIR = path.join(REPO_ROOT, 'apps', 'studio');
export const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates', 'product-page');

export const GUARD_SCRIPT = path.join(REPO_ROOT, 'tests', 'e2e', 'm0a', 'no-real-network.cjs');
export const GUARD_SCRIPT_ARG = GUARD_SCRIPT.split(path.sep).join('/');
export const BACKEND_LAUNCHER = path.join(REPO_ROOT, 'tests', 'e2e', 'm2a', 'start-backend.mjs');
export const AGENT_MOCK = path.join(REPO_ROOT, 'tests', 'e2e', 'm2a', 'agent-mock.mjs');

export const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
