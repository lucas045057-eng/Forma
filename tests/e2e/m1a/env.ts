import path from 'node:path';

/** M1-A 测试的共享常量：`playwright.m1a.config.ts` 与测试代码都从这里取。 */

export const REPO_ROOT = process.cwd();
/** 测试自己起的后端写的数据目录（gitignored），每次运行前清空。 */
export const M1A_DATA = path.join(REPO_ROOT, '.data', 'pi-m1a');
export const ASSETS = path.join(M1A_DATA, 'assets');
export const GUARD_LOG = path.join(M1A_DATA, 'net-guard.log');
export const ARTIFACT_DIR = path.join(REPO_ROOT, 'docs', 'reports', 'artifacts', 'M1-A');

export const MOCK_PORT = 4010;
export const BACKEND_PORT = 3001;
export const STUDIO_PORT = 5173;
export const TEMPLATE_PORT = 5174;

export const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
export const BACKEND_BASE = `http://127.0.0.1:${BACKEND_PORT}`;
export const STUDIO_URL = `http://127.0.0.1:${STUDIO_PORT}/`;
/** 作品页：预览分源后由独立预览源 5175 提供（Studio 不再代理 /preview/*）。 */
export const PREVIEW_ORIGIN = 'http://127.0.0.1:5175';
export const PREVIEW_PATH = `${PREVIEW_ORIGIN}/preview/main/`;

/** mock 供的下载内容：M1-A 的默认拆分模型，处理后应等于作品页里提交的那一份。 */
export const SPLIT_GLB = path.join(REPO_ROOT, 'fallback', 'lux3d-split-4969889.glb');
/** 单 mesh 模型：用于验证「无法识别部件」不崩。 */
export const SINGLE_GLB = path.join(REPO_ROOT, 'fallback', 'lux3d-4969293.glb');

export const SENTINEL_KEY = 'mock-only';

export const SERVER_DIR = path.join(REPO_ROOT, 'apps', 'server');
export const STUDIO_DIR = path.join(REPO_ROOT, 'apps', 'studio');
export const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates', 'product-page');
export const TEMPLATE_CONFIG = path.join(TEMPLATE_DIR, 'src', 'scene.config.json');
export const TEMPLATE_PARTS = path.join(TEMPLATE_DIR, 'public', 'assets', 'parts.json');
export const TEMPLATE_MODEL = path.join(TEMPLATE_DIR, 'public', 'assets', 'diffuser-4969889.glb');

export const GUARD_SCRIPT = path.join(REPO_ROOT, 'tests', 'e2e', 'm0a', 'no-real-network.cjs');
export const GUARD_SCRIPT_ARG = GUARD_SCRIPT.split(path.sep).join('/');
export const BACKEND_LAUNCHER = path.join(REPO_ROOT, 'tests', 'e2e', 'm0a', 'start-backend.mjs');

export const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
