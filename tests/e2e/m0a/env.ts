import path from 'node:path';

/** M0-A 测试的共享常量：`playwright.m0a.config.ts` 与测试代码都从这里取，避免两处漂移。 */

export const REPO_ROOT = process.cwd();
/** 测试自己起的服务写的数据目录（gitignored），每次运行前清空。 */
export const M0A_DATA = path.join(REPO_ROOT, '.data', 'pi-m0a');
export const PRIMARY_ASSETS = path.join(M0A_DATA, 'assets');
export const GUARD_LOG = path.join(M0A_DATA, 'net-guard.log');
export const ARTIFACT_DIR = path.join(REPO_ROOT, 'docs', 'reports', 'artifacts', 'M0-A');

export const MOCK_PORT = 4010;
export const BACKEND_PORT = 3001;
export const STUDIO_PORT = 5173;
export const TEMPLATE_PORT = 5174;

export const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
export const BACKEND_BASE = `http://127.0.0.1:${BACKEND_PORT}`;
export const STUDIO_URL = `http://127.0.0.1:${STUDIO_PORT}/`;

/** 用真实香薰瓶做 mock 的下载内容，这样整条链路处理的是真模型而不是内置三角形。 */
export const MOCK_FIXTURE = path.join(REPO_ROOT, 'fallback', 'lux3d-4969293.glb');

/** 故意使用的哨兵 key：测试断言它不出现在任何响应/日志/事件里。 */
export const SENTINEL_KEY = 'mock-only';

export const SERVER_DIR = path.join(REPO_ROOT, 'apps', 'server');
export const STUDIO_DIR = path.join(REPO_ROOT, 'apps', 'studio');
export const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates', 'product-page');

export const GUARD_SCRIPT = path.join(REPO_ROOT, 'tests', 'e2e', 'm0a', 'no-real-network.cjs');
/**
 * 给 NODE_OPTIONS 用的 preload 路径。
 * Node 自己的 NODE_OPTIONS 解析会把双引号内的反斜杠当转义字符，Windows 路径会被吃成
 * `E:工作台testse2e...`，所以这里统一换成正斜杠（Node 在 Windows 上照样识别）。
 */
export const GUARD_SCRIPT_ARG = GUARD_SCRIPT.split(path.sep).join('/');
if (/\s/.test(GUARD_SCRIPT_ARG)) throw new Error(`NODE_OPTIONS 的 --require 路径不能含空格：${GUARD_SCRIPT_ARG}`);
export const BACKEND_LAUNCHER = path.join(REPO_ROOT, 'tests', 'e2e', 'm0a', 'start-backend.mjs');
export const STUB_UPSTREAM = path.join(REPO_ROOT, 'tests', 'e2e', 'm0a', 'stub-upstream.mjs');

/** 每次运行一个唯一后缀，避免同一数据目录里旧记录干扰断言。 */
export const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
