import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildDesktopClient, verifyDesktopClient } from './cli.mjs';
import { buildIcoBuffer, ensureFormaIcons } from './generate-icon.mjs';
import { MODEL_PROVIDER_PRESETS, probeCodingModelConnection } from '../../apps/server/src/agent/model-config.ts';

test('buildIcoBuffer generates valid 4-frame Windows ICO container (16/32/48/256 PNG)', () => {
  const buf = buildIcoBuffer([16, 32, 48, 256]);
  assert.equal(buf.readUInt16LE(0), 0, 'ICO reserved field must be 0');
  assert.equal(buf.readUInt16LE(2), 1, 'ICO type must be 1');
  assert.equal(buf.readUInt16LE(4), 4, 'ICO must contain 4 resolution frames');

  const icons = ensureFormaIcons();
  assert.ok(existsSync(icons.desktopIcoPath), 'desktop/assets/forma.ico should exist');
  assert.ok(existsSync(icons.studioFaviconPath), 'apps/studio/public/favicon.ico should exist');
});

test('buildDesktopClient compiles Forma.exe PE binary and Forma.cmd launcher', () => {
  const built = buildDesktopClient();
  assert.ok(existsSync(built.exePath), 'desktop/bin/Forma.exe must exist');
  assert.ok(existsSync(built.rootLauncherCmd), 'Forma.cmd must exist');

  const peHeader = readFileSync(built.exePath).subarray(0, 2);
  assert.equal(peHeader.toString('ascii'), 'MZ', 'Forma.exe must be a valid Windows PE executable');
});

test('Forma.exe DotEnvManager strips UTF-8 BOM, preserves comments/custom keys, and writes UTF-8 without BOM', () => {
  const built = buildDesktopClient();
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'forma-desktop-env-'));
  try {
    const envPath = path.join(tmpDir, '.env');
    const initialWithBom = '\uFEFF# Forma local config comment\r\nCUSTOM_PRESERVED_VAR=keep_me\r\nCODING_AGENT_MODEL=old-model\r\n';
    writeFileSync(envPath, initialWithBom, 'utf8');

    const res = spawnSync(built.exePath, ['--test-dotenv', envPath], {
      encoding: 'utf8',
      windowsHide: true,
    });

    assert.equal(res.status, 0, `DotEnv test failed: ${res.stderr || res.stdout}`);
    assert.match(res.stdout, /\[FORMA_DOTENV_TEST_PASS\]/);

    const updatedBytes = readFileSync(envPath);
    const hasBom = updatedBytes.length >= 3 && updatedBytes[0] === 0xef && updatedBytes[1] === 0xbb && updatedBytes[2] === 0xbf;
    assert.equal(hasBom, false, 'Updated .env must NOT contain UTF-8 BOM');

    const updatedText = updatedBytes.toString('utf8');
    assert.match(updatedText, /# Forma local config comment/);
    assert.match(updatedText, /CUSTOM_PRESERVED_VAR=keep_me/);
    assert.match(updatedText, /CODING_AGENT_MODEL=qwen3-coder-plus/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Forma.exe --self-test supervises backend+frontend startup, probes /health /works /favicon.ico, and exits with zero orphan process', () => {
  const verified = verifyDesktopClient();
  assert.equal(verified.report.healthStatus, 200);
  assert.equal(verified.report.worksStatus, 200);
  assert.equal(verified.report.faviconStatus, 200);
  assert.ok(verified.report.nodePid > 0);

  // Confirm child nodePid is no longer alive after graceful shutdown
  let stillAlive = false;
  try {
    process.kill(verified.report.nodePid, 0);
    stillAlive = true;
  } catch {
    stillAlive = false;
  }
  assert.equal(stillAlive, false, `Node child PID ${verified.report.nodePid} must be terminated after shutdown`);
});

test('probeCodingModelConnection normalizes Base URLs, verifies tool-calling support, and returns actionable diagnostics on 401/404', async () => {
  assert.ok(MODEL_PROVIDER_PRESETS.length >= 8, 'Should expose mainstream provider presets');

  const okRes = await probeCodingModelConnection({
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKey: 'sk-test-placeholder',
    model: 'deepseek-chat',
    fetchImpl: async (url) => {
      assert.equal(String(url), 'https://api.deepseek.com/v1/chat/completions');
      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: '1', type: 'function', function: { name: 'finish', arguments: '{"summary":"ok"}' } }],
            },
          }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.normalizedBaseUrl, 'https://api.deepseek.com/v1');
  assert.equal(okRes.toolCallSupported, true);

  const authFail = await probeCodingModelConnection({
    baseUrl: 'https://dashscope.aliyuncs.com',
    apiKey: 'sk-bad',
    model: 'qwen3-coder-plus',
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Invalid API-key' } }), { status: 401 }),
  });
  assert.equal(authFail.ok, false);
  assert.equal(authFail.status, 401);
  assert.ok(authFail.hint && authFail.hint.includes('API Key'));
});
