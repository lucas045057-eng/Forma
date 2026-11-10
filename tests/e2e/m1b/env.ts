import path from 'node:path';

/** M1-B 测试的共享常量：`playwright.m1b.config.ts` 与测试代码都从这里取。 */

export const REPO_ROOT = process.cwd();
export const M1B_DATA = path.join(REPO_ROOT, '.data', 'pi-m1b');
export const ASSETS = path.join(M1B_DATA, 'assets');
export const HISTORY = path.join(M1B_DATA, 'history');
export const SANDBOX = path.join(M1B_DATA, 'sandbox');
export const GUARD_LOG = path.join(M1B_DATA, 'net-guard.log');
export const ARTIFACT_DIR = path.join(REPO_ROOT, 'docs', 'reports', 'artifacts', 'M1-B');

export const MOCK_PORT = 4010;
export const BACKEND_PORT = 3001;
export const STUDIO_PORT = 5173;
export const TEMPLATE_PORT = 5174;

export const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
export const BACKEND_BASE = `http://127.0.0.1:${BACKEND_PORT}`;
export const STUDIO_URL = `http://127.0.0.1:${STUDIO_PORT}/`;
export const PREVIEW_PATH = '/preview/main/';

/** 主后端写入的作品根：真实模板目录（这样写回才能被 Vite HMR 反映到网页）。 */
export const WORK_ROOT = path.join(REPO_ROOT, 'templates', 'product-page');
export const SCENE_CONFIG = path.join(WORK_ROOT, 'src', 'scene.config.json');
export const TEMPLATE_ASSETS = path.join(WORK_ROOT, 'public', 'assets');
export const TEMPLATE_MODEL = path.join(TEMPLATE_ASSETS, 'diffuser-4969889.glb');

export const SPLIT_GLB = path.join(REPO_ROOT, 'fallback', 'lux3d-split-4969889.glb');
export const SINGLE_GLB = path.join(REPO_ROOT, 'fallback', 'lux3d-4969293.glb');

export const SENTINEL_KEY = 'mock-only';

export const SERVER_DIR = path.join(REPO_ROOT, 'apps', 'server');
export const STUDIO_DIR = path.join(REPO_ROOT, 'apps', 'studio');
export const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates', 'product-page');

export const GUARD_SCRIPT = path.join(REPO_ROOT, 'tests', 'e2e', 'm0a', 'no-real-network.cjs');
export const GUARD_SCRIPT_ARG = GUARD_SCRIPT.split(path.sep).join('/');
export const BACKEND_LAUNCHER = path.join(REPO_ROOT, 'tests', 'e2e', 'm1b', 'start-backend.mjs');

export const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
