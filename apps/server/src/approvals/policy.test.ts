import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Selection } from '@spatial/shared';
import { expect, it } from 'vitest';
import { WorkRepo } from '../work/repo.ts';
import { evaluateApproval } from './policy.ts';

async function fixture(files: Record<string, string> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'spatial-m3-policy-'));
  const workRoot = path.join(directory, 'work');
  await mkdir(path.join(workRoot, 'src', 'components'), { recursive: true });
  const initial: Record<string, string> = {
    'src/App.tsx': "import { Button } from './components/Button';\nexport default function App() { return <><Button/><Button/><Button/></>; }\n",
    'src/components/Button.tsx': 'export function Button() { return <button>购买</button>; }\n',
    ...files,
  };
  for (const [file, content] of Object.entries(initial)) {
    await mkdir(path.dirname(path.join(workRoot, file)), { recursive: true });
    await writeFile(path.join(workRoot, file), content);
  }
  const repo = new WorkRepo({ workRoot, dataDirectory: path.join(directory, 'data') });
  await repo.init();
  const baseVersion = await repo.head();
  await repo.createCandidate('policy1', baseVersion);
  return { directory, root: repo.candidatePath('policy1'), repo, baseVersion };
}

function selection(baseVersion: string, src = 'src/components/Button.tsx:1:1', instances = 1): Selection {
  return { src, baseVersion, cid: 'Button', bbox: [0, 0, 10, 10], styles: {} as Selection['styles'], instances, ancestors: [] };
}

async function evaluate(f: Awaited<ReturnType<typeof fixture>>, file: string, content: string, selected?: Selection) {
  await mkdir(path.dirname(path.join(f.root, file)), { recursive: true });
  await writeFile(path.join(f.root, file), content);
  return evaluateApproval({ root: f.root, baseVersion: f.baseVersion, changedFiles: [file], selection: selected });
}

it('detects three same-file Button JSX uses despite one import and instances=1', async () => {
  const f = await fixture();
  try {
    const result = await evaluate(f, 'src/components/Button.tsx', 'export function Button() { return <button>立即购买</button>; }\n', selection(f.baseVersion));
    expect(result.ruleCodes).toContain('shared_component');
    const locations = result.affected.filter(file => file.startsWith('src/App.tsx:'));
    expect(locations).toHaveLength(3);
    expect(locations.every(file => file.startsWith('src/App.tsx:2:'))).toBe(true);
    expect(result.evidence.join('\n')).toContain('3');
    expect(JSON.stringify(result)).not.toContain(f.directory);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it('resolves imported aliases when counting shared JSX uses', async () => {
  const f = await fixture({ 'src/App.tsx': "import { Button as Action } from './components/Button';\nexport default () => <><Action/><Action/></>;\n" });
  try {
    const result = await evaluate(f, 'src/components/Button.tsx', 'export function Button() { return <button>新样式</button>; }\n', selection(f.baseVersion));
    expect(result.ruleCodes).toContain('shared_component');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it('resolves default exports and named re-export barrels', async () => {
  const f = await fixture({
    'src/App.tsx': "import Action from './components';\nexport default () => <><Action/><Action/></>;\n",
    'src/components/index.ts': "export { default } from './Button';\n",
    'src/components/Button.tsx': 'export default function Button() { return <button>购买</button>; }\n',
  });
  try {
    const result = await evaluate(f, 'src/components/Button.tsx', 'export default function Button() { return <button>立即购买</button>; }\n', selection(f.baseVersion));
    expect(result.ruleCodes).toContain('shared_component');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it('does not label an App-only copy edit as a shared Button edit', async () => {
  const f = await fixture();
  try {
    const result = await evaluate(f, 'src/App.tsx', "import { Button } from './components/Button';\nexport default function App() { return <><Button/><Button/><Button/><p>新文案</p></>; }\n", selection(f.baseVersion, 'src/App.tsx:3:1'));
    expect(result.required).toBe(false);
    expect(result.ruleCodes).toEqual([]);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it('uses conservative UI instance evidence only for the changed selected file', async () => {
  const f = await fixture({ 'src/App.tsx': 'export default () => <main/>;\n' });
  try {
    const result = await evaluate(f, 'src/components/Button.tsx', 'export function Button() { return <button>圆角</button>; }\n', selection(f.baseVersion, undefined, 2));
    expect(result.ruleCodes).toContain('shared_component');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it('requires approval for global CSS and scene config, but not module CSS alone', async () => {
  const f = await fixture({ 'src/components/Button.module.css': '.button { color: black; }\n' });
  try {
    const global = await evaluate(f, 'src/style.css', 'button { border-radius: 8px; }\n', selection(f.baseVersion, 'src/style.css:1:1'));
    expect(global.ruleCodes).toContain('global_style');
    const config = await evaluate(f, 'src/scene.config.json', '{}\n', selection(f.baseVersion, 'src/scene.config.json:1:1'));
    expect(config.ruleCodes).toContain('global_style');
    const modular = await evaluate(f, 'src/components/Button.module.css', '.button { color: red; }\n', selection(f.baseVersion, 'src/components/Button.module.css:1:1'));
    expect(modular.required).toBe(false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it('requires approval for out-of-scope edits and for every nonempty edit without selection', async () => {
  const f = await fixture();
  try {
    const outside = await evaluate(f, 'src/App.tsx', 'export default () => <p>范围外</p>;\n', selection(f.baseVersion));
    expect(outside.ruleCodes).toContain('out_of_scope');
    expect(outside.ruleCodes).not.toContain('shared_component');
    const unknown = await evaluate(f, 'src/App.tsx', 'export default () => <p>未知范围</p>;\n');
    expect(unknown.ruleCodes).toContain('out_of_scope');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it('does not turn baseline read failures into a new-file pass', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'src/components/Button.tsx'), 'export function Button() { return <button>新样式</button>; }\n');
    const result = await evaluateApproval({ root: f.root, baseVersion: '0'.repeat(40), changedFiles: ['src/components/Button.tsx'], selection: selection(f.baseVersion) });
    expect(result.ruleCodes).toContain('shared_component');
    expect(result.ruleCodes).toContain('analysis_uncertain');
    expect(result.evidence.join('\n')).toContain('无法读取基线版本库');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it('treats a genuinely new file in a valid baseline as absent without uncertainty', async () => {
  const f = await fixture();
  try {
    const result = await evaluate(f, 'src/components/New.ts', 'export const value = 1;\n', selection(f.baseVersion, 'src/components/New.ts:1:1'));
    expect(result.required).toBe(false);
    expect(result.ruleCodes).not.toContain('analysis_uncertain');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it('keeps baseline shared evidence when the draft cannot be parsed', async () => {
  const f = await fixture();
  try {
    const result = await evaluate(f, 'src/components/Button.tsx', 'export function Button( {\n', selection(f.baseVersion));
    expect(result.ruleCodes).toContain('shared_component');
    expect(result.affected.filter(file => file.startsWith('src/App.tsx:'))).toHaveLength(3);
    expect(result.ruleCodes).toContain('analysis_uncertain');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it('fails closed on parse errors and dynamic imports', async () => {
  const f = await fixture({ 'src/App.tsx': "export default async () => <>{await import('./components/Button')}</>;\n" });
  try {
    const dynamic = await evaluate(f, 'src/components/Button.tsx', 'export function Button() { return <button/>; }\n', selection(f.baseVersion));
    expect(dynamic.ruleCodes).toContain('analysis_uncertain');
    const invalid = await evaluate(f, 'src/components/Button.tsx', 'export function Button( {\n', selection(f.baseVersion));
    expect(invalid.ruleCodes).toContain('analysis_uncertain');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
