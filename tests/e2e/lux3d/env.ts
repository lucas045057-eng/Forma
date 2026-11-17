import path from 'node:path';

/** Lux3D 增量 focused 验收：工作根、端口与隔离数据目录（全部 loopback / fake，无真实云）。 */

export const REPO_ROOT = process.cwd();
export const DATA_ROOT = path.join(REPO_ROOT, '.data', 'pi-lux3d');
export const WORK_DATA = path.join(DATA_ROOT, 'work-data');
export const ASSETS = path.join(DATA_ROOT, 'assets');
export const SCENE_HISTORY = path.join(DATA_ROOT, 'scene-history');
export const FIXTURES = path.join(DATA_ROOT, 'fixtures');
export const GUARD_LOG = path.join(DATA_ROOT, 'net-guard.log');

export const ARTIFACT_DIR = process.env.LUX3D_ARTIFACT_DIR
  ? path.resolve(process.env.LUX3D_ARTIFACT_DIR)
  : path.join(REPO_ROOT, 'docs', 'reports', 'artifacts', 'Lux3D', 'focused');

export const FAKE_PORT = 4019;
export const FAKE_BASE = `http://127.0.0.1:${FAKE_PORT}`;
export const FAKE_KEY = 'pi-fake-lux3d-key';
export const FAKE_OUS_TOKEN = 'pi-fake-ous-token';

export const AGENT_PORT = 4018;
export const AGENT_BASE = `http://127.0.0.1:${AGENT_PORT}`;
export const AGENT_KEY = 'pi-fake-agent-key';
export const AGENT_MODEL = 'pi-fake-coder';

export const BACKEND_PORT = 3001;
export const BACKEND_BASE = `http://127.0.0.1:${BACKEND_PORT}`;
export const STUDIO_PORT = 5173;
export const STUDIO_URL = `http://127.0.0.1:${STUDIO_PORT}/`;
export const TEMPLATE_PORT = 5174;
export const PREVIEW_ORIGIN_PORT = 5175;
export const PREVIEW_ORIGIN = `http://127.0.0.1:${PREVIEW_ORIGIN_PORT}`;

/** 作品根就是模板本身（与 M4 既有验收一致）；测试结束后按 Git 还原，运行期间不得提交模板改动。 */
export const WORK_ROOT = path.join(REPO_ROOT, 'templates', 'product-page');
export const SERVER_DIR = path.join(REPO_ROOT, 'apps', 'server');
export const STUDIO_DIR = path.join(REPO_ROOT, 'apps', 'studio');
export const TEMPLATE_DIR = WORK_ROOT;

export const FROZEN_HEAD = '037eda164ed307b118bb1933231dde327f6e606b';
