import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { checkSchema } from './schema.ts';
import { copyAudited } from './snapshot.ts';
import { writeArtifact, readArtifact } from './artifacts.ts';
import type { CheckContext } from './runner.ts';
const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function context(content?: string) {
  const directory = await mkdtemp(path.join(tmpdir(), 'm3b-schema-')); temporary.push(directory);
  const candidateRoot = path.join(directory, 'candidate');
  await mkdir(path.join(candidateRoot, 'src'), { recursive: true });
  await writeFile(path.join(candidateRoot, 'src/App.tsx'), 'export default () => <main/>');
  if (content !== undefined) await writeFile(path.join(candidateRoot, 'src/scene.config.json'), content);
  const buildRoot = path.join(directory, 'snapshot');
  const snapshot = await copyAudited(candidateRoot, buildRoot);
  const runId = randomUUID().replaceAll('-', '');
  const ctx: CheckContext = { candidateRoot, buildRoot, snapshot, runId, artifactsDir: directory,
    signal: new AbortController().signal, buildTimeoutMs: 120000, browserTimeoutMs: 30000,
    writeArtifact: (name, data) => writeArtifact(directory, runId, name, data) };
  return ctx;
}
const configFile = fileURLToPath(new URL('../../../../templates/product-page/src/scene.config.json', import.meta.url));
it('schema passes with the persisted artifact hash rather than the input hash', async () => {
  const ctx = await context(await readFile(configFile, 'utf8'));
  const result = await checkSchema(ctx);
  const artifact = await readArtifact(ctx.artifactsDir, ctx.runId, 'schema.json');
  expect(result.status).toBe('passed'); expect(result.evidence).toBe(artifact.ref.hash);
  expect(JSON.parse(artifact.buffer.toString()).configHash).not.toBe(result.evidence);
});
it.each([
  { label: 'missing', content: undefined, reason: /缺失/ },
  { label: 'malformed JSON', content: '{TEST_ONLY_INVALID_INPUT', reason: /有效 JSON/ },
  { label: 'schema violation', content: '{"model":"/assets/test.glb"}', reason: /Schema/ },
])('fails schema on $label', async ({ content, reason }) => {
  const ctx = await context(content); const result = await checkSchema(ctx);
  expect(result.status).toBe('failed'); expect(result.message).toMatch(reason);
  const { buffer } = await readArtifact(ctx.artifactsDir, ctx.runId, 'schema.json');
  expect(buffer.toString()).not.toContain('TEST_ONLY_INVALID_INPUT');
});
it('rejects duplicate keyframes even when the JSON schema accepts them', async () => {
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.scroll[1].at = config.scroll[0].at;
  const result = await checkSchema(await context(JSON.stringify(config)));
  expect(result.status).toBe('failed'); expect(result.message).toContain('严格递增');
});

