import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../app.ts';
import { CodingAgent } from '../agent/client.ts';

function agentSpy() { return vi.spyOn(CodingAgent.prototype, 'run'); }
let agent: ReturnType<typeof agentSpy>;
beforeEach(() => {
  agent = vi.spyOn(CodingAgent.prototype, 'run').mockImplementation(async ({ root }) => {
    await writeFile(path.join(root, 'src/components/Button.tsx'), 'export function Button() { return <button>共享修改</button>; }\n');
    return { summary: 'mock shared edit', written: ['src/components/Button.tsx'] };
  });
});
afterEach(() => { agent.mockRestore(); });

it('exposes approvals without exposing private candidates and accepts only raw JSON 0/1', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'spatial-m3-routes-'));
  const workRoot = path.join(directory, 'work');
  await mkdir(path.join(workRoot, 'src/components'), { recursive: true });
  await writeFile(path.join(workRoot, 'src/App.tsx'), "import { Button } from './components/Button';\nexport default () => <><Button/><Button/><Button/></>;\n");
  await writeFile(path.join(workRoot, 'src/components/Button.tsx'), 'export function Button() { return <button>购买</button>; }\n');
  const instance = await createApp({ workRoot, dataDirectory: path.join(directory, 'assets'), workDataDirectory: path.join(directory, 'data'),
    historyDirectory: path.join(directory, 'history'), base: 'http://127.0.0.1:1', key: 'mock-only',
    codingAgentBaseUrl: 'http://127.0.0.1:1', codingAgentApiKey: 'mock-only', codingAgentModel: 'mock-coder' });
  instance.work.previews.start = async id => `/preview/c/${id}/`;
  instance.work.previews.stop = async () => {};
  instance.work.previews.stopAll = async () => {};
  try {
    const baseVersion = (await instance.app.inject('/version')).json().version;
    const created = await instance.app.inject({ method: 'POST', url: '/tasks', payload: { instruction: 'shared', selection: {
      src: 'src/components/Button.tsx:1:1', baseVersion, cid: 'Button', bbox: [0, 0, 1, 1], instances: 1, ancestors: [],
      styles: { display: 'inline-block', position: 'static', color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)',
        fontSize: '16px', fontFamily: 'Arial', fontWeight: '400', lineHeight: '16px', padding: '0px', margin: '0px',
        borderRadius: '0px', width: '10px', height: '10px' },
    } } });
    const taskId = created.json().id;
    await instance.work.idle();
    const listed = await instance.app.inject('/approvals');
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);
    const card = listed.json()[0];
    expect(JSON.stringify(card)).not.toContain(directory);
    expect(card.summary).toBeUndefined();
    expect((await instance.app.inject(`/approvals/${card.id}`)).json().contentDigest).toBe(card.contentDigest);
    expect((await instance.app.inject(`/candidates/${taskId}`)).statusCode).toBe(404);
    expect((await instance.app.inject({ method: 'POST', url: `/candidates/${taskId}/adopt` })).statusCode).toBe(404);
    for (const option of ['0', 0.5, 2, null]) {
      const invalid = await instance.app.inject({ method: 'POST', url: `/approvals/${card.id}`, payload: { option } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe('INVALID_OPTION');
    }
    expect((await instance.app.inject({ method: 'POST', url: `/approvals/${card.id}`, payload: { option: 0, extra: true } })).statusCode).toBe(400);
    const approved = await instance.app.inject({ method: 'POST', url: `/approvals/${card.id}`, payload: { option: 0 } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ approval: { status: 'approved', answer: { option: 0 } }, task: { status: 'done' } });
    expect((await instance.app.inject({ method: 'POST', url: `/approvals/${card.id}`, payload: { option: 0 } })).json()).toEqual(approved.json());
    const opposite = await instance.app.inject({ method: 'POST', url: `/approvals/${card.id}`, payload: { option: 1 } });
    expect(opposite.statusCode).toBe(409);
    expect(opposite.json().error.code).toBe('APPROVAL_ALREADY_ANSWERED');
    const history = (await instance.app.inject('/events/history?since=0')).json().events;
    expect(history.filter((event: { type: string }) => event.type === 'approval.requested')).toHaveLength(1);
    expect(history.filter((event: { type: string }) => event.type === 'approval.resolved')).toHaveLength(1);
    expect(history.filter((event: { type: string }) => event.type === 'candidate.ready')).toHaveLength(1);
  } finally { await instance.app.close(); await rm(directory, { recursive: true, force: true }); }
});
