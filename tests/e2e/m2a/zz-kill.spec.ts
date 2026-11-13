import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { pickSelection, previewFetch, resetMock, restoreTemplate, setScript, submitTask, waitFor, waitForTask } from './api';
import { writeArtifactFrom } from './artifact';

/**
 * R6：后端被强杀后，候选预览进程（preview worker）应随之退出。
 * 这条会把后端杀掉，所以文件名排最后（zz-），不让后续用例依赖它还活着。
 */

const countPreviewVite = (): number => {
  try {
    const output = execSync("powershell -NoProfile -Command \"(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'vite.js' -and $_.CommandLine -match 'preview-cache' } | Measure-Object).Count\"", { encoding: 'utf8' });
    return Number(output.trim());
  } catch { return -1; }
};

test('R6：后端被强杀后候选预览进程随之退出', async ({ page }) => {
  const restored = restoreTemplate();
  expect(restored.clean, restored.status).toBe(true);
  await resetMock();
  await setScript([
    [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
    [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
    [{ name: 'finish', args: { summary: 'ok' } }],
  ]);
  const selection = await pickSelection(page);
  const task = await waitForTask((await submitTask('改按钮', selection)).body.id);
  const id = task.candidateId!;
  expect((await previewFetch(`/preview/c/${id}/`)).status).toBe(200);
  const viteBefore = countPreviewVite();

  const list = execSync("powershell -NoProfile -Command \"(Get-NetTCPConnection -State Listen -LocalPort 3001 | Select-Object -First 1 -ExpandProperty OwningProcess)\"", { encoding: 'utf8' });
  const pid = Number(list.trim().split(/\s+/)[0]);
  expect(Number.isFinite(pid) && pid > 0, `没找到后端进程：${list}`).toBe(true);
  execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });

  const gone = await waitFor(() => countPreviewVite() === 0, 30_000, 500).then(() => true).catch(() => false);
  writeArtifactFrom('isolation-r6.json', { pid, viteBefore, viteAfter: countPreviewVite(), gone, candidateId: id });
  expect(gone, '后端被杀后候选预览进程还在').toBe(true);
});
