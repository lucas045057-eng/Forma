import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureFormaIcons } from './generate-icon.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

export function resolveCscPath() {
  const candidates = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('未找到 Windows 内置 C# 编译器 (csc.exe v4.0.30319)');
}

export function getDesktopPaths(rootDir = repoRoot) {
  return {
    rootDir,
    csSourcePath: path.join(rootDir, 'desktop/src/FormaDesktop.cs'),
    binDir: path.join(rootDir, 'desktop/bin'),
    exePath: path.join(rootDir, 'desktop/bin/Forma.exe'),
    icoPath: path.join(rootDir, 'desktop/assets/forma.ico'),
    studioFaviconPath: path.join(rootDir, 'apps/studio/public/favicon.ico'),
    rootLauncherCmd: path.join(rootDir, 'Forma.cmd'),
  };
}

export function buildDesktopClient(rootDir = repoRoot) {
  const paths = getDesktopPaths(rootDir);
  const iconInfo = ensureFormaIcons(rootDir);
  mkdirSync(paths.binDir, { recursive: true });

  const cscPath = resolveCscPath();
  const cscArgs = [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    '/platform:anycpu',
    `/out:${paths.exePath}`,
    `/win32icon:${paths.icoPath}`,
    '/r:System.dll',
    '/r:System.Core.dll',
    '/r:System.Drawing.dll',
    '/r:System.Windows.Forms.dll',
    '/r:System.Net.Http.dll',
    paths.csSourcePath,
  ];

  const res = spawnSync(cscPath, cscArgs, {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  });

  if (res.status !== 0) {
    const detail = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`编译 Forma.exe 失败 (exit=${res.status}):\n${detail}`);
  }

  // Write convenient root launcher Forma.cmd
  const cmdContent = [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    'if not exist "%~dp0desktop\\bin\\Forma.exe" (',
    '  node "%~dp0scripts\\desktop\\cli.mjs" build',
    ')',
    'start "" "%~dp0desktop\\bin\\Forma.exe" %*',
    '',
  ].join('\r\n');
  writeFileSync(paths.rootLauncherCmd, cmdContent, 'utf8');

  const exeStat = statSync(paths.exePath);
  return {
    exePath: paths.exePath,
    icoPath: iconInfo.desktopIcoPath,
    studioFaviconPath: iconInfo.studioFaviconPath,
    rootLauncherCmd: paths.rootLauncherCmd,
    exeBytes: exeStat.size,
  };
}

export function ensureBuilt(rootDir = repoRoot) {
  const paths = getDesktopPaths(rootDir);
  if (!existsSync(paths.exePath) || !existsSync(paths.icoPath) || !existsSync(paths.studioFaviconPath)) {
    return buildDesktopClient(rootDir);
  }
  const srcMtime = statSync(paths.csSourcePath).mtimeMs;
  const exeMtime = statSync(paths.exePath).mtimeMs;
  if (srcMtime > exeMtime) {
    return buildDesktopClient(rootDir);
  }
  return {
    exePath: paths.exePath,
    icoPath: paths.icoPath,
    studioFaviconPath: paths.studioFaviconPath,
    rootLauncherCmd: paths.rootLauncherCmd,
    exeBytes: statSync(paths.exePath).size,
  };
}

export function createDesktopShortcut(rootDir = repoRoot) {
  const info = ensureBuilt(rootDir);
  const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$lnkPath = Join-Path $desktop 'Forma 空间化AI工作台.lnk'
$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($lnkPath)
$sc.TargetPath = ${JSON.stringify(info.exePath)}
$sc.WorkingDirectory = ${JSON.stringify(rootDir)}
$sc.IconLocation = ${JSON.stringify(info.icoPath)}
$sc.Description = 'Forma 空间化 AI 创作工作台 Windows 客户端'
$sc.Save()
Write-Output $lnkPath
`.trim();

  const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  });

  if (res.status !== 0) {
    throw new Error(`创建桌面快捷方式失败: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

export function verifyDesktopClient(rootDir = repoRoot) {
  const info = buildDesktopClient(rootDir);
  const res = spawnSync(info.exePath, ['--self-test'], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 70_000,
    env: {
      ...process.env,
      FORMA_REPO_ROOT: rootDir,
      FORMA_NODE_EXE: process.execPath,
    },
  });

  const stdout = (res.stdout || '').trim();
  const stderr = (res.stderr || '').trim();
  if (res.status !== 0 || !stdout.includes('[FORMA_SELF_TEST_PASS]')) {
    throw new Error(`Forma.exe 自检失败 (exit=${res.status}):\nstdout: ${stdout}\nstderr: ${stderr}`);
  }

  const jsonStart = stdout.indexOf('{');
  const report = jsonStart >= 0 ? JSON.parse(stdout.slice(jsonStart)) : {};
  return { ...info, report, rawOutput: stdout };
}

export function startDesktopClient(extraArgs = [], rootDir = repoRoot) {
  const info = ensureBuilt(rootDir);
  const child = spawn(info.exePath, extraArgs, {
    cwd: rootDir,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      FORMA_REPO_ROOT: rootDir,
      FORMA_NODE_EXE: process.execPath,
    },
  });
  child.unref();
  return { exePath: info.exePath, pid: child.pid };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const subcommand = process.argv[2] || 'start';
  const extraArgs = process.argv.slice(3);

  try {
    if (subcommand === 'build') {
      const built = buildDesktopClient();
      console.log(`[Forma Desktop] 编译完成: ${built.exePath} (${built.exeBytes} bytes)`);
      console.log(`[Forma Desktop] 图标文件: ${built.icoPath}`);
      console.log(`[Forma Desktop] 快捷启动: ${built.rootLauncherCmd}`);
    } else if (subcommand === 'verify') {
      const verified = verifyDesktopClient();
      console.log(`[Forma Desktop] 编译与端到端自检通过: ${verified.exePath}`);
      console.log(`[Forma Desktop] 自检报告: ${JSON.stringify(verified.report)}`);
    } else if (subcommand === 'shortcut') {
      const lnk = createDesktopShortcut();
      console.log(`[Forma Desktop] 已创建桌面快捷方式: ${lnk}`);
    } else if (subcommand === 'start') {
      const started = startDesktopClient(extraArgs);
      console.log(`[Forma Desktop] 已启动 Windows 客户端: ${started.exePath} (PID=${started.pid})`);
    } else {
      console.error(`未知子命令: ${subcommand} (支持: build | start | verify | shortcut)`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('[Forma Desktop Error]', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
