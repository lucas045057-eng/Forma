import path from 'node:path';

/**
 * M3-C 独立验收套件的共享常量。
 *
 * 端口与模板/Studio/后端路径沿用 M2-A 的约定（同一套 webServer 形状），
 * 但**工作数据、资产、场景历史、证据目录都是 M3-C 自己的一套**：
 * 既不与 M2-A 的历史产物互相污染，也不覆写任何已提交的证据文件。
 */
export {
  AGENT_MOCK, BACKEND_BASE, BACKEND_LAUNCHER, BACKEND_PORT, DEAD_LUX3D, GUARD_SCRIPT_ARG,
  MOCK_BASE, MOCK_KEY, MOCK_MODEL, MOCK_PORT, PREVIEW_PATH, REPO_ROOT, SERVER_DIR, STUDIO_DIR,
  STUDIO_PORT, STUDIO_URL, TEMPLATE_APP, TEMPLATE_DIR, TEMPLATE_PORT, WORK_ROOT,
} from '../m2a/env';

export const M3C_DATA = path.join(process.cwd(), '.data', 'pi-m3c');
export const WORK_DATA = path.join(M3C_DATA, 'work-data');
export const ASSETS = path.join(M3C_DATA, 'assets');
export const SCENE_HISTORY = path.join(M3C_DATA, 'scene-history');
export const GUARD_LOG = path.join(M3C_DATA, 'net-guard.log');

/** 证据根目录：默认写到 docs/reports/artifacts/M3-C/（手工调试）；
 *  正式轮由 tests/e2e/m3c/full-regression.mjs 用 M3C_ARTIFACT_DIR 定向到本轮 run 目录，
 *  这样每轮的结构化中间证据与轮目录同生同灭，不会把下一轮的干净基线弄脏。 */
export const ARTIFACT_DIR = process.env.M3C_ARTIFACT_DIR
  ? path.resolve(process.env.M3C_ARTIFACT_DIR)
  : path.join(process.cwd(), 'docs', 'reports', 'artifacts', 'M3-C');
