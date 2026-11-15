import path from 'node:path';

/** M4 集中验收的共享常量（不改产品，仅测试侧）。 */

export const REPO_ROOT = process.cwd();
export const M4_DATA = path.join(REPO_ROOT, '.data', 'pi-m4');
export const WORK_DATA = path.join(M4_DATA, 'work-data');
export const ASSETS = path.join(M4_DATA, 'assets');
export const SCENE_HISTORY = path.join(M4_DATA, 'scene-history');
export const GUARD_LOG = path.join(M4_DATA, 'net-guard.log');
export const DEMO_RUNS = path.join(REPO_ROOT, '.data', 'demo-runs');

/** 证据根：入口用 M4_ARTIFACT_DIR 定向到本轮 run 目录。 */
export const ARTIFACT_DIR = process.env.M4_ARTIFACT_DIR
  ? path.resolve(process.env.M4_ARTIFACT_DIR)
  : path.join(REPO_ROOT, 'docs', 'reports', 'artifacts', 'M4');

export const MOCK_PORT = 4011;
export const BACKEND_PORT = 3001;
export const STUDIO_PORT = 5173;
export const TEMPLATE_PORT = 5174;

/** Lux3D 必须指向没人监听的 loopback：本次不产生任何真实生成。 */
export const DEAD_LUX3D = 'http://127.0.0.1:4019';

export const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
export const BACKEND_BASE = `http://127.0.0.1:${BACKEND_PORT}`;
export const STUDIO_URL = `http://127.0.0.1:${STUDIO_PORT}/`;
export const PREVIEW_ORIGIN = 'http://127.0.0.1:5175';
export const PREVIEW_PATH = '/preview/main/';

/** 作品目录就是真实模板（采用/回退才会体现在 /preview/main/）。 */
export const WORK_ROOT = path.join(REPO_ROOT, 'templates', 'product-page');
export const TEMPLATE_APP = path.join(WORK_ROOT, 'src', 'App.tsx');
export const TEMPLATE_SCENE_CONFIG = path.join(WORK_ROOT, 'src', 'scene.config.json');

export const MOCK_KEY = 'mock-only';
export const MOCK_MODEL = 'mock-coder';

export const SERVER_DIR = path.join(REPO_ROOT, 'apps', 'server');
export const STUDIO_DIR = path.join(REPO_ROOT, 'apps', 'studio');
export const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates', 'product-page');

export const GUARD_SCRIPT = path.join(REPO_ROOT, 'tests', 'e2e', 'm0a', 'no-real-network.cjs');
export const GUARD_SCRIPT_ARG = GUARD_SCRIPT.split(path.sep).join('/');
export const BACKEND_LAUNCHER = path.join(REPO_ROOT, 'tests', 'e2e', 'm2a', 'start-backend.mjs');
export const AGENT_MOCK = path.join(REPO_ROOT, 'tests', 'e2e', 'm2a', 'agent-mock.mjs');

/** D3 固定备用素材目录（未跟踪，按 preset 哈希核对）。 */
export const FALLBACK_DIR = path.join(REPO_ROOT, 'fallback');

/** D5 演示脚本。 */
export const DEMO_MOCK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'demo', 'mock.mjs');
export const DEMO_SAFETY_TEST = path.join(REPO_ROOT, 'scripts', 'demo', 'safety.test.mjs');
